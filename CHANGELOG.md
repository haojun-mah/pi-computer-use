# Changelog

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
