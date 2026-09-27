---
paths:
  - "src/renderer/styles.css"
  - "src/renderer/styles.palette.test.ts"
  - "src/renderer/lib/palette.ts"
  - "src/renderer/lib/gitStatusColors.ts"
---
# Semantic colours (one role per meaning)

> Folded from upstream's single `CLAUDE.md` at the v0.3.16 merge (2026-09-27), text verbatim (see the
> root's "How this documentation is organized" section). Loads automatically when a file matching the
> `paths` above is read; when the root routing table points here, read this file before touching the
> subsystem.
<!-- moved-verbatim-from: CLAUDE.md (upstream v0.3.16) -->

Status and accent colours are TOKENS in `styles.css`, never hues at a call site. Two layers:
the Apple system palette `--sys-red … --sys-gray` (dark values in `:root`, light values in the light
block) and the ROLES that rules actually name — `--state-working | attention | unread | error |
success | warning | queued | automation` and `--git-modified | added | deleted | renamed |
conflict`. A role is a FILL value (glow, dot, stroke, and chip washes via
`color-mix(in srgb, var(--state-x) N%, transparent)`); text in a status hue keeps the text-safe
tokens `--danger --warn --caution --success --agent-working`, which the light theme darkens.

- **An appearance re-maps a MEANING by redefining a role**, not by restyling rules. The default look
  keeps its historical hues (working clay, unread = accent, attention red, warning orange); Liquid
  Glass maps them to the HIG semantics (see `.claude/rules/appearance-wallpaper-glass.md`).
- **JS that needs a literal** (xterm find decorations, canvas-drawn sprites, the notch HUD, which does
  not load styles.css) reads `renderer/lib/palette.ts`; `styles.palette.test.ts` pins `--sys-*` to
  that table. JS that styles the DOM passes `'var(--role)'` strings (the minimap strokes, the git
  status letters, kanban priorities). Hex-with-alpha suffixes (`${c}2e`) do not work on a var —
  use `color-mix`.
- **Git status colours have ONE table**, `renderer/lib/gitStatusColors.ts`, used by Source Control
  and the history commit list; an unknown status draws in `--text`.
- **Minimap strokes are their own tokens, `--mm-working|attention|unread`.** The default look keeps
  its map language exactly (amber working, red needs-you, CLAY unread) on purpose: an uncoloured
  node's fallback stroke is the accent blue, so an accent "unread" would vanish into the map (the
  comment on `nodeStrokeColor` in Canvas.tsx). Under Liquid Glass the tokens map to the state roles,
  since node fills there are neutral ink and nothing can clash. The palette test pins both.
- **Left as-is on purpose:** agent brand colours (`AGENT_CONFIG`) on Claude-identity surfaces (the
  subagent node, the usage pill icon, the mascot), the node colour swatches (`node-colors.ts` is an
  allowlist — stored project colours must stay valid), node-kind default colours (persisted into
  project files at creation), kanban label chips (own palette), presence colours, the onboarding
  scenes, the notch HUD's own stylesheet.
