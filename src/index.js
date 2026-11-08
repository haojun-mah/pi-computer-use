/**
 * pi-computer-use — a Pi extension that lets the model drive a browser a human
 * can actually watch.
 *
 * Two things make this different from driving a headless session:
 *
 * 1. The browser is visible — headed Chromium with a ghost cursor drawn into the
 *    page, plus a live view you can open in your own browser.
 * 2. The browser is *persistent* — it runs in a detached daemon, not inside the
 *    Pi process. Turns ending, sessions ending, and terminals closing all leave
 *    it running. A browsing task is one continuous session, not a series of
 *    launches.
 */

import { DaemonClient } from "./daemon.js";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

/**
 * One client per Pi process, talking to a daemon that outlives us.
 *
 * Note what is deliberately absent: any shutdown hook. Pi exiting must not close
 * the browser — that is the whole point. `browser_close` is the only thing that
 * ends a session, and it is not part of the normal flow.
 */
const daemon = new DaemonClient();

function text(s) {
  return { type: "text", text: s };
}

function fail(message) {
  return { content: [text(`Error: ${message}`)], details: { ok: false, error: message }, isError: true };
}

function ok(payload, summary) {
  return { content: [text(summary)], details: payload };
}

/** Accept "3" as well as 3, since models often stringify refs. */
function targetOf(t) {
  if (typeof t === "string" && /^\d+$/.test(t.trim())) return Number(t.trim());
  return t;
}

function openUrl(url) {
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

const TARGET_SCHEMA = {
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
};

export default function piComputerUse(pi) {
  /* --------------------------------------------------------------- command -- */

  pi.registerCommand("browser", {
    description: "Report the browser's status, live view URL, and daemon pid",
    handler: async (args, ctx) => {
      const ping = await daemon.ping();
      if (!ping) {
        ctx.ui.notify("No browser daemon running — call browser_open to start one.", "warning");
        return;
      }
      const info = ping.info;
      if (!info.running) {
        ctx.ui.notify(`Daemon up (pid ${ping.pid}) but no page open yet. Call browser_open.`, "info");
        return;
      }
      const url = info.liveView;
      const opened = args?.includes("--open") && url ? openUrl(url) : false;
      ctx.ui.notify(
        `${url ?? "(no live view)"}${opened ? " (opened locally)" : ""}\n` +
          `display: ${info.display ?? "none"} · ${info.actions} actions · ${info.url ?? "blank"}\n` +
          `daemon: pid ${ping.pid} · survives this session\n` +
          `over SSH: ssh -L 7799:127.0.0.1:7799 <this-host>`,
        "info",
      );
    },
  });

  /* ----------------------------------------------------------------- tools -- */

  pi.registerTool({
    name: "browser_open",
    label: "Open browser",
    description:
      "Start the visible browser (headed Chromium, ghost cursor, live view) and load a URL. " +
      "The browser is long-lived: it stays open across turns and sessions until you explicitly " +
      "call browser_close. Call this once at the start of a task, not once per step.",
    promptSnippet: "Open the persistent visible browser and load a URL",
    promptGuidelines: [
      "Call browser_open once at the start of a browsing task. The browser persists across turns — never reopen it between steps.",
      "browser_open returns a liveView URL; tell the user that URL, and over SSH the command `ssh -L 7799:127.0.0.1:7799 <host>`.",
      "Do not call browser_close when a task ends or a step finishes; leave the browser open so the user can see the result and continue later.",
    ],
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL or search query to open" },
        headless: { type: "boolean", description: "Force headless. Default false so a human can watch." },
        osPointer: { type: "boolean", description: "Also move the real OS cursor via XTest." },
        width: { type: "number", description: "Viewport width, default 1280" },
        height: { type: "number", description: "Viewport height, default 800" },
      },
      required: ["url"],
    },
    async execute(_id, params) {
      try {
        const res = await daemon.call("open", { url: params.url });
        const info = res.info;
        const lines = [res.action];
        if (info?.liveView) {
          lines.push(`Live view: ${info.liveView}`);
          lines.push("Remote? Forward the port: ssh -L 7799:127.0.0.1:7799 <user>@<host>");
        }
        if (!info?.display) lines.push("Running headless — no window to watch.");
        lines.push("The browser stays open across turns until browser_close.");
        return { content: [text(lines.join("\n"))], details: info };
      } catch (err) {
        return fail(err.message ?? String(err));
      }
    },
  });

  pi.registerTool({
    name: "browser_act",
    label: "Act",
    description:
      "Run several browser actions in one call, in order, in the live page. Use this instead of " +
      "chaining individual browser_click / browser_type calls so a whole sequence happens in one " +
      "visible burst rather than one model round-trip per click.",
    promptSnippet: "Run a sequence of browser actions in one visible burst",
    promptGuidelines: [
      "Prefer browser_act over repeated single-action calls: pass every step of a sequence at once so the browser moves continuously instead of pausing for a round-trip between clicks.",
      "Re-snapshot after browser_act before assuming the page state; the steps may have navigated.",
    ],
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: "Ordered actions to perform",
          items: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["click", "type", "press", "scroll", "navigate", "wait"],
              },
              target: TARGET_SCHEMA,
              text: { type: "string", description: "For action=type" },
              key: { type: "string", description: "For action=press" },
              url: { type: "string", description: "For action=navigate" },
              direction: { type: "string", enum: ["up", "down", "left", "right"] },
              amount: { type: "number", description: "Scroll pixels" },
              ms: { type: "number", description: "For action=wait" },
              clear: { type: "boolean", description: "For action=type" },
              submit: { type: "boolean", description: "For action=type" },
              label: { type: "string", description: "Cursor label" },
              double: { type: "boolean", description: "For action=click" },
            },
            required: ["action"],
          },
        },
        stopOnError: { type: "boolean", description: "Abort the sequence on the first failure" },
      },
      required: ["steps"],
    },
    async execute(_id, params) {
      try {
        const steps = (params.steps ?? []).map((s) => ({ ...s, target: s.target === undefined ? undefined : targetOf(s.target) }));
        const res = await daemon.call("act", { steps, stopOnError: params.stopOnError });
        const lines = res.steps.map((s, i) => `${i + 1}. ${s.ok ? "ok" : "FAILED"} ${s.action} — ${s.summary}`);
        return ok(res, lines.join("\n") || "No steps.");
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
        const snap = await daemon.call("snapshot", { maxElements: params.maxElements ?? 90 });
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
      "For a sequence of clicks, use browser_act instead so the browser is not paused between them.",
    ],
    parameters: {
      type: "object",
      properties: {
        target: TARGET_SCHEMA,
        label: { type: "string", description: "Text to show next to the cursor" },
        double: { type: "boolean", description: "Double-click" },
      },
      required: ["target"],
    },
    async execute(_id, params) {
      try {
        const res = await daemon.call("click", { target: targetOf(params.target), label: params.label, double: params.double });
        return ok(res, res.action);
      } catch (err) {
        return fail(err.message ?? String(err));
      }
    },
  });

  pi.registerTool({
    name: "browser_type",
    label: "Type",
    description: "Focus a field with a visible cursor move, then type at a human cadence.",
    promptSnippet: "Type into a field with a visible cursor",
    parameters: {
      type: "object",
      properties: {
        target: TARGET_SCHEMA,
        text: { type: "string", description: "Text to type" },
        clear: { type: "boolean", description: "Select-all and delete first" },
        submit: { type: "boolean", description: "Press Enter afterwards" },
      },
      required: ["target", "text"],
    },
    async execute(_id, params) {
      try {
        const res = await daemon.call("type", {
          target: targetOf(params.target),
          text: params.text,
          clear: params.clear,
          submit: params.submit,
        });
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
        const res = await daemon.call("press", { key: params.key });
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
        direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Default down" },
        amount: { type: "number", description: "Pixels, default 600" },
        target: { ...TARGET_SCHEMA, description: "Optional element to move the cursor to first" },
      },
    },
    async execute(_id, params) {
      try {
        const res = await daemon.call("scroll", {
          direction: params.direction ?? "down",
          amount: params.amount ?? 600,
          target: params.target === undefined ? undefined : targetOf(params.target),
        });
        return ok(res, res.action);
      } catch (err) {
        return fail(err.message ?? String(err));
      }
    },
  });

  pi.registerTool({
    name: "browser_screenshot",
    label: "Screenshot",
    description: "Capture the current browser view as a PNG image you can look at.",
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
        const res = await daemon.call("screenshot", { fullPage: params.fullPage });
        return {
          content: [{ type: "image", data: res.base64, mimeType: "image/png" }],
          details: { bytes: Math.floor((res.base64.length * 3) / 4) },
        };
      } catch (err) {
        return fail(err.message ?? String(err));
      }
    },
  });

  pi.registerTool({
    name: "browser_eval",
    label: "Evaluate JS",
    description: "Evaluate a JavaScript expression or function body inside the page and return its value.",
    promptSnippet: "Evaluate JavaScript in the page",
    parameters: {
      type: "object",
      properties: {
        script: { type: "string", description: "JavaScript expression or function to evaluate in the page" },
      },
      required: ["script"],
    },
    async execute(_id, params) {
      try {
        const res = await daemon.call("eval", { script: params.script });
        return ok(res, `Result: ${JSON.stringify(res.value).slice(0, 600)}`);
      } catch (err) {
        return fail(err.message ?? String(err));
      }
    },
  });

  pi.registerTool({
    name: "browser_close",
    label: "Close browser",
    description:
      "Close the browser and stop the daemon. Only call this when the user explicitly asks to " +
      "close the browser, or the task is completely finished and they no longer want it open.",
    promptSnippet: "Close the persistent browser (rarely — only when explicitly asked)",
    promptGuidelines: [
      "Do not call browser_close to tidy up. Leaving it open is the intended end state: the user can keep watching and the next turn reuses the same page.",
      "Call browser_close only when the user asks you to close the browser or stop watching.",
    ],
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        const ping = await daemon.ping();
        if (!ping) return ok({ ok: true }, "No browser was running.");
        await daemon.stop();
        daemon.socket = null;
        return ok({ ok: true }, "Browser closed.");
      } catch (err) {
        return fail(err.message ?? String(err));
      }
    },
  });
}
