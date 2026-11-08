/**
 * OsPointer — move the *real* hardware cursor.
 *
 * This reproduces the Codex "Computer Use" behaviour at the smallest possible
 * scale. On Windows, Codex genuinely moves the OS pointer and takes the
 * foreground. X11 can do the same through XTest, with no root and no extra
 * packages — libXtst is already on most desktops.
 *
 * Node has no built-in FFI, and shipping a native addon for a nicety is not
 * worth it. So we compile a ~60-line C helper once with the system compiler and
 * talk to it over stdin. If there is no compiler or no libXtst, this reports
 * unavailable and the in-page ghost cursor carries on alone — which is the
 * default anyway, because it works headless and over SSH.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const HELPER_C = String.raw`
#include <X11/Xlib.h>
#include <stdio.h>
#include <stdlib.h>

/* XTest.h is absent on many headless installs, but the ABI is stable, so we
   declare the two entry points ourselves and link the runtime library. */
extern int XTestFakeMotionEvent(Display *, int, int, int, unsigned long);
extern int XTestFakeButtonEvent(Display *, unsigned int, Bool, unsigned long);

int main(int argc, char **argv) {
  Display *d = XOpenDisplay(argc > 1 ? argv[1] : NULL);
  if (!d) { fprintf(stderr, "cannot open display\n"); return 1; }
  int scr = DefaultScreen(d);
  char line[256];
  while (fgets(line, sizeof line, stdin)) {
    char op = line[0];
    if (op == 'm') {
      int x = 0, y = 0;
      if (sscanf(line + 1, "%d %d", &x, &y) == 2) {
        XTestFakeMotionEvent(d, scr, x, y, 0);
        XFlush(d);
      }
    } else if (op == 'd') {
      XTestFakeButtonEvent(d, 1, True, 0); XFlush(d);
    } else if (op == 'u') {
      XTestFakeButtonEvent(d, 1, False, 0); XFlush(d);
    } else if (op == 'q') {
      break;
    }
  }
  XCloseDisplay(d);
  return 0;
}
`;

/** Candidate link lines, tried in order. `-lXtst` needs the dev package; the
 *  bare .so.6 path does not, which is what makes this work on minimal boxes. */
function linkArgs() {
  const candidates = [
    ["-lX11", "-lXtst"],
    ["-lX11", "/lib/x86_64-linux-gnu/libXtst.so.6"],
    ["-lX11", "/usr/lib/x86_64-linux-gnu/libXtst.so.6"],
    ["-lX11", "/usr/lib64/libXtst.so.6"],
  ];
  return candidates;
}

function helperDir() {
  const dir = join(homedir(), ".pi", "agent", "computer-use", "bin");
  mkdirSync(dir, { recursive: true });
  return dir;
}

let lastError = null;
export function osPointerStatus() {
  return { error: lastError };
}

/** Compile once, cached. Returns the helper path or null. */
function ensureHelper() {
  const dir = helperDir();
  const bin = join(dir, "pi-cu-xtest");
  if (existsSync(bin)) return bin;

  const src = join(dir, "pi-cu-xtest.c");
  writeFileSync(src, HELPER_C);
  const compiler = ["cc", "gcc", "clang"].find((c) => {
    try {
      execFileSync("sh", ["-c", `command -v ${c}`], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
  if (!compiler) {
    lastError = "no C compiler (cc/gcc/clang) found";
    return null;
  }

  const errors = [];
  for (const extra of linkArgs()) {
    try {
      execFileSync(compiler, [src, "-o", bin, ...extra], {
        stdio: "pipe",
        timeout: 30000,
      });
      if (existsSync(bin)) {
        chmodSync(bin, 0o755);
        return bin;
      }
    } catch (err) {
      errors.push(String(err.stderr || err.message).split("\n")[0]);
    }
  }
  lastError = `compiling the XTest helper failed: ${errors.join(" | ")}`;
  return null;
}

export class OsPointer {
  constructor(display, { windowPosition = [0, 0], chromeOffset = { x: 8, y: 82 } } = {}) {
    this.display = display;
    this.windowPosition = windowPosition;
    this.chromeOffset = chromeOffset;
    this.available = false;
    this.child = null;
    this.reason = null;
  }

  probe() {
    if (!this.display) {
      this.reason = "no X display";
      return false;
    }
    const bin = ensureHelper();
    if (!bin) {
      this.reason = lastError || "libXtst or a C compiler not available";
      return false;
    }
    try {
      this.child = spawn(bin, [this.display], { stdio: ["pipe", "ignore", "ignore"] });
      this.child.on("error", () => {
        this.available = false;
        this.child = null;
      });
      this.child.unref();
      if (this.child.stdin) this.child.stdin.unref?.();
      this.available = true;
      this.reason = null;
      return true;
    } catch (err) {
      this.reason = String(err && err.message);
      this.available = false;
      return false;
    }
  }

  /** Viewport coords -> screen coords, then move the real cursor. */
  async moveTo(x, y) {
    if (!this.available || !this.child) return;
    const sx = Math.round(this.windowPosition[0] + this.chromeOffset.x + x);
    const sy = Math.round(this.windowPosition[1] + this.chromeOffset.y + y);
    try {
      this.child.stdin.write(`m ${sx} ${sy}\n`);
    } catch {
      this.available = false;
    }
  }

  close() {
    if (this.child) {
      try {
        this.child.stdin.write("q\n");
        this.child.stdin.end();
        this.child.kill();
      } catch {}
      this.child = null;
    }
    this.available = false;
  }
}
