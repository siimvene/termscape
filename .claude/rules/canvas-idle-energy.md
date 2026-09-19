---
paths:
  - "src/renderer/styles.css"
  - "src/renderer/lib/windowActivity.ts"
  - "src/renderer/lib/canvasCovered.ts"
  - "src/renderer/styles.animation-gate.test.ts"
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
