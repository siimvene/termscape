---
paths:
  - "src/renderer/styles.css"
  - "src/renderer/lib/windowActivity.ts"
  - "src/renderer/lib/canvasCovered.ts"
  - "src/renderer/styles.animation-gate.test.ts"
  - "src/renderer/canvas/camera-moving.test.ts"
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
  static-lit rule instead (`nt-unread-glow` rests at `opacity: 0`, so pausing it could hide the "agent
  finished while you were away" glow). `hud.css` is excluded (its window is never focused).
- **Board:** the canvas stays mounted under the kanban overlay (`display:none` would 0×0-resize every
  terminal into a tmux SIGWINCH), so it animates unseen (12.8%). `lib/canvasCovered.ts` marks
  `data-nt-canvas="covered"` while a full-page board is MOUNTED (refcounted — React can mount the
  incoming view before unmounting the outgoing); the inheriting variable makes
  `:root[data-nt-canvas='covered'] .react-flow` one declaration for the whole subtree.
- **Specificity is the quiet failure, twice already:** the glows carry their own `animation:` shorthand
  (which RESETS `animation-play-state`), so every gate must name them explicitly. Verify the COMPUTED
  `animation-play-state` on a real element, never the presence of the declaration.

**The working glow is BOUNDED; the unread and attention glows are not.** The idle gate only helps an
unfocused window, and an agent mid-turn in a FOCUSED one kept `nt-working-glow` looping for the
whole turn — MEASURED (production build, M2, focused): one visible working node cost **+3 points
total CPU and ~25 style recalcs/s** for as long as it ran. It now runs 4 cycles of 2.6 s (~10 s) and
rests at `opacity: 0.7`, the same static-lit value the idle gate and Reduce Motion already hold it
at; the keyframes start and end at 0.7, so the settle is seamless. A new turn re-adds `.working`,
which restarts the pulse — and so does anything else that re-applies the animation: a window
refocus (the idle gate sets `animation: none`, so lifting it starts the shorthand afresh) and a node
remount (a project switch, a park re-adopt) each replay the four pulses. Still bounded every time. Unread and attention stay infinite on purpose — they exist to pull the
eye, and the idle gate covers the unfocused case. `styles.animation-gate.test.ts` pins the bounded
shorthand, the resting opacity and the keyframe endpoints.

**A camera move freezes the viewport's raster scale, and only for the move.** `onCanvasMoveStart`
adds `canvas-camera-moving` to the flow wrapper in EVERY appearance (before the glass-only
early-return — it is not a glass feature), and `.canvas-camera-moving .react-flow__viewport` sets
`will-change: transform`, so the compositor scales the already-rastered layer instead of
re-rasterising every node's DOM at each intermediate zoom. MEASURED (12 WebGL terminals, 60 Hz
synthetic wheel zoom, M2, production build): **41–48% → 30–36%** total CPU, GPU process **22% →
15%**. It MUST stay transient: `onCanvasMoveEnd` removes the class 150 ms after the move settles so
text re-rasters sharp at the final scale — a permanent `will-change` on the viewport leaves every
terminal blurry after a zoom. `canvas/camera-moving.test.ts` pins both halves (the rule is scoped
to the class, and no bare `.react-flow__viewport` rule carries `will-change`).
