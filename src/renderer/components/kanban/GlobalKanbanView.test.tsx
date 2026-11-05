import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const GLOBAL_KANBAN_SRC = fs.readFileSync(path.join(__dirname, 'GlobalKanbanView.tsx'), 'utf8')

describe('global kanban swimlane collapse wiring', () => {
  it('toggles the lane body from its header', () => {
    expect(GLOBAL_KANBAN_SRC).toContain('const [collapsed, setCollapsed] = useState(false)')
    expect(GLOBAL_KANBAN_SRC).toContain('onClick={toggleCollapsed}')
    expect(GLOBAL_KANBAN_SRC).toContain('aria-expanded={!collapsed}')
    expect(GLOBAL_KANBAN_SRC).toContain('setCollapsed((value) => !value)')
    expect(GLOBAL_KANBAN_SRC).toContain('{!collapsed && (')
  })
})

describe('global kanban card read state', () => {
  it('clears the unread dot when a card opens, like the per-project board', () => {
    expect(GLOBAL_KANBAN_SRC).toContain("import { useAgentStatus } from '../../state/agentStatus'")
    expect(GLOBAL_KANBAN_SRC).toContain('if (modalNodeId) useAgentStatus.getState().clearUnread(modalNodeId)')
  })
})
