// Codex goal-mode subagents fire no hooks; their lifecycle is sniffed from the parent rollout via
// the codex context tail's `onLines` and fed to the codex agents tail — wiring that lives in the
// shells, NOT in normalize.ts. It must land on BOTH shells or the feature silently exists on only
// one — the exact class of bug hook-verified-parity.test.ts and workflow-tail-parity.test.ts keep
// re-teaching. Same cheap source-level pin: if a future change wires one shell, it fails.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

describe('both shells wire the codex agents tail', () => {
  const root = resolve(__dirname, '../../..')
  const shells = ['src/main/index.ts', 'src/server/agent-status.ts']

  /** Source with comments removed — a comment mentioning the tail must never stand in for the
   *  wiring. Same lexer-free strip, and the same blind spot, as its sibling parity tests: a `//`
   *  inside a string literal truncates the line. If it ever matters, put the call on its own line. */
  const code = (rel: string): string =>
    readFileSync(join(root, rel), 'utf8').replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')

  for (const rel of shells) {
    it(`${rel} creates and wires the codex agents tail`, () => {
      const src = code(rel)
      expect(src, `${rel} does not create the codex agents tail`).toMatch(/createCodexAgentsTail/)
      // The sniffer is the whole trigger: the codex context tail must pass onLines through
      // parseCodexSubagentActivity, and route both lifecycle kinds into the tail.
      expect(src, `${rel} never sniffs SubAgentActivity`).toMatch(/parseCodexSubagentActivity/)
      // The FIRST onLines delivery is a historical replay — without this reconcile every parent
      // resume resurrects its finished children as stale cards.
      expect(src, `${rel} does not reconcile the initial replay`).toMatch(/liveCodexSubagentActivities/)
      expect(src, `${rel} never calls codexAgentsTail.started(`).toMatch(/codexAgentsTail\.started\(/)
      expect(src, `${rel} never calls codexAgentsTail.completed(`).toMatch(/codexAgentsTail\.completed\(/)
      // release on node teardown, or a dead node's children keep polling forever.
      expect(src, `${rel} never calls codexAgentsTail.release(`).toMatch(/codexAgentsTail\.release\(/)
    })
  }
})
