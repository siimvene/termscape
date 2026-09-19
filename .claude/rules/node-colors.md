---
paths:
  - "src/shared/node-colors.ts"
  - "src/shared/node-colors.test.ts"
  - "src/renderer/components/NodeColorSwatches.tsx"
  - "src/renderer/components/NodeColorSwatches.guard.test.ts"
---
# Node colors (one palette, two sections)

`src/shared/node-colors.ts` is the palette AND the control boundary: the picker's list and the
allowlist `color --color C` validates against are the SAME array. Two sections — seven macOS **system**
colours, and an **agent** section (every builtin's brand colour from `AGENT_CONFIG` +
`FALLBACK_AGENT_COLOR`). The agent section exists because those colours were already on the canvas
(`createAgentNode` paints Claude `#d97757`), yet the picker could not offer one back and `color --color
'#d97757'` refused it — the app rejecting its own colour.

- **The agent section is DERIVED from `AGENT_CONFIG`, never re-typed.** `node-colors.test.ts` pins it
  three ways: every builtin colour is in `NODE_COLORS`, every swatch label is its agent's, no agent hex
  is a literal on a non-comment line.
- **`SYSTEM_NODE_COLORS` is the subset for surfaces that draw the value as TEXT or an opaque fill** —
  the accent, a project colour (tab label), a column colour (`ColumnPill` at 10px), and the auto-assign
  rotation for new frames/teams/columns. A measurement, not taste: on dark, white on gemini `#4285f4`
  is ~3.6:1 and grok `#64748b` ~4.0:1 (under the 4.5:1 floor for the 10.5px badge), grok grey as tab
  text ~2.6:1. Where the colour is a dot/border/wash, the FULL palette shows.
- **`resolveNodeColor` runs BEFORE the allowlist and only its output is persisted** — a palette name or
  hex (any case) → a canonical value or `undefined`. Names are accepted because opaque hexes taught
  nobody which was teal; a name resolves only to a value the allowlist already held and is never stored.
  `open-project --color` gets the same against the SYSTEM resolver (it used to reach `registerProject`
  unvalidated).
- **One component draws every picker** (`NodeColorSwatches.tsx`, since the palette now has headings +
  per-swatch names); `NodeColorSwatches.guard.test.ts` fails on a `.color-popover` it does not own or a
  renderer file mapping the palette itself.
- **Mobile keeps its OWN list** (`nodeterm-ios` hand-copies the agent colours in `NewSession.swift`,
  no picker) — the precedent for deriving the desktop half; a brand-colour change owes an iOS follow-up
  (@eneskirca).
