/**
 * The browser daemon.
 *
 * The point of this process is that the browser outlives the agent turn. A Pi
 * tool call is short; a browsing task is not. If the browser lived inside the
 * extension, every process exit (and every `-p` invocation) would close the
 * window and throw away session state — which is exactly the open/close cycling
 * this daemon removes.
 *
 * One daemon per user. The extension talks to it over a unix socket; if it is
 * not running, the extension spawns it detached and reconnects. Closing the
 * terminal, finishing a turn, or starting a new Pi session all leave it alone.
 * Only `browser_close` (or `pi-computer-use stop`) ends it.
 */

import { createServer, connect } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { BrowserSession } from "./session.js";

export const RUNTIME_DIR = join(homedir(), ".pi", "agent", "computer-use");
export const SOCKET_PATH = join(RUNTIME_DIR, "daemon.sock");
export const STATE_PATH = join(RUNTIME_DIR, "daemon.json");

const PROTOCOL = 1;

/* ------------------------------------------------------------------ framing -- */

/** One JSON object per line. Simple, and easy to read when debugging by hand. */
function encode(msg) {
  return JSON.stringify(msg) + "\n";
}

function attachDecoder(socket, onMessage, onClose) {
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        /* a partial or corrupt line is not worth killing the daemon over */
      }
    }
  });
  socket.on("close", () => onClose?.());
  socket.on("error", () => onClose?.());
}

/* ------------------------------------------------------------------- client -- */

/**
 * A lazy, self-healing connection to the daemon.
 *
 * `call()` spawns the daemon if the socket is missing, which is what makes the
 * whole thing invisible: the first browser tool call of the day just works.
 */
export class DaemonClient {
  constructor({ socketPath = SOCKET_PATH, spawnIfMissing = true } = {}) {
    this.socketPath = socketPath;
    this.spawnIfMissing = spawnIfMissing;
    this.socket = null;
    this.pending = new Map();
    this.seq = 0;
    this._connecting = null;
  }

  async _connect() {
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (this._connecting) return this._connecting;

    this._connecting = (async () => {
      try {
        return await this._openOnce();
      } catch (err) {
        if (!this.spawnIfMissing) throw err;
        // Stale socket from a hard kill, or nothing there at all: clear and spawn.
        if (existsSync(this.socketPath)) {
          try {
            unlinkSync(this.socketPath);
          } catch {
            /* another process may have won the race; the retry decides */
          }
        }
        spawnDaemon();
        return this._openOnce({ retries: 40 });
      } finally {
        this._connecting = null;
      }
    })();

    return this._connecting;
  }

  _openOnce({ retries = 0 } = {}) {
    return new Promise((resolve, reject) => {
      const tryConnect = (left) => {
        const sock = connect(this.socketPath);
        const onErr = () => {
          sock.destroy();
          if (left > 0) {
            setTimeout(() => tryConnect(left - 1), 100);
            return;
          }
          reject(new Error(`cannot reach the browser daemon at ${this.socketPath}`));
        };
        sock.once("error", onErr);
        sock.once("connect", () => {
          sock.off("error", onErr);
          this.socket = sock;
          attachDecoder(
            sock,
            (msg) => {
              const entry = this.pending.get(msg.id);
              if (!entry) return;
              this.pending.delete(msg.id);
              if (msg.ok) entry.resolve(msg.result);
              else entry.reject(new Error(msg.error || "daemon error"));
            },
            () => {
              this.socket = null;
              for (const [, entry] of this.pending) entry.reject(new Error("browser daemon disconnected"));
              this.pending.clear();
            },
          );
          resolve(sock);
        });
      };
      tryConnect(retries);
    });
  }

  async call(method, params = {}, { timeoutMs = 120_000 } = {}) {
    await this._connect();
    const id = ++this.seq;
    const socket = this.socket;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      socket.write(encode({ id, method, params }));
    });
  }

  /** Ask whether a daemon is up without starting one. */
  async ping() {
    const saved = this.spawnIfMissing;
    this.spawnIfMissing = false;
    try {
      return await this.call("ping", {}, { timeoutMs: 1500 });
    } catch {
      return null;
    } finally {
      this.spawnIfMissing = saved;
    }
  }

  async stop() {
    try {
      await this.call("shutdown", {}, { timeoutMs: 5000 });
    } catch {
      /* already gone is the goal */
    }
    this.socket?.destroy();
    this.socket = null;
  }

  /**
   * Drop the connection without touching the daemon.
   *
   * Callers that are about to exit still need this: an open socket holds the
   * Node event loop, so a CLI command otherwise hangs until it is killed.
   */
  disconnect() {
    this.socket?.destroy();
    this.socket = null;
  }
}

/** Start the daemon detached so it inherits no lifetime from this process. */
export function spawnDaemon() {
  const self = new URL(import.meta.url).pathname;
  const child = spawn(process.execPath, [self, "--daemon"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PI_CU_DAEMON_CHILD: "1" },
  });
  child.unref();
  return child;
}

/* ------------------------------------------------------------------- server -- */

/**
 * Serve BrowserSession over the unix socket.
 *
 * Deliberately thin: the daemon owns the browser, and this layer only validates
 * that a method exists and forwards its arguments. Business logic stays in
 * BrowserSession, so the daemon and the tests exercise the same code.
 */
export async function runDaemon() {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(RUNTIME_DIR, { recursive: true });

  const session = new BrowserSession();
  let shuttingDown = false;

  const server = createServer((socket) => {
    attachDecoder(
      socket,
      async (msg) => {
        const reply = (payload) => {
          if (!socket.destroyed) socket.write(encode({ id: msg.id, ...payload }));
        };
        try {
          const result = await dispatch(session, msg.method, msg.params ?? {});
          reply({ ok: true, result });
        } catch (err) {
          reply({ ok: false, error: err.message ?? String(err) });
        }
      },
      () => {},
    );
  });

  if (existsSync(SOCKET_PATH)) {
    try {
      unlinkSync(SOCKET_PATH);
    } catch {
      /* a live daemon owns it; listen() below will fail loudly instead */
    }
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(SOCKET_PATH, resolve);
  });

  const cleanup = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await session.close().catch(() => {});
    server.close();
    try {
      unlinkSync(SOCKET_PATH);
    } catch {
      /* best effort */
    }
    try {
      unlinkSync(STATE_PATH);
    } catch {
      /* best effort */
    }
  };

  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => cleanup().then(() => process.exit(0)));

  // Idle exit would defeat the purpose, so there isn't one. The daemon lives
  // until asked to stop; it costs one Chromium and nothing else.
  return { server, session, cleanup };
}

async function dispatch(session, method, params) {
  switch (method) {
    case "ping":
      return { protocol: PROTOCOL, pid: process.pid, running: session.running, info: session.info() };

    case "loading":
      return { running: session.running };

    case "open": {
      await session.ensure();
      const res = await session.navigate(params.url);
      return { ...res, info: session.info() };
    }
    case "navigate":
      return session.navigate(params.url);
    case "back":
      return session.back();
    case "snapshot":
      return session.snapshot(params);
    case "click":
      return session.click(params.target, { clickCount: params.double ? 2 : 1, label: params.label });
    case "hover":
      return session.hover(params.target);
    case "type":
      return session.type(params.target, params.text, {
        submit: params.submit,
        clear: params.clear,
      });
    case "press":
      return session.press(params.key);
    case "scroll":
      return session.scroll(params);
    case "eval":
      return session.evaluate(params.script);
    case "act":
      return { steps: await session.act(params.steps ?? [], { stopOnError: params.stopOnError }) };
    case "screenshot": {
      const buf = await session.screenshot({ fullPage: params.fullPage, path: params.path });
      return { base64: buf.toString("base64") };
    }
    case "info":
      return session.info();
    case "close":
      await session.close();
      return { ok: true };
    case "shutdown":
      setImmediate(async () => {
        await session.close().catch(() => {});
        try {
          unlinkSync(SOCKET_PATH);
        } catch {
          /* best effort */
        }
        try {
          unlinkSync(STATE_PATH);
        } catch {
          /* best effort */
        }
        process.exit(0);
      });
      return { ok: true, stopping: true };
    default:
      throw new Error(`unknown method ${JSON.stringify(method)}`);
  }
}

/**
 * Entry point when this file is executed directly with --daemon.
 *
 * Keyed on the flag rather than only the env var so the daemon can be started
 * by hand while debugging, without the extension having to get involved.
 */
async function main() {
  await runDaemon();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    STATE_PATH,
    JSON.stringify({ pid: process.pid, socket: SOCKET_PATH, startedAt: new Date().toISOString() }, null, 2),
  );
}

if (process.argv.includes("--daemon")) main();
