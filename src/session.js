/**
 * BrowserSession — a headed Chromium that a human can watch.
 *
 * Design rules, learned the hard way:
 *  1. Never fake input. All clicks/keys go through `page.mouse`/`page.keyboard`
 *     so `isTrusted` is true and every app behaves normally.
 *  2. The overlay is decoration. If it throws, the page must not notice.
 *  3. Serialize actions. Playwright calls do not enjoy being interleaved, and a
 *     human watching two cursors at once learns nothing.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OVERLAY_SOURCE } from "./overlay.js";
import { LiveView } from "./liveview.js";
import { OsPointer } from "./os-pointer.js";

const CHROMIUM_CANDIDATES = [
  () => process.env.PI_CU_CHROMIUM,
  () => {
    const base = join(homedir(), ".cache", "ms-playwright");
    if (!existsSync(base)) return null;
    const { readdirSync } = require("node:fs");
    const dirs = readdirSync(base).filter((d) => d.startsWith("chromium-")).sort().reverse();
    for (const d of dirs) {
      const p = join(base, d, "chrome-linux64", "chrome");
      if (existsSync(p)) return p;
      const p2 = join(base, d, "chrome-linux", "chrome");
      if (existsSync(p2)) return p2;
    }
    return null;
  },
  () => "/usr/bin/google-chrome",
  () => "/usr/bin/chromium",
  () => "/usr/bin/chromium-browser",
];

async function findChromium() {
  const { readdirSync } = await import("node:fs");
  const base = join(homedir(), ".cache", "ms-playwright");
  const cands = [process.env.PI_CU_CHROMIUM];
  if (existsSync(base)) {
    const dirs = readdirSync(base).filter((d) => d.startsWith("chromium-")).sort().reverse();
    for (const d of dirs) {
      cands.push(join(base, d, "chrome-linux64", "chrome"), join(base, d, "chrome-linux", "chrome"));
    }
  }
  cands.push("/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser");
  return cands.find((p) => p && existsSync(p)) ?? null;
}

function pickDisplay() {
  if (process.env.DISPLAY) return process.env.DISPLAY;
  if (existsSync("/tmp/.X11-unix/X0")) return ":0";
  if (existsSync("/tmp/.X11-unix/X1")) return ":1";
  return null;
}

const DEFAULT_OPTS = {
  headless: false,
  viewport: { width: 1280, height: 800 },
  windowPosition: [80, 60],
  profileDir: join(homedir(), ".pi", "agent", "computer-use", "profile"),
  // Cursor travel is a perceptual cue, not a real-time simulation. 340ms of
  // glide per click, on top of a 120ms pre-click pause, made every click feel
  // sluggish for no gain in legibility: the eye reads a 180ms move just fine.
  cursorSpeedMs: 180,
  clickDelayMs: 45,
  liveViewPort: 7799,
  liveView: true,
  osPointer: false,
  display: null,
};

export class BrowserSession {
  constructor(options = {}) {
    this.opts = { ...DEFAULT_OPTS, ...options };
    this.browser = null;
    this.context = null;
    this.page = null;
    this.display = null;
    this.liveView = null;
    this.osPointer = null;
    this.cursor = { x: 40, y: 40 };
    this.startedAt = null;
    this.lastAction = null;
    this.actionCount = 0;
    this._queue = Promise.resolve();
    this._refSeq = 0;
  }

  get running() {
    return Boolean(this.page && !this.page.isClosed());
  }

  /** All mutations funnel through here so actions never interleave. */
  _serial(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  async ensure() {
    if (this.running) return this.page;
    return this._serial(() => this._launch());
  }

  async _launch() {
    if (this.running) return this.page;
    const { chromium } = await import("playwright-core");

    const executablePath = await findChromium();
    if (!executablePath) {
      throw new Error(
        "No Chromium found. Install one with `npx playwright install chromium`, " +
          "or point PI_CU_CHROMIUM at a Chrome binary.",
      );
    }

    this.display = this.opts.display ?? pickDisplay();
    if (!this.opts.headless && !this.display) {
      throw new Error(
        "Headed mode needs an X display and none was found. " +
          "Set DISPLAY (e.g. DISPLAY=:0) or start Xvfb, or pass headless: true.",
      );
    }

    const env = { ...process.env };
    if (this.display) env.DISPLAY = this.display;

    const [wx, wy] = this.opts.windowPosition;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(this.opts.profileDir, { recursive: true });

    this.browser = await chromium.launch({
      headless: this.opts.headless,
      executablePath,
      env,
      args: [
        `--window-position=${wx},${wy}`,
        `--window-size=${this.opts.viewport.width + 20},${this.opts.viewport.height + 90}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=Translate,MediaRouter",
        "--hide-crash-restore-bubble",
        // Keep rendering honest when the window is not focused.
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
      ],
    });

    // Persistent context keeps logins across Pi sessions.
    this.context = await this.browser.newContext({
      viewport: this.opts.viewport,
      deviceScaleFactor: 1,
      reducedMotion: "no-preference",
    });
    this.context.setDefaultTimeout(15000);

    this.page = await this.context.newPage();
    await this.page.addInitScript({ content: OVERLAY_SOURCE });
    await this.page.goto("about:blank");
    await this.page.evaluate(() => window.__piCursor?.move(40, 40, { duration: 0 })).catch(() => {});

    this.startedAt = Date.now();

    if (this.opts.osPointer) {
      this.osPointer = new OsPointer(this.display, {
        windowPosition: this.opts.windowPosition,
        chromeOffset: { x: 8, y: 82 }, // window chrome above the viewport
      });
      this.osPointer.probe();
    }

    if (this.opts.liveView) {
      this.liveView = new LiveView({
        port: this.opts.liveViewPort,
        session: this,
      });
      await this.liveView.start().catch(() => {});
    }

    return this.page;
  }

  // ---------------------------------------------------------------- cursor ---

  /** Animate the in-page ghost cursor to viewport coordinates. */
  async _moveCursor(x, y, { label = null, duration } = {}) {
    if (!this.page || this.page.isClosed()) return;
    const dur = duration ?? this.opts.cursorSpeedMs;
    try {
      await this.page.evaluate(
        ([px, py, d, lbl]) => {
          const c = window.__piCursor;
          if (!c) return;
          c.setSpeed(d);
          c.move(px, py, { duration: d, label: lbl });
        },
        [x, y, dur, label],
      );
    } catch {
      /* the page navigated mid-flight; harmless */
    }
    this.cursor = { x, y };
    if (this.osPointer) await this.osPointer.moveTo(x, y, dur);
  }

  async _ripple(x, y, icon = "click") {
    if (!this.page || this.page.isClosed()) return;
    await this.page
      .evaluate(
        ([px, py, dbl]) => window.__piCursor?.ripple(px, py, { double: dbl }),
        [x, y, icon === "double"],
      )
      .catch(() => {});
  }

  async _clearOverlay() {
    if (!this.page || this.page.isClosed()) return;
    await this.page.evaluate(() => window.__piCursor?.clear()).catch(() => {});
  }

  // --------------------------------------------------------------- targets ---

  /**
   * Resolve a target to a centre point in viewport coordinates.
   * Accepts: {x,y} | number ref from `snapshot` | CSS selector | Playwright selector.
   */
  async resolveTarget(target) {
    await this.ensure();
    const page = this.page;

    if (target && typeof target === "object" && "x" in target && "y" in target) {
      return { x: Math.round(target.x), y: Math.round(target.y), element: null, desc: `(${target.x}, ${target.y})` };
    }

    let locator;
    let desc;
    const isRef = typeof target === "number";
    if (isRef) {
      locator = page.locator(`[data-pi-ref="${target}"]`).first();
      desc = `ref ${target}`;
    } else if (typeof target === "string" && target.trim()) {
      locator = page.locator(target).first();
      desc = target;
    } else {
      throw new Error("No target given. Pass a ref from `snapshot`, a selector, or {x,y}.");
    }

    // Probe existence directly in the page rather than through the locator.
    // Locator calls auto-wait, so asking one about an element that is not there
    // costs the entire timeout; a querySelector probe costs microseconds. That
    // difference is the whole latency budget when a ref has gone stale.
    const existsNow = () =>
      page
        .evaluate((sel) => Boolean(document.querySelector(sel)), isRef ? `[data-pi-ref="${target}"]` : target)
        .catch(() => false);

    if (!(await existsNow())) {
      if (isRef) {
        // A missing ref is nearly always a re-render, not a missing element:
        // re-tagging is one cheap evaluate and recovers the common case.
        const recovered = await this._retag(target);
        if (!recovered) {
          throw new Error(
            `ref ${target} is gone — the page changed since your last snapshot. ` +
              `Call browser_snapshot again and use a fresh ref.`,
          );
        }
      } else {
        await locator.waitFor({ state: "attached", timeout: 1500 }).catch(() => {});
        if (!(await existsNow())) {
          throw new Error(`no element matched ${JSON.stringify(desc)} on the current page.`);
        }
      }
    }

    await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    const box = await locator.boundingBox();
    if (!box) throw new Error(`Target "${desc}" is not visible (zero bounding box).`);

    const text = (await locator.innerText({ timeout: 1000 }).catch(() => "")) || "";
    return {
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2),
      box,
      element: locator,
      desc: text ? `${desc} "${text.slice(0, 40).replace(/\s+/g, " ")}"` : desc,
    };
  }

  /**
   * Re-apply ref tags without paying for a full snapshot round-trip.
   *
   * Ref numbering is deterministic for an unchanged DOM, so re-tagging is enough
   * to recover a ref after a re-render that kept the same structure. If the
   * document really changed, the caller's retry fails fast with a clear message
   * instead of hanging on a selector.
   */
  async _retag(wantRef) {
    if (!this.page || this.page.isClosed()) return;
    const found = await this.page
      .evaluate(
        ([want, limit]) => {
          const sel = [
            "a[href]",
            "button",
            "input:not([type=hidden])",
            "select",
            "textarea",
            "summary",
            "[role=button]",
            "[role=link]",
            "[role=checkbox]",
            "[role=tab]",
            "[role=menuitem]",
            "[contenteditable=true]",
            "[onclick]",
          ].join(",");
          document.querySelectorAll("[data-pi-ref]").forEach((n) => n.removeAttribute("data-pi-ref"));
          let ref = 0;
          const seen = new Set();
          for (const el of document.querySelectorAll(sel)) {
            if (ref >= limit) break;
            if (seen.has(el)) continue;
            seen.add(el);
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) continue;
            if (r.bottom < -200 || r.top > window.innerHeight + 800) continue;
            const cs = getComputedStyle(el);
            if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") continue;
            ref += 1;
            el.setAttribute("data-pi-ref", String(ref));
            if (ref === want) return true;
          }
          return false;
        },
        [wantRef, 200],
      )
      .catch(() => false);
    return found;
  }

  // ---------------------------------------------------------------- actions ---

  /**
   * Run several actions in one pass, without returning to the caller between them.
   *
   * This is what makes the browser feel driven rather than poked: a navigation, a
   * few clicks and a read can happen in one visible burst instead of one action
   * per model turn. Each step takes the arguments of the tool it mirrors.
   */
  async act(steps, { stopOnError = false } = {}) {
    const results = [];
    await this.ensure();
    for (const step of steps) {
      const { action } = step;
      try {
        let r;
        switch (action) {
          case "click":
            r = await this.click(step.target, { clickCount: step.double ? 2 : 1, label: step.label });
            break;
          case "type":
            r = await this.type(step.target, step.text, { submit: step.submit, clear: step.clear });
            break;
          case "press":
            r = await this.press(step.key);
            break;
          case "scroll":
            r = await this.scroll({ direction: step.direction, amount: step.amount, target: step.target });
            break;
          case "navigate":
            r = await this.navigate(step.url);
            break;
          case "wait":
            await this.page.waitForTimeout(step.ms ?? 500);
            r = this._describe(`waited ${step.ms ?? 500}ms`);
            break;
          case "snapshot":
            r = { action: "snapshot", snapshot: await this.snapshot({ maxElements: step.maxElements, textLimit: step.textLimit }) };
            break;
          default:
            throw new Error(`unknown action ${JSON.stringify(action)}`);
        }
        results.push({ action, ok: true, summary: r.action, ...(r.snapshot ? { snapshot: r.snapshot } : {}) });
      } catch (err) {
        results.push({ action, ok: false, summary: err.message ?? String(err) });
        if (stopOnError) break;
      }
    }
    return results;
  }

  /** Move to a target, pause, then click it for real. */
  async click(target, { button = "left", clickCount = 1, label = null } = {}) {
    return this._serial(async () => {
      await this.ensure();
      const t = await this.resolveTarget(target);
      await this._moveCursor(t.x, t.y, { label: label ?? `click ${shorten(t.desc)}` });
      await this.page.waitForTimeout(this.opts.clickDelayMs);
      await this._ripple(t.x, t.y, clickCount === 2 ? "double" : "click");
      await this.page.mouse.move(t.x, t.y);
      if (clickCount === 2) {
        await this.page.mouse.down({ button, clickCount: 1 });
        await this.page.mouse.up({ button, clickCount: 1 });
        await this.page.mouse.down({ button, clickCount: 2 });
        await this.page.mouse.up({ button, clickCount: 2 });
      } else {
        await this.page.mouse.down({ button });
        await this.page.mouse.up({ button });
      }
      await this.page.waitForTimeout(30);
      await this._pulse();
      return this._describe(`clicked ${t.desc} at ${t.x},${t.y}`);
    });
  }

  async hover(target) {
    return this._serial(async () => {
      await this.ensure();
      const t = await this.resolveTarget(target);
      await this._moveCursor(t.x, t.y, { label: `hover ${shorten(t.desc)}` });
      await this.page.mouse.move(t.x, t.y);
      if (t.element) await t.element.hover({ timeout: 5000 }).catch(() => {});
      await this._pulse();
      return this._describe(`hovered ${t.desc}`);
    });
  }

  /** Focus a field, then type with a real cadence so the human can follow. */
  async type(target, text, { submit = false, clear = false, delay = 18 } = {}) {
    return this._serial(async () => {
      await this.ensure();
      const t = await this.resolveTarget(target);
      await this._moveCursor(t.x, t.y, { label: `type ${shorten(t.desc)}` });
      await this.page.waitForTimeout(this.opts.clickDelayMs);
      await this._ripple(t.x, t.y);
      await this.page.mouse.click(t.x, t.y);
      if (clear) {
        await this.page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
        await this.page.keyboard.press("Backspace");
      }
      await this.page
        .evaluate(
          ([x, y, w]) => window.__piCursor?.typing(x, y - 14, w),
          [t.box ? t.box.x : t.x, t.box ? t.box.y : t.y, t.box ? t.box.width : 160],
        )
        .catch(() => {});
      await this.page.keyboard.type(text, { delay });
      if (submit) {
        await this.page.keyboard.press("Enter");
      }
      await this._pulse();
      return this._describe(`typed ${JSON.stringify(truncate(text, 60))} into ${t.desc}`);
    });
  }

  async press(key, { label = null } = {}) {
    return this._serial(async () => {
      await this.ensure();
      await this._moveCursor(this.cursor.x, this.cursor.y, { label: label ?? `press ${key}` });
      await this.page.keyboard.press(key);
      await this._pulse();
      return this._describe(`pressed ${key}`);
    });
  }

  async scroll({ direction = "down", amount = 600, target = null } = {}) {
    return this._serial(async () => {
      await this.ensure();
      if (target) {
        const t = await this.resolveTarget(target);
        await this._moveCursor(t.x, t.y, { label: `scroll ${direction}` });
      }
      const dx = direction === "left" ? -amount : direction === "right" ? amount : 0;
      const dy = direction === "up" ? -amount : direction === "down" ? amount : 0;
      await this.page.mouse.wheel(dx, dy);
      await this.page.waitForTimeout(160);
      await this._pulse();
      return this._describe(`scrolled ${direction} ${amount}px`);
    });
  }

  async selectOption(target, values) {
    return this._serial(async () => {
      await this.ensure();
      const t = await this.resolveTarget(target);
      await this._moveCursor(t.x, t.y, { label: `select ${shorten(t.desc)}` });
      await this._ripple(t.x, t.y);
      const picked = await t.element.selectOption(values);
      await this._pulse();
      return this._describe(`selected ${JSON.stringify(picked)} in ${t.desc}`);
    });
  }

  async navigate(url, { waitUntil = "domcontentloaded" } = {}) {
    return this._serial(async () => {
      await this.ensure();
      const full = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) ? url : `https://${url}`;
      await this.page
        .evaluate((u) => window.__piCursor?.label(`open ${u}`, 24, 24), full)
        .catch(() => {});
      await this.page.goto(full, { waitUntil, timeout: 30000 });
      await this.page.evaluate(() => window.__piCursor?.move(40, 40, { duration: 0 })).catch(() => {});
      this.cursor = { x: 40, y: 40 };
      await this._pulse();
      this.actionCount += 1;
      return this._describe(`navigated to ${this.page.url()}`);
    });
  }

  async back() {
    return this._serial(async () => {
      await this.ensure();
      await this.page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
      await this._pulse();
      return this._describe(`went back to ${this.page.url()}`);
    });
  }

  async evaluate(fnSource) {
    return this._serial(async () => {
      await this.ensure();
      const value = await this.page.evaluate(fnSource);
      await this._pulse();
      return { ok: true, value };
    });
  }

  // ----------------------------------------------------------------- output ---

  async _pulse() {
    if (this.liveView) this.liveView.pulse(1600);
    this.actionCount += 1;
    this.lastAction = Date.now();
  }

  _describe(action, extra = {}) {
    return {
      ok: true,
      action,
      url: this.page && !this.page.isClosed() ? this.page.url() : null,
      liveView: this.liveView?.url ?? null,
      ...extra,
    };
  }

  async screenshot({ fullPage = false, path = null } = {}) {
    return this._serial(async () => {
      await this.ensure();
      const buf = await this.page.screenshot({ fullPage, type: "png", path: path ?? undefined });
      await this._pulse();
      return buf;
    });
  }

  /**
   * Frame grab for the live view. Deliberately does NOT go through `_serial`:
   * frames must never queue behind a slow page action, and a dropped frame is
   * always better than a stalled stream. `dropIfBusy` separates a best-effort
   * stream tick (drop it) from an explicit caller that wants the frame.
   */
  async screenshotJpeg({ quality = 72, dropIfBusy = false } = {}) {
    if (!this.running) return null;
    if (dropIfBusy && this._frameBusy) return null;
    this._frameBusy = true;
    try {
      return await this.page.screenshot({ type: "jpeg", quality });
    } catch {
      return null;
    } finally {
      this._frameBusy = false;
    }
  }

  /** Input forwarded from the live view's takeover mode. */
  async remoteInput(ev) {
    return this._serial(async () => {
      await this.ensure();
      if (!ev || typeof ev.x !== "number" || typeof ev.y !== "number") return;
      const { x, y } = ev;
      switch (ev.type) {
        case "move":
          await this._moveCursor(x, y, { duration: 140 });
          await this.page.mouse.move(x, y);
          break;
        case "click":
          await this._moveCursor(x, y, { duration: 140 });
          await this._ripple(x, y, ev.clickCount === 2 ? "double" : "click");
          await this.page.mouse.click(x, y, { button: ev.button || "left", clickCount: ev.clickCount || 1 });
          break;
        case "type":
          await this.page.keyboard.type(String(ev.text ?? ""), { delay: 12 });
          break;
        case "key":
          await this.page.keyboard.press(String(ev.key ?? "Enter"));
          break;
        case "scroll":
          await this.page.mouse.wheel(Number(ev.dx ?? 0), Number(ev.dy ?? 0));
          break;
      }
      await this._pulse();
    });
  }

  /**
   * Compact, model-friendly outline of what is on screen. Interactive elements
   * get a stable `data-pi-ref` so the model can act by ref instead of guessing
   * selectors — the same affordance Playwright MCP gets from its snapshot.
   */
  async snapshot({ maxElements = 90, textLimit = 1200 } = {}) {
    await this.ensure();
    const data = await this.page.evaluate(({ limit, textLimit }) => {
      document.querySelectorAll("[data-pi-ref]").forEach((n) => n.removeAttribute("data-pi-ref"));
      const sel = [
        "a[href]",
        "button",
        "input:not([type=hidden])",
        "select",
        "textarea",
        "summary",
        "[role=button]",
        "[role=link]",
        "[role=checkbox]",
        "[role=tab]",
        "[role=menuitem]",
        "[contenteditable=true]",
        "[onclick]",
      ].join(",");

      const items = [];
      let ref = 0;
      const seen = new Set();
      for (const el of document.querySelectorAll(sel)) {
        if (ref >= limit) break;
        if (seen.has(el)) continue;
        seen.add(el);
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        if (r.bottom < -200 || r.top > window.innerHeight + 800) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") continue;

        ref += 1;
        el.setAttribute("data-pi-ref", String(ref));
        const label =
          el.getAttribute("aria-label") ||
          el.getAttribute("placeholder") ||
          el.getAttribute("alt") ||
          (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 70) ||
          el.getAttribute("name") ||
          el.getAttribute("title") ||
          "";
        items.push({
          ref,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || null,
          type: el.getAttribute("type") || null,
          label,
          value: el.value != null && el.tagName !== "BUTTON" ? String(el.value).slice(0, 60) : null,
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
        });
      }

      // Interactive labels already describe what can be done here, so the raw
      // body text is mostly duplication. Keep it short by default: a snapshot is
      // re-sent on every turn, and 2500 chars of nav chrome is pure overhead.
      const textOf = document.body ? document.body.innerText : "";
      return {
        url: location.href,
        title: document.title,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        scroll: { x: Math.round(scrollX), y: Math.round(scrollY) },
        elements: items,
        text: textOf.replace(/\n{3,}/g, "\n\n").slice(0, textLimit),
        textTruncated: textOf.length > textLimit,
      };
    }, { maxElements, textLimit });

    data.cursor = this.cursor;
    return data;
  }

  async close() {
    if (this.liveView) await this.liveView.stop().catch(() => {});
    if (this.osPointer) this.osPointer.close();
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
    this.context = null;
    this.page = null;
    return { ok: true };
  }

  info() {
    return {
      running: this.running,
      url: this.running ? this.page.url() : null,
      display: this.display,
      headless: this.opts.headless,
      viewport: this.opts.viewport,
      liveView: this.liveView?.url ?? null,
      actions: this.actionCount,
      cursor: this.cursor,
      osPointer: Boolean(this.osPointer?.available),
    };
  }
}

function shorten(s, n = 34) {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
