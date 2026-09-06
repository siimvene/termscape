// The mirror's disk writes are serialized PER PATH. Overlapping flushes (an agent event, a usage poll
// and a provider run landing within one tick) build their docs in issue order, but `writeFileAtomic`
// uses a unique temp per call and the last RENAME wins whatever the issue order — so without the
// chain an older, usage-less doc could land over a fresher one. `writeFileAtomic` is mocked here with
// hand-resolved promises so the ORDER is asserted, not inferred from a race that usually goes right.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

type PendingWrite = { file: string; data: string; resolve: () => void; reject: (e: Error) => void }
const { writes } = vi.hoisted(() => ({ writes: [] as PendingWrite[] }))

vi.mock('./fs-atomic', () => ({
  writeFileAtomic: vi.fn(
    (file: string, data: string) =>
      new Promise<void>((resolve, reject) => {
        writes.push({ file, data, resolve, reject })
      })
  ),
  renameAtomic: vi.fn()
}))

import { _resetForTest, flush, initAgentStatusMirror, setMirrorUsageProvider } from './agent-status-mirror'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const stamp = (w: PendingWrite): number => JSON.parse(w.data).usage.updatedAt

describe('mirror disk writes are serialized per path', () => {
  let tmpDir: string

  beforeEach(() => {
    _resetForTest()
    writes.length = 0
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-write-order-'))
    initAgentStatusMirror(path.join(tmpDir, 'status.json'))
    // Each flush builds a doc stamped with the order it was issued in.
    let seq = 0
    setMirrorUsageProvider(() => ({
      updatedAt: ++seq,
      accounts: [
        { accountId: null, label: null, email: null, agentId: 'claude', status: 'ok', updatedAt: seq, limits: [] }
      ]
    }))
  })
  afterEach(() => {
    _resetForTest()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('a write does not START until the previous one has settled, and lands in issue order', async () => {
    const f1 = flush()
    const f2 = flush()
    const f3 = flush()
    await tick()
    // Three docs were built; only the FIRST write is on the wire.
    expect(writes).toHaveLength(1)
    expect(stamp(writes[0])).toBe(1)

    writes[0].resolve()
    await tick()
    expect(writes).toHaveLength(2)
    expect(stamp(writes[1])).toBe(2)

    writes[1].resolve()
    await tick()
    expect(writes).toHaveLength(3)
    expect(stamp(writes[2])).toBe(3)

    writes[2].resolve()
    await Promise.all([f1, f2, f3])
    // The doc built LAST is the one that ends on disk.
    expect(writes.map(stamp)).toEqual([1, 2, 3])
  })

  it('a FAILED write does not stall the writes queued behind it', async () => {
    const f1 = flush()
    const f2 = flush()
    await tick()
    expect(writes).toHaveLength(1)

    writes[0].reject(new Error('EPERM'))
    await tick()
    // flush #1 resolved (best-effort, as before) and flush #2's write went out.
    await expect(f1).resolves.toBeUndefined()
    expect(writes).toHaveLength(2)
    expect(stamp(writes[1])).toBe(2)

    writes[1].resolve()
    await expect(f2).resolves.toBeUndefined()
  })
})
