# Changelog

## [0.2.1] - 2026-11-08

Latency. Nothing here changes what the browser can do, only how long it takes.

### Fixed

- **Pi hung after the last tool call.** The daemon socket was ref'd, so an idle
  connection kept the host process alive and every session paid the full timeout
  doing nothing. `sock.unref()` — the daemon outliving us is the point.
- **A stale ref cost a 10-second stall.** `locator.waitFor` auto-waits, so asking
  about an element that no longer exists burned the entire timeout before failing.
  Replaced with a `querySelector` existence probe plus a cheap re-tag retry:
  10,000ms → 3ms, and the error now says "call browser_snapshot again" instead of
  timing out silently.
- A bogus selector cost the same 10s; it now fails in 1.5s.

### Changed

- **`browser_act` can take a `snapshot` step**, so a whole think → act → see cycle
  is one tool call instead of two. This is the biggest win on a real task, because
  it removes a full model round-trip rather than a few milliseconds.
- Snapshot body text defaults to 1200 chars, down from 2500, with
  `textLimit` to control it. A snapshot is re-sent on every later turn, so the
  tail of a page's nav chrome was being paid for repeatedly.
- Cursor glide 340ms → 180ms, pre-click pause 120ms → 45ms, settle 60ms → 30ms.
  Click latency halved (250ms → 130ms). A 180ms move is just as legible; the
  longer ones were simulating a slow hand rather than communicating intent.
- `wait` is available as a top-level daemon method, not only inside `act`.

### Notes

Measured on this machine, per action: snapshot 7ms, navigate 62ms, click 130ms,
four-step `act` including a snapshot 923ms. A plain prompt with no browser use at
all takes ~9s, so most of the wall-clock time in a browsing task is model latency,
not the browser. The fixes above target the round-trips that multiply it.

## [0.2.0] - 2026-11-08

The browser is now continuous. It used to be relaunched for every step, which made
a task look like a series of unrelated browser launches instead of one session you
could follow.

### Added

- **Detached daemon** (`src/daemon.js`). The browser runs in its own process,
  reparented to init, reachable over a unix socket at
  `~/.pi/agent/computer-use/daemon.sock`. Ending a Pi turn, ending a session, or
  closing the terminal no longer closes the browser — only `browser_close` or
  `npx pi-computer-use stop` does.
- **`browser_act`**: several actions in one call, in one visible burst. Chaining
  five single-action calls meant five model round-trips with a motionless page in
  between; that pause was reading as a hang rather than as thinking.
- **CLI**: `status`, `view`, and `stop` subcommands for inspecting and ending the
  browser from a shell, with no model in the loop.
- The live view now walks forward from port 7799 when the preferred port is busy,
  instead of failing to bind. The URL it reports is the one it actually got.

### Removed

- The `session_shutdown` hook. It closed the browser whenever Pi exited, which was
  the root cause of the open/close cycling. Persistence is now the default and
  there is no hook that fights it.

### Fixed

- Double-click fired three down/up pairs instead of two — `clickCount: 2` on the
  first pair made the browser count it as a triple. Now the pairs are explicitly
  `clickCount: 1` then `clickCount: 2`, so `dblclick` fires exactly once.
- `browser_close` now actually stops the daemon. It previously closed the page but
  left the process holding the socket and the port.

## [0.1.0] - 2026-11-08

First release.

### Added

- Headed Chromium session with an in-page **ghost cursor**: a pointer that
  animates to each target, a ripple on click, an element highlight, and a
  one-line action label.
- Nine tools — `browser_open`, `browser_snapshot`, `browser_click`,
  `browser_type`, `browser_press`, `browser_scroll`, `browser_screenshot`,
  `browser_eval`, `browser_close` — plus a `/browser` command.
- `browser_snapshot` returns interactive elements with stable numeric refs, so
  the model clicks by ref instead of guessing selectors.
- **Live view**: a local web page streaming JPEG frames over SSE, with
  click-to-takeover and a fullscreen toggle. Works over SSH with one port
  forwarding rule.
- Optional `osPointer` mode that moves the real hardware cursor through X11
  `XTest`, compiled from a small C helper on first use.
- `pi-computer-use doctor` to report what a machine can and cannot do, and
  `pi-computer-use demo` to walk a page through visible actions.
- Bundled skill describing when watching the browser matters and how to target
  elements.

### Notes

- Input goes through Playwright's real mouse and keyboard, so events stay
  `isTrusted: true`. The cursor annotates activity; it never fakes it.
- Actions are serialized through a single queue so two clicks cannot interleave
  and produce overlapping cursors.
- No root, no VNC server, no native addon compiled at install time.
