import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { readPeerMirror, readFreshPeerMirror, readPeerUsage, startPeerStatusBridge } from './peer-status-bridge'
import { IPC } from '../shared/ipc'
import { WORKING_STALE_MS } from '../shared/agents/stale'

function tmpMirror(nodes: Record<string, unknown>, usage?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-mirror-'))
  const file = path.join(dir, 'agent-status.json')
  fs.writeFileSync(file, JSON.stringify({ v: 1, updatedAt: 1, nodes, ...(usage ? { usage } : {}) }))
  return file
}

const stops: Array<() => void> = []
afterEach(() => {
  while (stops.length) stops.pop()!()
  vi.useRealTimers()
})

describe('readPeerMirror', () => {
  it('reads well-formed nodes and drops junk without throwing', () => {
    const file = tmpMirror({
      good: { state: 'working', agentId: 'claude', sessionId: 's1', name: 'N', updatedAt: 5 },
      badState: { state: 'jogging' },
      notObject: 42
    })
    const m = readPeerMirror(file)
    expect([...m.keys()]).toEqual(['good'])
    expect(m.get('good')).toEqual({
      state: 'working',
      agentId: 'claude',
      sessionId: 's1',
      name: 'N',
      updatedAt: 5
    })
  })

  it('absent or corrupt file → empty map', () => {
    expect(readPeerMirror('/nonexistent/nowhere.json').size).toBe(0)
    const file = tmpMirror({})
    fs.writeFileSync(file, '{not json')
    expect(readPeerMirror(file).size).toBe(0)
  })

  it('fresh snapshot carries approvals, strips question tickets, and drops stale working evidence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-fresh-'))
    const file = path.join(dir, 'agent-status.json')
    const now = Date.now()
    fs.writeFileSync(file, JSON.stringify({ v: 1, nodes: {
      approval: { state: 'blocked', agentId: 'codex', updatedAt: now },
      question: { state: 'waiting', agentId: 'claude', updatedAt: now },
      reused: { state: 'blocked', agentId: 'claude', sessionId: 'new', updatedAt: now },
      stale: { state: 'working', agentId: 'claude', updatedAt: now - 30 * 60_000 }
    }, inbox: { events: [
      { nodeId: 'approval', kind: 'approval', pendingId: 'ticket', resolved: false },
      { nodeId: 'question', kind: 'question', pendingId: 'must-not-forward', resolved: false },
      { nodeId: 'reused', sessionId: 'old', kind: 'approval', pendingId: 'old-ticket', resolved: false }
    ] } }))
    const snapshot = readFreshPeerMirror(file, now)
    expect(snapshot.get('approval')).toMatchObject({ askKind: 'approval', pendingId: 'ticket' })
    expect(snapshot.get('question')).toMatchObject({ askKind: 'question' })
    expect(snapshot.get('question')).not.toHaveProperty('pendingId')
    expect(snapshot.get('reused')).not.toHaveProperty('pendingId')
    expect(snapshot.get('reused')).not.toHaveProperty('askKind')
    expect(snapshot.has('stale')).toBe(false)
  })
})

describe('startPeerStatusBridge', () => {
  it('broadcasts each peer node once as a kind:state agent:status event', () => {
    const now = Date.now()
    const file = tmpMirror({
      a: { state: 'working', agentId: 'claude', sessionId: 's1', updatedAt: now },
      b: { state: 'done', agentId: 'claude', sessionId: 's2', name: 'Named', updatedAt: now }
    })
    const broadcast = vi.fn()
    stops.push(startPeerStatusBridge(file, { broadcast, ownState: () => undefined, watch: false }))
    expect(broadcast).toHaveBeenCalledTimes(2)
    const channels = broadcast.mock.calls.map((c) => c[0])
    expect(new Set(channels)).toEqual(new Set([IPC.agentStatus]))
    const evB = broadcast.mock.calls.map((c) => c[1]).find((e) => e.nodeId === 'b')
    expect(evB).toMatchObject({
      kind: 'state',
      state: 'done',
      sessionId: 's2',
      sessionTitle: 'Named'
    })
  })

  it("this instance's own live state wins: owned nodes are never re-broadcast", () => {
    const file = tmpMirror({
      mine: { state: 'done', updatedAt: Date.now() },
      theirs: { state: 'working', updatedAt: Date.now() }
    })
    const broadcast = vi.fn()
    stops.push(
      startPeerStatusBridge(file, {
        broadcast,
        ownState: (id) => (id === 'mine' ? 'working' : undefined),
        watch: false
      })
    )
    expect(broadcast.mock.calls.map((c) => c[1].nodeId)).toEqual(['theirs'])
  })

  it('change-gated: an unchanged tuple is not re-broadcast, a changed one is', async () => {
    const now = Date.now()
    const file = tmpMirror({ a: { state: 'working', updatedAt: now } })
    const broadcast = vi.fn()
    // watch:true — exercise the real directory watcher (mirror files land via atomic rename).
    stops.push(startPeerStatusBridge(file, { broadcast, ownState: () => undefined }))
    expect(broadcast).toHaveBeenCalledTimes(1)

    // Atomic-rename replace with the SAME tuple → watcher may fire, but nothing re-broadcasts.
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, nodes: { a: { state: 'working', updatedAt: now } } }))
    fs.renameSync(tmp, file)
    await vi.waitFor(() => expect(fs.existsSync(file)).toBe(true))
    await new Promise((r) => setTimeout(r, 150))
    expect(broadcast).toHaveBeenCalledTimes(1)

    // Changed state → exactly one more event.
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, nodes: { a: { state: 'done', updatedAt: now + 1 } } }))
    fs.renameSync(tmp, file)
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledTimes(2), { timeout: 3000 })
    expect(broadcast.mock.calls[1][1]).toMatchObject({ nodeId: 'a', state: 'done' })
  })

  it('never replays stale working evidence and expires a live Codex row with its own identity', () => {
    vi.useFakeTimers()
    const now = Date.now()
    const file = tmpMirror({
      stale: { state: 'working', updatedAt: now - WORKING_STALE_MS - 1 },
      live: { state: 'working', agentId: 'codex', updatedAt: now }
    })
    const broadcast = vi.fn()
    stops.push(startPeerStatusBridge(file, { broadcast, ownState: () => undefined, watch: false }))
    expect(broadcast.mock.calls.map((c) => c[1].nodeId)).toEqual(['live'])
    vi.advanceTimersByTime(WORKING_STALE_MS + 15_000)
    expect(broadcast.mock.calls.every((c) => c[1].nodeId === 'live')).toBe(true)
    expect(broadcast.mock.lastCall?.[1]).toMatchObject({
      nodeId: 'live', agentId: 'codex', kind: 'session', sessionPhase: 'end'
    })
    const count = broadcast.mock.calls.length
    vi.advanceTimersByTime(30_000)
    expect(broadcast).toHaveBeenCalledTimes(count)
  })

  it('does not clear a row when local hook state takes over from the peer', () => {
    vi.useFakeTimers()
    const file = tmpMirror({ a: { state: 'working', updatedAt: Date.now() } })
    const broadcast = vi.fn()
    let owned = false
    stops.push(startPeerStatusBridge(file, {
      broadcast, ownState: () => owned ? 'working' : undefined, watch: false
    }))
    owned = true
    vi.advanceTimersByTime(15_000)
    expect(broadcast).toHaveBeenCalledTimes(1)
  })
})

describe('readPeerUsage', () => {
  it('passes a well-formed usage block through, null when absent/malformed', () => {
    const withU = tmpMirror({}, { updatedAt: 9, accounts: [{ accountId: null, email: 'a@b', limits: [] }] })
    expect(readPeerUsage(withU)).toEqual({ updatedAt: 9, accounts: [{ accountId: null, email: 'a@b', limits: [] }] })
    expect(readPeerUsage(tmpMirror({}))).toBeNull()
    expect(readPeerUsage(tmpMirror({}, { accounts: 'nope' }))).toBeNull()
  })

  it('drops non-row entries, unknown fields and malformed limits, and bounds every string', () => {
    const long = 'x'.repeat(5000)
    const file = tmpMirror(
      {},
      {
        updatedAt: 3,
        accounts: [
          42,
          'nope',
          null,
          {
            accountId: 'cx1',
            label: long,
            email: 'e@x',
            agentId: 'codex',
            status: 'ok',
            updatedAt: 7,
            render: '<img onerror=1>',
            limits: [
              { kind: 'session', usedPercent: 40, group: 'session', scopeLabel: long, resetsAt: 1, isActive: true },
              { kind: 'weekly' }, // no usedPercent → dropped
              'junk',
              { kind: 'bad', usedPercent: Number.NaN }
            ]
          }
        ]
      }
    )
    const u = readPeerUsage(file)!
    expect(u.updatedAt).toBe(3)
    expect(u.accounts).toHaveLength(1)
    const row = u.accounts[0] as Record<string, unknown>
    expect(Object.keys(row).sort()).toEqual(
      ['accountId', 'agentId', 'email', 'label', 'limits', 'status', 'updatedAt'].sort()
    )
    expect((row.label as string).length).toBe(200)
    expect(row.limits).toEqual([
      { kind: 'session', usedPercent: 40, group: 'session', scopeLabel: 'x'.repeat(200), resetsAt: 1, isActive: true }
    ])
  })
})

describe('startPeerStatusBridge — usage', () => {
  it('broadcasts usage:update once on start and again only when updatedAt changes', () => {
    const file = tmpMirror({}, { updatedAt: 5, accounts: [] })
    const broadcast = vi.fn()
    stops.push(startPeerStatusBridge(file, { broadcast, ownState: () => undefined, watch: false }))
    const usageCalls = () => broadcast.mock.calls.filter((c) => c[0] === 'accounts:usage')
    expect(usageCalls().length).toBe(1)
    expect(usageCalls()[0][1]).toEqual({ updatedAt: 5, accounts: [] })
  })
})
