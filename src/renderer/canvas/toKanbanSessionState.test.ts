import { describe, expect, it } from 'vitest'
import type { CanvasNodeState } from '@shared/types'
import { toKanbanSessionState } from './toKanbanSessionState'

function base(overrides: Partial<CanvasNodeState>): CanvasNodeState {
  return {
    id: 'n1',
    kind: 'terminal',
    position: { x: 0, y: 0 },
    size: { width: 100, height: 100 },
    title: 'hello',
    color: '#fff',
    group: null,
    ...overrides
  } as CanvasNodeState
}

describe('toKanbanSessionState', () => {
  it('returns null for non-card kinds', () => {
    expect(toKanbanSessionState(base({ kind: 'editor' as never, title: 'file' }))).toBeNull()
    expect(toKanbanSessionState(base({ kind: 'group' as never }))).toBeNull()
  })

  it('maps terminal nodes (persisted shape)', () => {
    const s = toKanbanSessionState(base({ kind: 'terminal', title: 'term', agentId: 'claude', shell: '/bin/zsh', cwd: '/tmp' }))!
    expect(s.kind).toBe('terminal')
    expect(s.title).toBe('term')
    expect(s.spawn.shell).toBe('/bin/zsh')
    expect(s.spawn.cwd).toBe('/tmp')
    expect(s.spawn.agentId).toBe('claude')
    expect(s.spawn.initialCommand).toBeUndefined()
  })

  it('does not carry pendingLaunch.command as initialCommand (DAG launch only)', () => {
    const s = toKanbanSessionState(
      base({ kind: 'terminal', pendingLaunch: { after: [], command: 'claude --resume' } })
    )!
    expect(s.spawn.initialCommand).toBeUndefined()
  })

  it('maps sticky notes with title derivation', () => {
    const s = toKanbanSessionState(base({ kind: 'sticky', text: '  hello world  \nsecond line' }))!
    expect(s.kind).toBe('sticky')
    expect(s.title).toBe('hello world')
    expect(s.text).toBe('  hello world  \nsecond line')
  })

  it('derives sticky title stripping markdown heading', () => {
    const s = toKanbanSessionState(base({ kind: 'sticky', text: '## Plan \nbody' }))!
    expect(s.title).toBe('Plan')
  })

  it('clamps sticky title at 80 chars', () => {
    const long = 'a'.repeat(100)
    const s = toKanbanSessionState(base({ kind: 'sticky', text: long }))!
    expect(s.title!.length).toBe(80)
  })

  it('falls back to Note for empty sticky', () => {
    const s = toKanbanSessionState(base({ kind: 'sticky', text: '   ' }))!
    expect(s.title).toBe('Note')
  })

  it('maps browser nodes', () => {
    const s = toKanbanSessionState(base({ kind: 'browser', title: '', url: 'https://example.com', partition: 'persist:foo' }))!
    expect(s.kind).toBe('browser')
    expect(s.title).toBe('Browser')
    expect(s.url).toBe('https://example.com')
    expect(s.partition).toBe('persist:foo')
  })

  it('preserves browser title when present', () => {
    const s = toKanbanSessionState(base({ kind: 'browser', title: 'My site', url: 'https://example.com' }))!
    expect(s.title).toBe('My site')
  })
})
