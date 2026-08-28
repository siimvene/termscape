import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SessionRow } from './SessionRow'
import type { SessionRowVM } from '../lib/sessionList'

const row: SessionRowVM = {
  id: 'nt-1',
  title: 'Investigate status',
  color: '#888',
  isAgent: true,
  statusKind: 'attention',
  stateLabel: 'Waiting for your response',
  statusUpdatedAt: 1,
  unread: false,
  usesContext: false,
  selected: false,
  projectId: 'p1',
  projectName: 'Project',
  projectColor: '#123'
}

describe('SessionRow status age', () => {
  it('renders the relative state age supplied by status-group mode', () => {
    const html = renderToStaticMarkup(
      <SessionRow
        row={row}
        stateAgeLabel="5m ago"
        onClick={vi.fn()}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onAiName={vi.fn()}
        onContextMenu={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />
    )

    expect(html).toContain('5m ago')
    expect(html).toContain('Entered this state 5m ago')
  })
})

/**
 * `.ss-row.is-active` shipped in the stylesheet with NOTHING ever setting the class, so the list
 * silently never marked the selected session while looking implemented to anyone who grepped the
 * CSS. That failure is invisible to a test that only checks one direction — a permanently-false
 * (or inverted) `selected` renders perfectly valid markup — so both directions are asserted here.
 */
describe('SessionRow selection', () => {
  const render = (selected: boolean): string =>
    renderToStaticMarkup(
      <SessionRow
        row={{ ...row, selected }}
        onClick={vi.fn()}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onAiName={vi.fn()}
        onContextMenu={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />
    )

  it('marks the row active when the node is selected on the canvas', () => {
    expect(render(true)).toContain('ss-row is-active')
  })

  it('leaves an unselected row unmarked', () => {
    expect(render(false)).not.toContain('is-active')
  })
})
