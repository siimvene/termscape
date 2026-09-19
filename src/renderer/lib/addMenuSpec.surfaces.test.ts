// Four-surface parity for the "add node" menus, pinned at SOURCE level.
//
// Why source level: three of the four surfaces are assembled inside `Canvas.tsx`, a file no unit
// test mounts, so the only thing a behavioural test could reach is the pure builder those call
// sites are supposed to use — and "is supposed to" is exactly the part that drifts. This repo has
// shipped a one-of-two-shells change three times (`hook-verified-parity.test.ts` exists for the
// same reason); the add menus have already drifted once, which is why `addMenuSpec` was created.
//
// What it does NOT claim: that the menus look right, or that a flyout opens. It claims that every
// surface still reads from the ONE spec, and that the two surfaces which deliberately do not are
// still deliberate.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..', '..')
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')

const CANVAS = read('renderer/canvas/Canvas.tsx')
const DOCK = read('renderer/components/Dock.tsx')
const KANBAN = read('renderer/components/kanban/KanbanView.tsx')

describe('add-menu surfaces', () => {
  // ── 1 + 2: the two ContextMenu surfaces render the GROUPED tree ──────────────────────────────
  it('builds the pane right-click AND the sidebar "+" from the same grouped builder', () => {
    const calls = CANVAS.match(/buildGroupedAddMenu\(/g) ?? []
    // One for `onPaneContextMenu`, one for `addToProject` (the sessions-sidebar project-header
    // "+"). If a third add surface appears in Canvas it should be here too — bump this with it.
    expect(calls.length).toBe(2)
  })

  it('leaves no flat content list behind in Canvas', () => {
    // The old shape was `const [terminalItem, ...restContent] = contentAddItemsToMenuItems(...)`,
    // splitting the canonical list POSITIONALLY around the agent block — which silently depended
    // on `terminal` being first in CONTENT_ADD_ITEMS. Both call sites moved to the grouped
    // builder; if one is ever reverted, this is what says so.
    expect(CANVAS).not.toContain('contentAddItemsToMenuItems')
    expect(CANVAS).not.toContain('restContent')
  })

  // ── 3: the group-frame menu shares the agent grouping ───────────────────────────────────────
  it('groups agents on the group-frame menu too, from the same helper', () => {
    expect(CANVAS).toContain('agentEntriesToMenuItems(agentCreationEntries(')
  })

  it('tags every agent row with its id, so nothing decides nesting from a hardcoded name', () => {
    expect(CANVAS).toContain('AgentAddEntry')
    // The pin that matters: Canvas must not re-implement `isPinnedAgentEntry`'s judgement by
    // spelling an agent id at the menu-assembly layer.
    expect(CANVAS).not.toContain('PINNED_AGENT')
  })

  // ── 4: the Dock is deliberately NOT grouped ─────────────────────────────────────────────────
  it('keeps the Dock on the flat row adapter — a decision, not an oversight', () => {
    expect(DOCK).toContain('contentAddItemsToDockRows')
    expect(DOCK).not.toContain('buildGroupedAddMenu')
  })

  // ── the kanban column "+ New session" is a different list, not a lagging copy ────────────────
  it('does not feed the kanban column menu from the content spec', () => {
    // `KanbanCreateChoice` is a closed union of the kinds that BECOME a card
    // (`canvas/toKanbanSession.ts`); the spec's list contains kinds the board can never show.
    // The module doc used to name this surface as a consumer — it never was.
    expect(KANBAN).not.toContain('CONTENT_ADD_ITEMS')
    expect(KANBAN).not.toContain('buildGroupedAddMenu')
  })
})
