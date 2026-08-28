import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { readPeerMirror, readPeerUsage, startPeerStatusBridge } from './peer-status-bridge'
import { IPC } from '../shared/ipc'

function tmpMirror(nodes: Record<string, unknown>, usage?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-mirror-'))
  const file = path.join(dir, 'agent-status.json')
  fs.writeFileSync(file, JSON.stringify({ v: 1, updatedAt: 1, nodes, ...(usage ? { usage } : {}) }))
  return file
}

const stops: Array<() => void> = []
afterEach(() => {
  while (stops.length) stops.pop()!()
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
})

describe('startPeerStatusBridge', () => {
  it('broadcasts each peer node once as a kind:state agent:status event', () => {
    const file = tmpMirror({
      a: { state: 'working', agentId: 'claude', sessionId: 's1', updatedAt: 1 },
      b: { state: 'done', agentId: 'claude', sessionId: 's2', name: 'Named', updatedAt: 2 }
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
      mine: { state: 'done', updatedAt: 1 },
      theirs: { state: 'working', updatedAt: 1 }
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
    const file = tmpMirror({ a: { state: 'working', updatedAt: 1 } })
    const broadcast = vi.fn()
    // watch:true — exercise the real directory watcher (mirror files land via atomic rename).
    stops.push(startPeerStatusBridge(file, { broadcast, ownState: () => undefined }))
    expect(broadcast).toHaveBeenCalledTimes(1)

    // Atomic-rename replace with the SAME tuple → watcher may fire, but nothing re-broadcasts.
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, nodes: { a: { state: 'working', updatedAt: 1 } } }))
    fs.renameSync(tmp, file)
    await vi.waitFor(() => expect(fs.existsSync(file)).toBe(true))
    await new Promise((r) => setTimeout(r, 150))
    expect(broadcast).toHaveBeenCalledTimes(1)

    // Changed state → exactly one more event.
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, nodes: { a: { state: 'done', updatedAt: 2 } } }))
    fs.renameSync(tmp, file)
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledTimes(2), { timeout: 3000 })
    expect(broadcast.mock.calls[1][1]).toMatchObject({ nodeId: 'a', state: 'done' })
  })
})

describe('readPeerUsage', () => {
  it('passes a well-formed usage block through, null when absent/malformed', () => {
    const withU = tmpMirror({}, { updatedAt: 9, accounts: [{ accountId: null, email: 'a@b', limits: [] }] })
    expect(readPeerUsage(withU)).toEqual({ updatedAt: 9, accounts: [{ accountId: null, email: 'a@b', limits: [] }] })
    expect(readPeerUsage(tmpMirror({}))).toBeNull()
    expect(readPeerUsage(tmpMirror({}, { accounts: 'nope' }))).toBeNull()
  })
})

describe('startPeerStatusBridge — usage', () => {
  it('broadcasts usage:update once on start and again only when updatedAt changes', () => {
    const file = tmpMirror({}, { updatedAt: 5, accounts: [] })
    const broadcast = vi.fn()
    stops.push(startPeerStatusBridge(file, { broadcast, ownState: () => undefined, watch: false }))
    const usageCalls = () => broadcast.mock.calls.filter((c) => c[0] === 'usage:update')
    expect(usageCalls().length).toBe(1)
    expect(usageCalls()[0][1]).toEqual({ updatedAt: 5, accounts: [] })
  })
})
