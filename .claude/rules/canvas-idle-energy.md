---
paths:
  - "src/renderer/styles.css"
  - "src/renderer/lib/windowActivity.ts"
  - "src/renderer/lib/canvasCovered.ts"
  - "src/renderer/styles.animation-gate.test.ts"
  - "src/renderer/canvas/camera-moving.test.ts"
  - "src/renderer/canvas/canvas-empty-changes.test.ts"
  - "src/core/remote-ssh/pty-spawn-gate.ts"
---
# Idle energy: an animation is a frame loop, not a decoration

A running CSS animation makes the compositor produce a frame every vsync (120/s on ProMotion), each
re-rastering + re-compositing the whole window. Paid once per WINDOW, not per animation; a
still-visible unfocused window is not `document.hidden`, so it keeps producing frames at full rate.

MEASURED, Server Edition, 40 nodes, headless Chrome, 25 s idle, total CPU across Chrome procs:

| state | CPU |
|---|---|
| idle, nothing animating | 1.5% |
| one visible node with the `working` glow | 33% |
| five / twenty | 66% / 101% |
| twenty, panned OFF screen | 2.2% |
| twenty, under an opaque full-screen overlay | 12.8% |
| twenty, `animation-play-state: paused` / `animation: none` | 1.6% / 1.9% |
| first-run mobile-launch card (5 animations, no glows) | 97% |

- **The step is at the FIRST animation** (frames produced at all is the cost), so the gate must cover
  EVERY `infinite` animation — `--nt-anim-state` is on every one in `styles.css`, enforced by scan
  (`styles.animation-gate.test.ts`).
- **Offscreen is already free** (2.2%, Chromium skips raster outside the viewport). **`paused` ≈
  `none`** (1.6 vs 1.9), so the gate FREEZES in place (refocus resumes, not restarts).
- **The main thread is idle** (0.15 s TaskDuration / 25 s) — compositor/raster work, invisible to JS
  profilers. Timers are not the problem (56 callbacks/30 s, zero rAF).
- The A/B fixes the MECHANISM only; headless Chrome rasters in software (SwiftShader), so absolute
  percentages are inflated — measure magnitude per machine (`powermetrics`, Energy Impact).

Two gates, two attributes (the facts are independent — a board on a focused window; an unfocused window
with no board — and one attribute with two owners races):
- **Focus:** `lib/windowActivity.ts` sets `data-nt-window="idle"` on focus loss / page hide;
  `:root[data-nt-window='idle']` flips `--nt-anim-state` to `paused`. The three per-node glows take a
  static-lit rule instead (pausing freezes a glow wherever its clock stopped, and the "agent finished
  while you were away" glow must still be on screen when you come back to look for it). `hud.css` is excluded (its window is never focused).
- **Board:** the canvas stays mounted under the kanban overlay (`display:none` would 0×0-resize every
  terminal into a tmux SIGWINCH), so it animates unseen (12.8%). `lib/canvasCovered.ts` marks
  `data-nt-canvas="covered"` while a full-page board is MOUNTED (refcounted — React can mount the
  incoming view before unmounting the outgoing); the inheriting variable makes
  `:root[data-nt-canvas='covered'] .react-flow` one declaration for the whole subtree.
- **Specificity is the quiet failure, twice already:** the glows carry their own `animation:` shorthand
  (which RESETS `animation-play-state`), so every gate must name them explicitly. Verify the COMPUTED
  `animation-play-state` on a real element, never the presence of the declaration.

**The working and unread glows are BOUNDED; the attention glow is not.** The idle gate only helps an
unfocused window, and an agent mid-turn in a FOCUSED one kept `nt-working-glow` looping for the
whole turn — MEASURED (production build, M2, focused): one visible working node cost **+3 points
total CPU and ~25 style recalcs/s** for as long as it ran. It now runs 4 cycles of 2.6 s (~10 s) and
rests at `opacity: 0.7`, the same static-lit value the idle gate and Reduce Motion already hold it
at; the keyframes start and end at 0.7, so the settle is seamless. A new turn re-adds `.working`,
which restarts the pulse — and so does anything else that re-applies the animation: a window
refocus (the idle gate sets `animation: none`, so lifting it starts the shorthand afresh) and a node
remount (a project switch, a park re-adopt) each replay the four pulses. Still bounded every time.
**Unread is bounded the same way** (4 cycles of 2 s, resting lit at `opacity: 0.85`), and so are the
minimap's working and unread beats (`mm-pulse-soft` / `mm-pulse-unread`, resting at full stroke), and
a WAITING `--after` rope is dashed + ⏳ but no longer `animated` (React Flow's `dashdraw`, 0.5 s
infinite): an unread node stays unread until someone looks, and a wait can last hours, so on a busy
canvas those three kept the frame loop open indefinitely. MEASURED (46-node SSH canvas, 14 unread
nodes, 8 waiting ropes, FOCUSED window, dev build): idle renderer+GPU **~120% → ~25%**, and pausing
every remaining animation no longer moves it. Pausing any ONE family alone saved far less (85–104%),
which is the first-animation step above again. Only the attention glow (and its minimap beat) stays
infinite — needs-you is the one state that must keep pulling the eye — and the idle gate covers the
unfocused case. The driven-browser rope still flows (it lasts only while an agent drives the page).
`styles.animation-gate.test.ts` pins the bounded shorthands, the resting values and the keyframe
endpoints.

**The viewport is never promoted — not even while the camera moves.** A `will-change: transform`
on `.react-flow__viewport` during pan/zoom was tried (00c9c5fc, measured 41–48% → 30–36% CPU on
12 WebGL terminals) and removed: the viewport layer spans the WHOLE canvas, and Chromium rasters it
at a scale it ratchets up during a zoom and never lowers. MEASURED on a 46-node SSH canvas (41
terminals, 1470×923 @2x, CDP-driven wheel zoom 0.8 ↔ 0.12 and pans, dev build): with it, 41–252
`tile memory limits exceeded, some content may not draw` warnings per gesture round — blank tiles,
which users saw as the canvas flickering on zoom — and no CPU gain (~170% total during the gesture
either way; the scripted gesture itself ran 36 s vs 28 s); without it, 0. The small-canvas gain
does not survive a real canvas. `canvas/camera-moving.test.ts` pins the absence.

## Performance: measure it, then fix what the measurement names

Performance work in this app has been wrong by intuition more often than right, so the rule is
the one every bullet below learned the hard way: **measure on the real thing, find the mechanism,
fix that, measure again — and write the before/after in the commit.** Say which build the
numbers come from (a dev build's React is several times slower than production; a percentage
from one is a direction, not a prediction).

**How to measure (works on the dev app, no code changes):** start it with
`npx electron-vite dev --remoteDebuggingPort 9333` and drive it over CDP from a small Node
script (`fetch('http://localhost:9333/json')`, then a WebSocket to the page):
- `Runtime.evaluate` for DOM facts; a module's live instance is reached with
  `import(<its URL from performance.getEntriesByType('resource')>)` — importing the bare path
  after an HMR update gives a SECOND copy of the module and silently measures nothing;
- `Profiler.start/stop` for where main-thread time goes (group samples by the outermost APP
  frame, not by self time — self time drowns in React internals);
- `document.getAnimations()` for what is keeping the compositor busy;
- patch `ResizeObserver.prototype.observe` / `setTimeout` for a few seconds to count who calls
  them; `Input.dispatchMouseEvent` (`mouseWheel`, `modifiers: 2`) for zoom/pan gestures;
- process CPU from `ps -o time` deltas of the renderer + GPU processes (not `%cpu`, which is a
  lifetime average); tile/raster trouble shows as `tile memory limits exceeded` in the dev log;
- for SSH: the host's `journalctl -u ssh | grep -c 'Accepted publickey'` over the test window is
  the number that says whether multiplexing held (healthy ≈ 0–1 per connect).

**Rules this produced (each has its measurement in the linked section or commit):**
- **One running animation keeps the whole window at display rate** — see **Idle energy** above.
  Status animations are bounded (they settle lit), never infinite, except needs-you. Measured on a
  46-node canvas: idle renderer+GPU ~120% → ~25% (#1050).
- **Never promote the React Flow viewport** (`will-change: transform`) — it is a canvas-sized
  layer; on a real canvas it overran the tile budget (flicker) with no CPU gain (#1047).
- **An all-filtered node-change batch must not reach `onNodesChange`** (`handleNodesChange` returns
  early). `applyNodeChanges([])` returns a NEW array; a new `nodes` rebuilds the ephemeral
  subagent/loop cards without `measured`, React Flow re-observes them and its ResizeObserver
  (`force: true`) emits another change — the whole Canvas re-rendered every frame while idle with
  one subagent card on screen (~111% → ~55% idle, #1047; `canvas-empty-changes.test.ts`).
- **Per-terminal work on a project switch must be coalesced and ordered.** A switch mounts every
  node in one tick. Join an in-flight read instead of issuing one per node (the SSH project's
  settings.json read, `overridesInFlight` in pty-manager), and let on-screen nodes go first
  (`PtyCreateOptions.onScreen` → `pty-spawn-gate.ts`): on a 41-terminal SSH project the visible
  ones went from painting LAST (1.5–2.1 s) to first (0.55–1.1 s), 0 extra logins (#1057).
- **A hint must fail toward the old behavior.** `onScreen` absent/unknown = on screen = the old
  FIFO; a coalesced read is never a cache (a spawn after it settles reads again).
