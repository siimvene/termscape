import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const TERMINAL_SRC = fs.readFileSync(path.join(__dirname, 'TerminalNode.tsx'), 'utf8')

describe('TerminalNode global kanban sizing', () => {
  it('parks the canvas size vote while the global kanban overlay is open', () => {
    const start = TERMINAL_SRC.indexOf('const boardOpen = useViewMode(')
    const end = TERMINAL_SRC.indexOf('const boardOpenRef', start)
    const boardOpen = TERMINAL_SRC.slice(start, end)

    // The modal is a co-attached viewer. If the hidden canvas node keeps voting, the PTY uses its
    // smaller grid (usually 80 columns) instead of the visible modal's measured width.
    expect(boardOpen).toContain('s.globalKanban')
    expect(boardOpen).toContain('omniKanbanEnabled')
  })
})
