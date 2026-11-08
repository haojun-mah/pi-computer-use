# pi-computer-use

**A browser Pi can drive that you can actually watch.**

Pi's browser automation runs headless, so every click happens in a window nobody
can see. This package runs a real headed Chromium instead, draws an animated ghost
cursor into the page, and streams the whole session to a viewer you open
locally — so you can follow along, catch a wrong click before it matters, and
trust what the agent did.

The browser is also **long-lived**. It runs in a detached daemon, so finishing a
turn, ending a session, or closing the terminal leaves it open. A browsing task is
one continuous visible session, not a sequence of launches.

![The ghost cursor and action label on a live page](docs/ghost-cursor.png)

And the live view, streaming to your own browser:

![The live view UI](docs/live-view.png)

```
   ┌──────────────────────────────┐        ┌──────────────────────┐
   │  detached daemon (survives)  │        │  your browser        │
   │  ┌────────────────────────┐  │  SSE   │  ┌────────────────┐  │
   │  │ headed Chromium        │──┼───────▶│  │  live view     │  │
   │  │ page + ghost cursor    │  │ frames │  │  click to take │  │
   │  │  ↖ animated pointer    │  │        │  │  over          │  │
   │  └────────────────────────┘  │        │  └────────────────┘  │
   └──────────────▲───────────────┘        └──────────────────────┘
                  │ unix socket
        pi turn ──┴── pi turn ── pi turn
```

## Why

Codex's desktop app feels intuitive because the browser lives *inside* the window
you are already looking at, and on Windows it literally moves your OS pointer.
Pi had no equivalent: `@playwright/mcp` launches with `--headless`, its tools act
on accessibility refs, and nothing is ever drawn. The work was correct but
invisible.

This package closes that gap with four pieces:

| Piece | What it does |
| --- | --- |
| **Ghost cursor** | An animated pointer, click ripple, element highlight and action label drawn *inside the page*. |
| **Real input** | Every click and keypress goes through `page.mouse` / `page.keyboard`, so events stay `isTrusted: true`. The cursor annotates; it never substitutes. |
| **Live view** | A local web page streaming JPEG frames over SSE, with click-to-takeover. Works over SSH with one port forward. |
| **Daemon** | The browser lives in a detached process, so it outlives any one Pi turn, session, or terminal. |

Optional fourth piece: `osPointer: true` moves the **real hardware cursor**
through X11 `XTest`, reproducing Codex's desktop takeover.

## Install

```bash
pi install git:github.com/haojun-mah/pi-computer-use
```

Then check the machine can run it:

```bash
npx pi-computer-use doctor
```

```
  ✓ node                 v22.19.0
  ✓ chromium             ~/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome
  ✓ X display            :0 (found :0)
  ✓ real OS pointer      helper already built
  ✓ chromium smoke test  launches

Ready. The in-page ghost cursor works whenever Chromium + a display are present.
```

## Use

Just ask, or be explicit:

```
open a browser and show me the pricing page
```

The model gets ten tools:

| Tool | Purpose |
| --- | --- |
| `browser_open` | Launch the persistent visible browser and load a URL. Returns the live view URL. |
| `browser_act` | **Run a sequence of actions in one burst** — click, type, press, scroll, navigate, wait. |
| `browser_snapshot` | Page text plus interactive elements, each with a numeric `ref`. |
| `browser_click` | Move cursor → pause → ripple → real click. Takes a ref, selector, or `{x,y}`. |
| `browser_type` | Focus with a visible move, then type at a human cadence. |
| `browser_press` | Key or chord, e.g. `Enter`, `Control+A`. |
| `browser_scroll` | Scroll, optionally moving the cursor to a target first. |
| `browser_screenshot` | PNG back to the model, including the ghost cursor. |
| `browser_eval` | Evaluate JavaScript in the page. |
| `browser_close` | Close the browser and stop the daemon. Rarely needed. |

Plus `/browser` to print the live view URL, and `/browser --open` to launch it.

### One browser, many turns

The browser is **not** reopened per step. It runs in a detached daemon that
outlives every Pi process, so the intended flow is:

```
turn 1   browser_open  → the page is up, and stays up
turn 2   browser_snapshot → same page, same cookies, same scroll
turn 3   browser_act   → three clicks in one visible burst
turn ... done. the browser is still open.
```

Closing the terminal does not close it. `session_shutdown` deliberately does not
touch it — that hook was the bug that made the first version cycle the browser on
every exit. Only `browser_close`, or `npx pi-computer-use stop`, ends a session.

### Prefer `browser_act`

Each individual tool call is a round-trip through the model. Five clicks in five
calls means five pauses where a human watches a motionless page. `browser_act`
takes the whole sequence at once, so the cursor keeps moving:

```json
{ "steps": [
  { "action": "click",  "target": 3 },
  { "action": "type",   "target": 4, "text": "hello@example.com" },
  { "action": "click",  "target": 7 }
]}
```

Results come back per step (`1. ok click — clicked ref 3 …`), so a failure in the
middle is visible without losing the steps that succeeded. Pass
`stopOnError: true` when later steps depend on earlier ones.

### Watching it

`browser_open` returns something like `http://127.0.0.1:7799/`. Open it locally.

Over SSH, forward the port first:

```bash
ssh -L 7799:127.0.0.1:7799 you@host
```

Then open `http://127.0.0.1:7799/` on your laptop. Toggle **Take over** to click
the stream and drive the page yourself; Pi keeps working from wherever the page
ended up.

## Targets

Prefer refs. They are stable within a snapshot and require no selector guessing:

```
browser_snapshot          →  [3] button "Add to cart" @412,286
browser_click {target:3}  →  clicked ref 3 "Add to cart" at 412,286
```

Refs are reassigned on each snapshot, so re-snapshot after navigation rather than
reusing an old one. CSS selectors and `{x, y}` are available for canvas, maps and
drag surfaces where nothing has a handle.

## Headless is still allowed

Set `headless: true` when nobody is watching. Everything works except the window;
the ghost cursor is still injected, so `browser_screenshot` stays legible and the
live view still streams. The stream is genuinely useful in CI: point a test at it
and you get a scrubbable record of what the agent saw.

## Requirements

- Node 20+
- Chromium — `npx playwright install chromium`, or any Chrome on the box
- A display for headed mode — `DISPLAY=:0`, a desktop session, or `Xvfb`
- *Optional:* a C compiler and `libXtst` for the real OS pointer

No root is required. No VNC server is required. No native addons are compiled at
install time.

## How it fits together

```
src/index.js      the extension: ten tools + /browser
src/daemon.js     detached browser process + unix-socket client
src/session.js    BrowserSession: launch, serialized actions, snapshots, act()
src/overlay.js    the in-page ghost cursor (injected at document start)
src/liveview.js   HTTP server: /, /stream (SSE), /frame.jpg, /input
src/os-pointer.js optional XTest helper, compiled once on first use
```

Actions are serialized through one queue so two clicks can never interleave — with
a human watching, overlapping cursors would be worse than slow ones. Frame grabs
deliberately bypass that queue: a dropped frame beats a stalled stream.

The daemon is a separate concern from the queue: the queue orders actions *within*
a burst, the daemon keeps the browser alive *between* bursts. State lives in
`~/.pi/agent/computer-use/` — `daemon.sock`, `daemon.json`, and the Chromium
profile — so a restarted Pi picks up the same page, cookies and all.

## Caveats

- The overlay lives in the page, so a page that replaces `document.documentElement`
  can drop it. It re-injects on the next navigation.
- `osPointer` assumes the browser window sits at its launch position; moving the
  window by hand offsets the hardware cursor.
- The live view binds to `127.0.0.1` only. It has no authentication, by design —
  forward the port, do not expose it.
- The daemon is per-user, not per-project. Two Pi sessions share one browser, which
  is usually what you want, but it does mean a second session will join a page the
  first one is using. `npx pi-computer-use stop` is the reset.
- If the live view port is taken, it walks forward (7799, 7800, …) instead of
  failing. The URL reported is the one it actually bound.

### On Wayland / Xwayland

Under Xwayland the window is real and composited, but grabbing the **root** window
comes back black, because the compositor owns the scanout. That is a screen-capture
quirk, not a failure: the window itself is `IsViewable` and its pixels are readable
directly with `XGetImage`. Two consequences —

- `ffmpeg -f x11grab -i :0` will look black even though the browser is up.
- `browser_screenshot` and the live view are unaffected: they capture from inside
  Chromium, never from the root window.

`xlsclients` confirming a `chrome` entry, plus a viewable window of the expected
size in `xwininfo -root -children`, is the reliable way to check the window exists.

## License

MIT
