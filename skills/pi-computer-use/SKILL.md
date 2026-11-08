---
name: pi-computer-use
description: Drive a browser a human can actually watch — headed Chromium with an animated ghost cursor, click ripples, and a live view URL. Use when the user wants to see browser automation happen, asks to "show me", mentions computer use / browser control, or when a headless click would be invisible and hard to trust. Also use when debugging visual or layout issues in a page.
---

# pi-computer-use

A visible browser for Pi. Instead of a headless session whose clicks nobody can
see, this runs a headed Chromium and draws an animated pointer into the page.

## When to use this

Use it whenever **seeing** the browser matters:

- The user asks to watch, or asks what the browser is doing.
- You are about to do something consequential on a real site (purchase, submit,
  delete) and want the click to be visible and interruptible.
- Debugging layout, styling, canvas, or animation — a screenshot of the visible
  state is the evidence.
- Walking the user through a flow step by step.

Prefer the ordinary headless path when you just need text: it is faster and does
not need a display.

## The loop

1. `browser_open` with a URL, **once per task**. It returns a **live view URL** —
   always tell the user that URL, and the `ssh -L` command if they are remote.
2. `browser_snapshot` to see structure. Every interactive element comes back
   with a numeric `ref`.
3. Act with `browser_act` for sequences, or `browser_click` / `browser_type` /
   `browser_press` / `browser_scroll` for one step, passing the **ref**, not a
   guessed selector.
4. `browser_snapshot` again to confirm what changed. Do not assume.

`browser_screenshot` returns a PNG to you *and* mirrors what the human sees,
including the ghost cursor — good for confirming a visual change landed.

## The browser is long-lived — do not cycle it

The single most common mistake is re-opening the browser. Do not do it.

- Call `browser_open` **once**, at the start of the task.
- Never call `browser_close` to tidy up, and never reopen between steps to "reset"
  — the page, its cookies, its scroll position and its history are the point.
- Finishing a turn does not close it. The browser runs in a detached daemon that
  survives Pi exiting entirely, so a later turn or a brand-new session picks up the
  exact same page. Just call `browser_snapshot`.
- If you truly need a fresh page, `browser_open` again with a URL: it navigates the
  existing browser instead of launching a second one.

## Targeting rules

Order of preference for any `target`:

1. **ref** from the latest snapshot — stable, cheap, no guessing.
2. **CSS selector** when you know the markup and the ref list is stale.
3. **{x, y}** viewport coordinates — last resort, for canvas, maps, or drag
   surfaces where nothing has a handle.

Refs are reassigned on every `browser_snapshot` call. Re-snapshot after a
navigation or a DOM change rather than reusing an old ref.

## Etiquette that keeps it watchable

- Batch with `browser_act` when the steps are decided. A human watching a page sit
  still between five separate tool calls is watching a hang, not an agent. Multiple
  actions in one `browser_act` move continuously and read as intent.
- Still snapshot between *decisions*. Burst the mechanical actions; think between
  bursts.
- Let `browser_open` keep `headless: false`. Only force headless for speed when
  nobody is looking.
- `osPointer: true` additionally moves the real hardware cursor. It needs an X11
  display plus a C compiler; it is off by default because the in-page cursor
  works everywhere, including headless and CI.
- On a remote machine the live view is bound to `127.0.0.1`. The user must
  forward the port; give them the exact command.

## Failure modes worth knowing

- **Blank screenshot, real page.** The overlay is injected at document start.
  A page that replaces `document.documentElement` wholesale can drop it; it
  re-injects on the next navigation, so reload rather than debugging the page.
- **Click lands nowhere.** The target scrolled out of view between snapshot and
  click. Re-snapshot; this is why refs are resolved fresh each call.
- **No display.** `browser_open` raises a clear error naming `DISPLAY`. Do not
  silently fall back to headless — the user asked for visibility.
- **Port in use.** `PI_CU_PORT` changes it. `pi-computer-use doctor` reports
  whether the default is free.
