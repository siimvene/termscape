---
paths:
  - "src/main/window-state.ts"
  - "src/main/window-raise.guard.test.ts"
  - "src/main/remote/standing-host.ts"
---
# Main-process window behavior: geometry restore + raise policy

## Nothing raises the window without a user action

Issue #737 (third in the family; #665/#702 were canvas-control moving the VIEW, this is the OS window
activating). Cause: `win.on('ready-to-show', () => win.show())` — `ready-to-show` fires on the first
paint of EVERY main-frame navigation (MEASURED, Electron 42.9.1: a `reload()` on a VISIBLE window emits
it again), and the crash auto-reload (`render-process-gone` → `reload()`) is unattended, so a
jetsam-killed backgrounded renderer raised nodeterm over the foreground app. It is `win.once` now.
**The gate must be FIRST PAINT, not `isVisible()`** (after macOS hide-on-close the window is hidden but
alive, so an `isVisible()` gate would `show()` on a background reload — the bug inverted).

Every permitted raise is a CLICK, enumerated with its trigger in `src/main/window-raise.guard.test.ts`
(allowlist-with-reasons, shape of `fs-atomic.guard.test.ts`): notification tap, Notch HUD row, Dock
activate, second launch, file dropped onto a terminal. Nothing an AGENT does reaches any (canvas
control, triggers, hook POSTs, relay/pairing/push, browser-drive carry no show/focus/dialog; agent
confirms are in-renderer). The drop IPC's `app.focus({steal:true})` carries the same sender guard its
neighbours have (a `<webview>` guest is a webContents here). **KNOWN GAP, not fixed:**
`standing-host.ts`'s `dialog.showErrorBox` for a locked keyring is app-modal, unparented and raised
from the relay RECONNECT TIMER; the fix routes it to a non-modal in-app surface (owes a macOS check).

## Window geometry is REMEMBERED

`main/window-state.ts`, `<userData>/window-state.json` — size/position/maximized restored next launch
(before, a hard-coded 1400×900). Electron-free (pure decisions over rectangles, so the refusals are
testable); `screen.getAllDisplays()`'s WORK AREAS are passed in. The refusals ARE the feature:

- **While MAXIMIZED size comes from `getNormalBounds()`, not `getBounds()`** (the latter is the
  maximized rect → the next un-maximize hands back a screen-sized window). Un-maximized it is
  `getBounds()`; `getNormalBounds()` is documented only on some Linux DEs, so the common case must not
  depend on the WM (the maximized record restores by re-maximizing).
- **An unreachable position is DROPPED, not clamped** (an undocked laptop would reopen off-screen).
  Reachable = real overlap with a work area (`MIN_VISIBLE_*`) judged against the CLAMPED size, AND the
  TOP edge landing on it within `TOP_OVERHANG_SLACK` (24px) — overlap is symmetric, so a monitor
  mounted ABOVE and unplugged clips the bottom while the title bar (the whole drag region under
  `hiddenInset`) sits off-screen. Per-display.
- **No capture while minimized or fullscreen** (`isMaximized()` is FALSE in macOS fullscreen, so
  capturing records `maximized:false` and erases the preference). The app never reopens INTO fullscreen
  (deliberate — harder to escape on first launch).
- **Maximize before the first paint** (`show:false`), or it is a visible jump every launch.
- Every field is **re-validated as a number on read** (hand-editable, reaches the constructor before
  there is a window to report a failure in). Saves debounced, flushed **synchronously on `close`** (the
  only moment guaranteed to see the final state) via `renameAtomicSync` with a per-call unique temp.
  **NT_MULTI excluded** (a dev sandbox must not move the real app's window).
- Desktop only. **Wayland:** a native-Wayland client cannot set its own position, so x/y is honoured
  under XWayland and ignored otherwise; size + maximized restore either way.
