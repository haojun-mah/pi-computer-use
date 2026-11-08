#!/usr/bin/env node
/**
 * pi-computer-use CLI — environment doctor and standalone demo.
 *
 * The extension is the product; this exists so a user can answer "will this
 * even work on my machine?" without starting Pi, and so CI can assert it.
 */

import { existsSync, readdirSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const C = process.stdout.isTTY
  ? { dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", bold: "\x1b[1m", off: "\x1b[0m" }
  : { dim: "", red: "", green: "", yellow: "", bold: "", off: "" };

const mark = (ok) => (ok ? `${C.green}✓${C.off}` : `${C.red}✗${C.off}`);
const warn = () => `${C.yellow}!${C.off}`;

function which(bin) {
  const r = spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function findChromium() {
  const cands = [process.env.PI_CU_CHROMIUM];
  const base = join(homedir(), ".cache", "ms-playwright");
  if (existsSync(base)) {
    for (const d of readdirSync(base).filter((x) => x.startsWith("chromium-")).sort().reverse()) {
      cands.push(join(base, d, "chrome-linux64", "chrome"), join(base, d, "chrome-linux", "chrome"));
    }
  }
  cands.push(
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  );
  return cands.find((p) => p && existsSync(p)) ?? null;
}

function displays() {
  const out = [];
  try {
    for (const f of readdirSync("/tmp/.X11-unix")) {
      if (/^X\d+$/.test(f)) out.push(`:${f.slice(1)}`);
    }
  } catch {}
  return out;
}

function doctor() {
  const rows = [];
  const add = (state, label, detail = "") => rows.push({ state, label, detail });

  add(mark(true), "node", process.version);

  const chromium = findChromium();
  add(chromium ? mark(true) : mark(false), "chromium", chromium || "not found — run `npx playwright install chromium`");

  if (chromium) {
    const v = spawnSync(chromium, ["--version"], { encoding: "utf8" });
    add(mark(true), "chromium version", (v.stdout || "").trim() || "unknown");
  }

  const envDisplay = process.env.DISPLAY;
  const xs = displays();
  const display = envDisplay || xs[0] || null;
  if (display) add(mark(true), "X display", `${display}${envDisplay ? " (from DISPLAY)" : ` (found ${xs.join(", ")})`}`);
  else add(mark(false), "X display", "none — headed mode unavailable; set DISPLAY or run Xvfb");

  const wm = which("xdotool");
  add(wm ? mark(true) : warn(), "window tooling", wm || "no xdotool (optional; only affects OS-level focus)");

  // Text rendering fonts below are a real cause of blank-looking pages.
  const hasFonts = existsSync("/usr/share/fonts") || existsSync("/Library/Fonts");
  add(hasFonts ? mark(true) : warn(), "fonts", hasFonts ? "present" : "none found — pages may render with fallback boxes");

  const cc = which("gcc") || which("cc") || which("clang");
  let osPointer = false;
  let osDetail = "no C compiler";
  if (cc) {
    const libXtst = [
      "/lib/x86_64-linux-gnu/libXtst.so.6",
      "/usr/lib/x86_64-linux-gnu/libXtst.so.6",
      "/usr/lib64/libXtst.so.6",
    ].find((p) => existsSync(p));
    const helper = join(homedir(), ".pi", "agent", "computer-use", "bin", "pi-cu-xtest");
    if (existsSync(helper)) {
      osPointer = true;
      osDetail = "helper already built";
    } else if (libXtst) {
      osPointer = true;
      osDetail = `will build against ${libXtst} on first use`;
    } else {
      osDetail = `${cc} present but libXtst missing`;
    }
  }
  add(osPointer ? mark(true) : warn(), "real OS pointer", `${osPointer ? "" : "unavailable — "}${osDetail}`);

  const port = 7799;
  const busy = spawnSync("sh", ["-c", `command -v ss >/dev/null && ss -ltn 2>/dev/null | grep -q ':${port} '`], {
    encoding: "utf8",
  });
  add(busy.status === 0 ? warn() : mark(true), `live view port ${port}`, busy.status === 0 ? "in use" : "free");

  // Can we actually open a display-backed browser? Cheapest real test.
  if (display && chromium) {
    const probe = spawnSync(
      chromium,
      ["--headless=new", "--no-sandbox", "--disable-gpu", "--dump-dom", "about:blank"],
      { encoding: "utf8", timeout: 25000, env: { ...process.env, DISPLAY: display } },
    );
    add(probe.status === 0 ? mark(true) : mark(false), "chromium smoke test", probe.status === 0 ? "launches" : "failed to launch");
  }

  const w = Math.max(...rows.map((r) => r.label.length));
  console.log(`\n${C.bold}pi-computer-use doctor${C.off}\n`);
  for (const r of rows) {
    console.log(`  ${r.state} ${r.label.padEnd(w)}  ${C.dim}${r.detail}${C.off}`);
  }

  const blocking = rows.filter((r) => r.state.includes("✗")).length;
  console.log(
    `\n${blocking === 0 ? `${C.green}Ready.${C.off}` : `${C.red}${blocking} blocking issue(s).${C.off}`}` +
      ` The in-page ghost cursor works whenever Chromium + a display are present.\n`,
  );
  return blocking === 0 ? 0 : 1;
}

async function demo(argv) {
  const { BrowserSession } = await import("../src/session.js");
  const url = argv[0] || "https://example.com";
  const headless = argv.includes("--headless");
  const port = Number(process.env.PI_CU_PORT || 7799);

  const s = new BrowserSession({ headless, liveViewPort: port, osPointer: !headless });
  console.log(`Opening ${url} …`);
  await s.ensure();
  await s.navigate(url);

  const info = s.info();
  console.log(`\n${C.green}Browser is up.${C.off}`);
  if (info.liveView) {
    console.log(`Live view:  ${C.bold}${info.liveView}${C.off}`);
    console.log(`${C.dim}Over SSH:   ssh -L ${port}:127.0.0.1:${port} <user>@<host>${C.off}`);
  }
  if (info.osPointer) console.log("Real OS cursor: on");
  console.log(`${C.dim}Press Ctrl+C to close.${C.off}\n`);

  const shutdown = async () => {
    await s.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep the process alive; the browser window is the user-facing artifact.
  setInterval(() => {}, 1 << 30).unref();
  await new Promise(() => {});
}

const cmd = process.argv[2];
if (!cmd || cmd === "doctor") {
  process.exit(doctor());
} else if (cmd === "demo") {
  demo(process.argv.slice(3)).catch((err) => {
    console.error(`${C.red}${err.message}${C.off}`);
    process.exit(1);
  });
} else if (cmd === "status" || cmd === "stop") {
  awaitDaemon(cmd);
} else if (cmd === "view") {
  awaitDaemon("view");
} else if (cmd === "--help" || cmd === "-h" || cmd === "help") {
  console.log(`
pi-computer-use — a watchable browser for Pi

Usage:
  pi-computer-use doctor          Check this machine can run it
  pi-computer-use demo [url]      Open a browser with the live view
  pi-computer-use status          Is the persistent browser running?
  pi-computer-use view            Print the live view URL
  pi-computer-use stop            Close the browser and stop the daemon

Environment:
  DISPLAY           X display for headed mode (auto-detected)
  PI_CU_CHROMIUM    Path to a Chrome/Chromium binary
  PI_CU_PORT        Live view port (default 7799)
`);
} else {
  console.error(`Unknown command: ${cmd}. Try: doctor | demo | status | view | stop | help`);
  process.exit(1);
}

/**
 * Daemon control. Kept in the CLI so the browser can be inspected and stopped
 * from a shell, without a Pi session and without a model in the loop.
 */
async function awaitDaemon(what) {
  const { DaemonClient } = await import("../src/daemon.js");
  const client = new DaemonClient({ spawnIfMissing: false });
  const ping = await client.ping();
  if (!ping) {
    console.log("No browser daemon running. Start one with `pi-computer-use demo` or by calling browser_open.");
    process.exit(what === "status" ? 1 : 0);
  }
  if (what === "stop") {
    await client.stop();
    console.log("Browser closed, daemon stopped.");
    return;
  }
  const info = ping.info;
  if (what === "view") {
    console.log(info.liveView ?? "(no live view — browser not open)");
    client.disconnect();
    return;
  }
  console.log(`daemon pid   ${ping.pid}`);
  console.log(`browser      ${info.running ? "open" : "not started"}`);
  console.log(`url          ${info.url ?? "—"}`);
  console.log(`display      ${info.display ?? "headless"}`);
  console.log(`live view    ${info.liveView ?? "—"}`);
  console.log(`actions      ${info.actions}`);
  client.disconnect();
}
