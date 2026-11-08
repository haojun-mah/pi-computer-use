/**
 * Standalone demo — no Pi, no model, just the engine.
 *
 *   DISPLAY=:0 node examples/demo.mjs [url]
 *
 * Opens a watchable browser and walks it through a few visible actions so you
 * can confirm the ghost cursor, ripples and live view all work on your machine.
 */

import { BrowserSession } from "../src/session.js";

const url =
  process.argv[2] ||
  "data:text/html;charset=utf-8," +
    encodeURIComponent(`
  <!doctype html><meta charset="utf-8">
  <body style="margin:0;font:16px system-ui;background:#0f172a;color:#e2e8f0">
    <div style="max-width:640px;margin:0 auto;padding:56px 28px">
      <h1 style="margin:0 0 8px;font-size:30px;letter-spacing:-.02em">pi-computer-use</h1>
      <p style="color:#94a3b8;margin:0 0 32px">
        Watch the cursor move, ripple, and click — then check your terminal for the live view URL.
      </p>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <button id="a" style="font:15px system-ui;padding:12px 22px;border-radius:9px;border:0;
          background:#3b82f6;color:#fff;cursor:pointer">Primary action</button>
        <button id="b" style="font:15px system-ui;padding:12px 22px;border-radius:9px;
          border:1px solid #334155;background:#1e293b;color:#e2e8f0;cursor:pointer">Secondary</button>
        <input id="t" placeholder="Type here…" style="font:15px system-ui;padding:12px 16px;border-radius:9px;
          border:1px solid #334155;background:#0b1220;color:#e2e8f0;min-width:200px">
      </div>
      <p id="out" style="margin-top:28px;color:#34d399;font-weight:600;min-height:24px"></p>
    </div>
    <script>
      const out = document.getElementById('out');
      document.getElementById('a').onclick = () => out.textContent = '✓ primary clicked';
      document.getElementById('b').onclick = () => out.textContent = '✓ secondary clicked';
      document.getElementById('t').oninput = (e) => out.textContent = 'typed: ' + e.target.value;
    </script>
  </body>`);

const session = new BrowserSession({ liveViewPort: Number(process.env.PI_CU_PORT || 7799) });

const note = (s) => console.log(`  ${s}`);

try {
  await session.ensure();
  await session.navigate(url);
  note(`opened ${url.slice(0, 48)}…`);

  const snap = await session.snapshot();
  note(`snapshot: ${snap.elements.length} interactive elements`);

  const primary = snap.elements.find((e) => /primary/i.test(e.label));
  if (primary) {
    const r = await session.click(primary.ref, { label: "primary action" });
    note(r.action);
  }

  const field = snap.elements.find((e) => e.tag === "input");
  if (field) {
    await session.type(field.ref, "hello from pi-computer-use");
    note("typed into the input");
  }

  const info = session.info();
  console.log("\nBrowser is up.");
  if (info.liveView) {
    console.log(`  Live view: ${info.liveView}`);
    console.log(`  Over SSH:  ssh -L ${session.opts.liveViewPort}:127.0.0.1:${session.opts.liveViewPort} <user>@<host>`);
  }
  console.log(`  Display:   ${info.display ?? "headless"}`);
  console.log(`  Cursor:    ${info.cursor.x},${info.cursor.y}`);
  console.log(`  OS pointer ${info.osPointer ? "on" : "off"}\n`);
  console.log("Ctrl+C to close.\n");

  process.on("SIGINT", async () => {
    await session.close().catch(() => {});
    process.exit(0);
  });
  await new Promise(() => {});
} catch (err) {
  console.error(`\nFailed: ${err.message}\n`);
  console.error("Run `npx pi-computer-use doctor` to see what is missing.\n");
  await session.close().catch(() => {});
  process.exit(1);
}
