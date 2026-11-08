/**
 * pi-computer-use — a Pi extension that lets the model drive a browser a human
 * can actually watch.
 *
 * The gap this closes: Playwright MCP runs headless, so every click is invisible
 * and the human cannot follow along. Here the browser is headed, the pointer is
 * drawn into the page, and the whole thing streams to a viewer you open locally.
 */

import { BrowserSession } from "./session.js";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

/** One session per Pi process; tool calls share the tab the human is watching. */
let session = null;

function getSession(opts) {
  if (!session) session = new BrowserSession(opts);
  return session;
}

function text(s) {
  return { type: "text", text: s };
}

function fail(message) {
  return { content: [text(`Error: ${message}`)], details: { ok: false, error: message }, isError: true };
}

function ok(payload, summary) {
  return { content: [text(summary)], details: payload };
}

function openUrl(url) {
  // Cross-platform "open in the user's browser". Failure is fine: we print it.
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export default function piComputerUse(pi) {
  pi.on("session_shutdown", async () => {
    if (session) {
      await session.close().catch(() => {});
      session = null;
    }
  });

  // ------------------------------------------------------------- /browser ---

  pi.registerCommand("browser", {
    description: "Open the live view of Pi's browser, or report its status",
    handler: async (args, ctx) => {
      if (!session || !session.running) {
        ctx.ui.notify("No browser session yet — ask Pi to open a page first.", "warning");
        return;
      }
      const url = session.liveView?.url;
      if (!url) {
        ctx.ui.notify("Live view is disabled (headless mode or port unavailable).", "warning");
        return;
      }
      const info = session.info();
      const opened = args?.includes("--open") ? openUrl(url) : false;
      ctx.ui.notify(
        `${url}${opened ? " (opened locally)" : ""}\n` +
          `display: ${info.display ?? "none"} · ${info.actions} actions · ${info.url ?? "blank"}\n` +
          `over SSH:  ssh -L ${session.opts.liveViewPort}:127.0.0.1:${session.opts.liveViewPort} <this-host>`,
        "info",
      );
    },
  });

  // ---------------------------------------------------------------- tools ---

  pi.registerTool({
    name: "browser_open",
    label: "Open browser",
    description:
      "Start a visible, human-watchable browser and load a URL. This is the entry point: " +
      "it launches headed Chromium with a ghost cursor overlay and a live view stream.",
    promptSnippet: "Open a visible browser session (headed Chromium with ghost cursor + live view)",
    promptGuidelines: [
      "Use browser_open before any other browser_* tool; the other tools start the browser implicitly if needed.",
      "browser_open returns a liveView URL — tell the user they can watch at that URL and that over SSH they need `ssh -L <port>:127.0.0.1:<port>`.",
    ],
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL or search query to open" },
        headless: { type: "boolean", description: "Force headless (no window). Default false so a human can watch." },
        osPointer: { type: "boolean", description: "Also move the real OS cursor via XTest. Default false." },
        width: { type: "number", description: "Viewport width, default 1280" },
        height: { type: "number", description: "Viewport height, default 800" },
      },
      required: ["url"],
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const s = getSession({
          headless: params.headless ?? false,
          osPointer: params.osPointer ?? false,
          viewport: {
            width: params.width ?? 1280,
            height: params.height ?? 800,
          },
        });
        await s.ensure();
        const result = await s.navigate(params.url);
        const info = s.info();
        const lines = [result.action];
        if (info.liveView) {
          lines.push(`Live view: ${info.liveView}`);
          lines.push(
            `Remote? Forward the port: ssh -L ${s.opts.liveViewPort}:127.0.0.1:${s.opts.liveViewPort} <user>@<host>`,
          );
        }
        if (info.osPointer) lines.push("Real OS cursor: on");
        if (!info.display) lines.push("Running headless — no window to watch.");
        return { content: [text(lines.join("\n"))], details: info };
      } catch (err) {
        return fail(err.message ?? String(err));
      }
    },
  });

  pi.registerTool({
    name: "browser_snapshot",
    label: "Snapshot page",
    description:
      "Describe the current page: URL, title, visible text, and interactive elements each with a " +
      "numeric ref. Pass those refs to browser_click / browser_type so you never guess selectors.",
    promptSnippet: "Read the current page: text plus interactive elements with numeric refs",
    promptGuidelines: [
      "Prefer browser_snapshot over browser_screenshot to decide what to click — refs are stable and cheap.",
      "Pass the numeric ref from browser_snapshot directly as the target of browser_click or browser_type.",
    ],
    parameters: {
      type: "object",
      properties: {
        maxElements: { type: "number", description: "Cap on interactive elements (default 90)" },
      },
    },
    async execute(_id, params) {
      try {
        const s = getSession();
        await s.ensure();
        const snap = await s.snapshot({ maxElements: params.maxElements ?? 90 });
        const lines = [
          `${snap.title || "(untitled)"} — ${snap.url}`,
          `viewport ${snap.viewport.w}x${snap.viewport.h} · scroll ${snap.scroll.x},${snap.scroll.y}`,
          "",
          "Interactive elements:",
          ...snap.elements.map((e) => {
            const bits = [`[${e.ref}]`, e.tag];
            if (e.role) bits.push(`role=${e.role}`);
            if (e.type) bits.push(`type=${e.type}`);
            if (e.label) bits.push(JSON.stringify(e.label));
            if (e.value) bits.push(`value=${JSON.stringify(e.value)}`);
            bits.push(`@${e.x},${e.y}`);
            return bits.join(" ");
          }),
          "",
          "Text:",
          snap.text || "(empty)",
        ];
        return { content: [text(lines.join("\n"))], details: snap };
      } catch (err) {
        return fail(err.message ?? String(err));
      }
    },
  });

  pi.registerTool({
    name: "browser_click",
    label: "Click",
    description:
      "Move the visible ghost cursor to a target, pause, ripple, then click for real. " +
      "Target: a ref from browser_snapshot, a CSS selector, or {x,y} viewport coordinates.",
    promptSnippet: "Click a page element with a visible cursor animation",
    promptGuidelines: [
      "Target browser_click with a ref from browser_snapshot when possible; use {x,y} only for canvas or unlabelled areas.",
      "After browser_click, run browser_snapshot again before assuming the page changed.",
    ],
    parameters: {
      type: "object",
      properties: {
        target: {
          description: "Ref from browser_snapshot, a CSS selector, or {x,y} viewport coordinates",
          anyOf: [
            { type: "number", description: "Ref from browser_snapshot" },
            { type: "string", description: "CSS selector" },
            {
              type: "object",
              description: "Viewport coordinates",
              properties: { x: { type: "number" }, y: { type: "number" } },
              required: ["x", "y"],
            },
          ],
        },
        label: { type: "string", description: "Text to show next to the cursor" },
        double: { type: "boolean", description: "Double-click" },
      },
      required: ["target"],
    },
    async execute(_id, params) {
      try {
        const s = getSession();
        await s.ensure();
        let target = params.target;
        if (typeof target === "string" && /^\d+$/.test(target.trim())) target = Number(target.trim());
        const res = await s.click(target, { label: params.label, clickCount: params.double ? 2 : 1 });
        return ok(res, res.action);
      } catch (err) {
        return fail(err.message ?? String(err));
      }
    },
  });

  pi.registerTool({
    name: "browser_type",
    label: "Type",
    description:
      "Focus a field with a visible cursor move, then type with a human cadence. " +
      "Set submit to press Enter afterwards.",
    promptSnippet: "Type into a field, visibly, optionally submitting",
    promptGuidelines: [
      "Use browser_type with clear:true when replacing an existing value.",
      "Set submit:true instead of a separate browser_press when the field is a search box or login form.",
    ],
    parameters: {
      type: "object",
      properties: {
        target: {
          description: "Ref from browser_snapshot, a CSS selector, or {x,y} viewport coordinates",
          anyOf: [
            { type: "number", description: "Ref from browser_snapshot" },
            { type: "string", description: "CSS selector" },
            {
              type: "object",
              description: "Viewport coordinates",
              properties: { x: { type: "number" }, y: { type: "number" } },
              required: ["x", "y"],
            },
          ],
        },
        text: { type: "string", description: "Text to type" },
        clear: { type: "boolean", description: "Select-all and delete first" },
        submit: { type: "boolean", description: "Press Enter afterwards" },
      },
      required: ["target", "text"],
    },
    async execute(_id, params) {
      try {
        const s = getSession();
        await s.ensure();
        let target = params.target;
        if (typeof target === "string" && /^\d+$/.test(target.trim())) target = Number(target.trim());
        const res = await s.type(target, params.text, { clear: params.clear, submit: params.submit });
        return ok(res, res.action);
      } catch (err) {
        return fail(err.message ?? String(err));
      }
    },
  });

  pi.registerTool({
    name: "browser_press",
    label: "Press key",
    description: "Press a key or chord, such as Enter, Escape, Tab, or Control+A.",
    promptSnippet: "Press a keyboard key or chord",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Playwright key name, e.g. Enter, Escape, Control+A" },
      },
      required: ["key"],
    },
    async execute(_id, params) {
      try {
        const s = getSession();
        await s.ensure();
        const res = await s.press(params.key);
        return ok(res, res.action);
      } catch (err) {
        return fail(err.message ?? String(err));
      }
    },
  });

  pi.registerTool({
    name: "browser_scroll",
    label: "Scroll",
    description: "Scroll the page, optionally after moving the cursor to a target first.",
    promptSnippet: "Scroll the page with a visible cursor",
    parameters: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["up", "down", "left", "right"],
          description: "Default down",
        },
        amount: { type: "number", description: "Pixels, default 600" },
        target: {
          description: "Optional element to move the cursor to first",
          anyOf: [
            { type: "number" },
            { type: "string" },
            {
              type: "object",
              properties: { x: { type: "number" }, y: { type: "number" } },
              required: ["x", "y"],
            },
          ],
        },
      },
    },
    async execute(_id, params) {
      try {
        const s = getSession();
        await s.ensure();
        let target = params.target ?? null;
        if (typeof target === "string" && /^\d+$/.test(String(target).trim())) target = Number(target);
        const res = await s.scroll({ direction: params.direction ?? "down", amount: params.amount ?? 600, target });
        return ok(res, res.action);
      } catch (err) {
        return fail(err.message ?? String(err));
      }
    },
  });

  pi.registerTool({
    name: "browser_screenshot",
    label: "Screenshot",
    description:
      "Capture the visible page as a PNG so you can see what the human sees, including the ghost cursor.",
    promptSnippet: "Capture the browser as a PNG to visually inspect it",
    promptGuidelines: [
      "Use browser_screenshot when layout, styling, or canvas rendering matters; use browser_snapshot for structure.",
    ],
    parameters: {
      type: "object",
      properties: {
        fullPage: { type: "boolean", description: "Capture the whole scrollable page" },
      },
    },
    async execute(_id, params) {
      try {
        const s = getSession();
        await s.ensure();
        const buf = await s.screenshot({ fullPage: params.fullPage ?? false });
        return {
          content: [
            { type: "image", data: buf.toString("base64"), mimeType: "image/png" },
            text(`${s.page.url()}\n${s.actionCount} actions this session`),
          ],
          details: { ok: true, url: s.page.url() },
        };
      } catch (err) {
        return fail(err.message ?? String(err));
      }
    },
  });

  pi.registerTool({
    name: "browser_eval",
    label: "Evaluate JS",
    description:
      "Run JavaScript in the page and return the result. Use for reading state the snapshot misses.",
    promptSnippet: "Evaluate JavaScript in the page",
    promptGuidelines: [
      "Pass browser_eval a bare function body or expression that evaluates in the page; it cannot access Node.",
    ],
    parameters: {
      type: "object",
      properties: {
        script: { type: "string", description: "JavaScript expression or function to evaluate in the page" },
      },
      required: ["script"],
    },
    async execute(_id, params) {
      try {
        const s = getSession();
        await s.ensure();
        const res = await s.evaluate(params.script);
        return ok(res, `Result: ${JSON.stringify(res.value).slice(0, 600)}`);
      } catch (err) {
        return fail(err.message ?? String(err));
      }
    },
  });

  pi.registerTool({
    name: "browser_close",
    label: "Close browser",
    description: "Close the browser and stop the live view stream.",
    promptSnippet: "Close the browser session",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        if (!session) return ok({ ok: true }, "No browser was running.");
        await session.close();
        session = null;
        return ok({ ok: true }, "Browser closed.");
      } catch (err) {
        return fail(err.message ?? String(err));
      }
    },
  });
}
