/**
 * LiveView — watch Pi's browser from your own browser.
 *
 * The constraint that shaped this: SSH over a plain terminal, no VNC, no root.
 * So we stream the page out over HTTP and let the user's *local* browser be the
 * screen. Server-Sent Events because we only ever push one direction, it costs
 * one endpoint, and any browser can render it.
 *
 * Frames come from CDP's `Page.startScreencast`, which hands back the composited
 * surface including our overlay — verified by capturing a frame with the ghost
 * cursor, its label pill, and a mid-animation ripple in it. Screenshots were the
 * old source: they re-composite and re-encode on a timer whether or not anything
 * moved, so they cost 1.39 browser cores to deliver 11.8 fps, and could not show
 * a 180ms cursor glide at all because the timer, not the page, decided when a
 * frame appeared. The screencast is change-driven, so it delivers ~12 frames
 * during that same glide for 0.75 cores, and 43 fps when uncapped.
 *
 * Polling is kept as a fallback for transports without CDP.
 */

import { createServer } from "node:http";

const CJK = /[\u3000-\u9fff\uff00-\uffef]/;

function friendlyPort(port) {
  return Number(port) || 7799;
}

export class LiveView {
  constructor({ port, session, fps = 12, maxFps = 20 }) {
    this.port = friendlyPort(port);
    this.session = session;
    this.fps = fps;
    this.maxFps = maxFps;
    this.server = null;
    this.clients = new Set();
    this.timer = null;
    this.busy = false;
    this.starting = false;
    this.casting = false;
    this.frameQuality = 60;
    this.framesSent = 0;
    this.frame = null; // last JPEG buffer
    this.lastFrameAt = 0;
    this.pulseUntil = 0;
    this.url = null;
  }

  async start() {
    if (this.server) return this.url;
    // Bind the preferred port, but never fail the browser over a busy one: a
    // second session, or a leftover daemon, must not take the page down with it.
    const candidates = [this.port, ...Array.from({ length: 12 }, (_, i) => this.port + i + 1)];
    let lastErr = null;
    for (const port of candidates) {
      const server = createServer((req, res) => this._route(req, res));
      server.on("clientError", (_e, socket) => socket.destroy());
      try {
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", resolve);
        });
        this.server = server;
        this.port = port;
        this.url = `http://127.0.0.1:${port}/`;
        // Capture is started by the first /stream connection, not here: a
        // session nobody is watching should do no frame work at all.
        return this.url;
      } catch (err) {
        lastErr = err;
        server.close();
      }
    }
    throw new Error(`could not bind a live view port (${candidates[0]}..${candidates.at(-1)}): ${lastErr?.message}`);
  }

  /** Rebind the routes' idea of the port; the URL uses whatever we actually got. */
  get endpoint() {
    return `http://127.0.0.1:${this.port}`;
  }

  pulse(ms = 1600) {
    this.pulseUntil = Date.now() + ms;
    // The screencast already emits on every visual change, so there is nothing
    // to force. Polling needs the nudge to feel responsive — but only when
    // somebody is actually looking, or every action pays for a JPEG nobody sees.
    if (!this.casting && this.clients.size > 0) this._tick(true);
  }

  _route(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);

    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PAGE);
      return;
    }

    if (url.pathname === "/stream") {
      this._stream(req, res);
      return;
    }

    if (url.pathname === "/frame.jpg") {
      if (!this.frame) {
        res.writeHead(204).end();
        return;
      }
      res.writeHead(200, {
        "content-type": "image/jpeg",
        "cache-control": "no-store",
        "content-length": this.frame.length,
      });
      res.end(this.frame);
      return;
    }

    if (url.pathname === "/state") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(
        JSON.stringify({
          ...this.session.info(),
          lastFrameAt: this.lastFrameAt,
          capture: {
            mode: this.casting ? "screencast" : this.clients.size ? "polling" : "idle",
            sent: this.framesSent,
            clients: this.clients.size,
          },
        }),
      );
      return;
    }

    // Click-to-takeover: the viewer can poke the page directly.
    if (url.pathname === "/input" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const ev = JSON.parse(body || "{}");
          await this.session.remoteInput(ev);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(err && err.message) }));
        }
      });
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }

  _stream(req, res) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 1500\n\n");
    const client = { res };
    this.clients.add(client);
    if (this.frame) {
      res.write(`event: frame\ndata: ${this.lastFrameAt}\n\n`);
    }
    // Capture runs only while somebody is watching. Chromium's screencast is
    // change-driven, but it still costs a WebSocket and a compositor surface.
    this._startCapture();
    req.on("close", () => {
      this.clients.delete(client);
      if (this.clients.size === 0 && this.casting) this._stopCapture();
    });
  }

  async _stopCapture() {
    if (!this.casting) return;
    this.casting = false;
    await this.session.stopScreencast().catch(() => {});
  }

  _broadcast(event, data) {
    for (const c of this.clients) {
      try {
        c.res.write(`event: ${event}\ndata: ${data}\n\n`);
      } catch {
        this.clients.delete(c);
      }
    }
  }

  _loop() {
    const interval = Math.max(80, Math.floor(1000 / this.fps));
    this.timer = setInterval(() => this._tick(false), interval);
    if (this.timer.unref) this.timer.unref();
  }

  /**
   * Start pushing frames. Prefers the CDP screencast, falls back to polling.
   *
   * Called from the server's first /stream connection rather than at launch, so
   * a session nobody is watching does no capture work at all.
   */
  async _startCapture() {
    // `starting` is deliberately separate from `busy`. `busy` guards the polling
    // frame grab, and an action's pulse can have one in flight at the moment a
    // viewer connects. Sharing the flag made capture silently never start.
    if (this.casting || this.starting) return;
    this.starting = true;
    try {
      this.casting = await this.session.startScreencast({
        quality: this.frameQuality ?? 60,
        maxFps: this.maxFps,
        onFrame: (jpeg, at) => this._publish(jpeg, at),
      });
    } catch {
      this.casting = false;
    } finally {
      this.starting = false;
    }
    if (!this.casting && !this.timer) this._loop();
  }

  _publish(jpeg, at) {
    this.frame = jpeg;
    this.lastFrameAt = at;
    this.framesSent += 1;
    this._broadcast("frame", String(at));
  }

  async _tick(force) {
    if (this.busy) return;
    if (!this.session.running) return;
    if (!force && this.clients.size === 0) return;
    this.busy = true;
    const started = Date.now();
    try {
      const jpeg = await this.session.screenshotJpeg({ quality: 72, dropIfBusy: true });
      if (!jpeg) return;
      this.frame = jpeg;
      this.lastFrameAt = started;
      this._broadcast("frame", String(this.lastFrameAt));
    } catch {
      /* page may be mid-navigation */
    } finally {
      this.busy = false;
    }
  }

  async stop() {
    await this._stopCapture();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const c of this.clients) {
      try {
        c.res.end();
      } catch {}
    }
    this.clients.clear();
    if (this.server) {
      await new Promise((r) => this.server.close(r));
      this.server = null;
    }
    this.url = null;
  }
}

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>pi-computer-use — live view</title>
<style>
  :root {
    --bg: #0b0f17; --panel: #121826; --line: #1f2937;
    --text: #e5e7eb; --dim: #94a3b8; --accent: #3b82f6; --ok: #34d399;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: var(--bg); color: var(--text);
    font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    display: flex; flex-direction: column;
  }
  header {
    display: flex; align-items: center; gap: 12px;
    padding: 8px 14px; border-bottom: 1px solid var(--line);
    background: var(--panel); flex: 0 0 auto;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dim); flex: 0 0 auto; }
  .dot.live { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
  .dot.hot { background: #fbbf24; box-shadow: 0 0 10px #fbbf24; }
  #url {
    flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; color: var(--dim);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  }
  .meta { color: var(--dim); font-variant-numeric: tabular-nums; white-space: nowrap; }
  button {
    font: inherit; color: var(--text); background: #1b2436;
    border: 1px solid var(--line); border-radius: 6px;
    padding: 4px 10px; cursor: pointer;
  }
  button:hover { background: #223049; }
  button[aria-pressed=true] { background: var(--accent); border-color: var(--accent); color: #fff; }
  #stage {
    flex: 1 1 auto; overflow: auto; display: flex;
    align-items: flex-start; justify-content: center; padding: 12px;
  }
  #wrap { position: relative; }
  img#screen {
    display: block; max-width: 100%; height: auto;
    border: 1px solid var(--line); border-radius: 8px; background: #fff;
    cursor: crosshair;
  }
  #wrap.takeover img#screen { box-shadow: 0 0 0 2px var(--accent); }
  #hint {
    position: absolute; left: 8px; bottom: 8px;
    background: rgba(11,15,23,.85); border: 1px solid var(--line);
    border-radius: 6px; padding: 3px 8px; color: var(--dim); font-size: 11px;
    pointer-events: none; opacity: 0; transition: opacity .2s;
  }
  #wrap:hover #hint { opacity: 1; }
  #idle {
    position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
    color: var(--dim); background: rgba(11,15,23,.9); border-radius: 8px;
  }
  footer {
    flex: 0 0 auto; border-top: 1px solid var(--line); background: var(--panel);
    padding: 6px 14px; display: flex; gap: 18px; color: var(--dim); font-size: 12px;
    align-items: center;
  }
  #hint-right { margin-left: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; opacity: .8; }
</style>
</head>
<body>
<header>
  <span class="dot" id="dot"></span>
  <span id="url">connecting…</span>
  <span class="meta" id="fps"></span>
  <button id="takeover" aria-pressed="false" title="Click the screenshot to interact with the page">Take over</button>
  <button id="full">Full</button>
</header>
<div id="stage">
  <div id="wrap">
    <img id="screen" alt="Pi's browser">
    <div id="hint">Paused — respecting page motion</div>
    <div id="idle">browser not running</div>
  </div>
</div>
<footer>
  <span id="display">—</span>
  <span id="actions">—</span>
  <span id="size">—</span>
  <span id="hint-right">ghost cursor · click Take over to drive</span>
</footer>
<script>
(() => {
  const img = document.getElementById('screen');
  const dot = document.getElementById('dot');
  const urlEl = document.getElementById('url');
  const fpsEl = document.getElementById('fps');
  const wrap = document.getElementById('wrap');
  const idle = document.getElementById('idle');
  const takeoverBtn = document.getElementById('takeover');
  const fullBtn = document.getElementById('full');

  let n = 0, t0 = performance.now(), lastPaint = 0, pending = false, takeover = false;

  function loadFrame() {
    if (pending) return;
    pending = true;
    const next = new Image();
    next.onload = () => { img.src = next.src; pending = false; n++; };
    next.onerror = () => {
      pending = false;
      idle.style.display = 'flex';
      dot.className = 'dot';
    };
    next.src = '/frame.jpg?t=' + Date.now();
  }

  const es = new EventSource('/stream');
  es.addEventListener('frame', () => {
    idle.style.display = 'none';
    dot.className = 'dot live' + (Date.now() < hotUntil ? ' hot' : '');
    loadFrame();
  });
  es.onerror = () => { dot.className = 'dot'; urlEl.textContent = 'reconnecting…'; };

  let hotUntil = 0;
  setInterval(() => {
    const now = performance.now();
    const fps = (n / ((now - t0) / 1000)).toFixed(1);
    fpsEl.textContent = fps + ' fps';
    n = 0; t0 = now;
    fetch('/state').then(r => r.json()).then(s => {
      urlEl.textContent = s.url || 'about:blank';
      document.getElementById('display').textContent =
        (s.headless ? 'headless' : 'display ' + (s.display || '?')) +
        (s.osPointer ? ' · real pointer' : '');
      document.getElementById('actions').textContent = s.actions + ' actions';
      document.getElementById('size').textContent = s.viewport ? s.viewport.width + '×' + s.viewport.height : '';
      hotUntil = (s.lastFrameAt || 0) + 1200;
    }).catch(() => {});
  }, 1000);

  takeoverBtn.onclick = () => {
    takeover = !takeover;
    takeoverBtn.setAttribute('aria-pressed', String(takeover));
    wrap.classList.toggle('takeover', takeover);
  };
  fullBtn.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  };

  // Map viewport pixels back to page pixels so clicking the stream is exact.
  const post = (ev) => fetch('/input', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ev),
  });
  img.addEventListener('click', (e) => {
    if (!takeover) return;
    const r = img.getBoundingClientRect();
    const sx = img.naturalWidth / r.width, sy = img.naturalHeight / r.height;
    post({ type: 'click', x: Math.round((e.clientX - r.left) * sx), y: Math.round((e.clientY - r.top) * sy) });
  });
  img.addEventListener('mousemove', (e) => {
    if (!takeover) return;
    const r = img.getBoundingClientRect();
    const sx = img.naturalWidth / r.width, sy = img.naturalHeight / r.height;
    post({ type: 'move', x: Math.round((e.clientX - r.left) * sx), y: Math.round((e.clientY - r.top) * sy) });
  });
})();
</script>
</body>
</html>`;
