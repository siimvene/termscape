import { describe, it, expect } from 'vitest'
import { waitForSystemAccountChange } from './systemAccountSwitch'

/** Deterministic clock: each `sleep` advances `t` by the requested ms. */
function clock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0
  return { now: () => t, sleep: async (ms) => void (t += ms) }
}

describe('waitForSystemAccountChange', () => {
  it('resolves "changed" once the resolved email differs from the one shown at click time', async () => {
    const answers = ['old@x.test', 'old@x.test', 'new@x.test']
    const r = await waitForSystemAccountChange({
      readEmail: async () => answers.shift() ?? 'new@x.test',
      before: 'old@x.test',
      intervalMs: 10,
      timeoutMs: 1000,
      ...clock()
    })
    expect(r).toBe('changed')
    expect(answers).toEqual([])
  })

  it('does NOT resolve off the identity already shown — an already-logged-in machine is not a capture', async () => {
    let reads = 0
    const r = await waitForSystemAccountChange({
      readEmail: async () => (reads++, 'same@x.test'),
      before: 'same@x.test',
      intervalMs: 100,
      timeoutMs: 300,
      ...clock()
    })
    expect(r).toBe('unchanged')
    expect(reads).toBe(3)
  })

  it('treats a null answer as "no login yet", and a thrown refresh as the same', async () => {
    const answers: Array<() => Promise<string | null>> = [
      async () => null,
      async () => {
        throw new Error('offline')
      },
      async () => 'who@x.test'
    ]
    const r = await waitForSystemAccountChange({
      readEmail: () => (answers.shift() ?? (async () => 'who@x.test'))(),
      before: null,
      intervalMs: 10,
      timeoutMs: 1000,
      ...clock()
    })
    expect(r).toBe('changed')
  })
})
