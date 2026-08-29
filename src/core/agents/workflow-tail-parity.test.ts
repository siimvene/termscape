// The Workflow tool spawns N agents IN-PROCESS with no per-agent hooks, so the workflow-agents
// tail is wired into the shells' RAW listeners (the same place SUBAGENT_TOOLS is handled), NOT into
// normalize.ts. That wiring must land on BOTH shells or the feature silently exists on only one —
// the exact class of bug hook-verified-parity.test.ts and hook-server signature changes keep
// re-teaching. This is a cheap source-level pin: if a future change wires one shell, it fails.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

describe('both shells wire the Workflow agents tail', () => {
  const root = resolve(__dirname, '../../..')
  const shells = ['src/main/index.ts', 'src/server/agent-status.ts']

  /** Source with comments removed, so a comment that merely mentions the tail (both shells carry
   *  explanatory ones) can never stand in for the real wiring. Same lexer-free strip, and the same
   *  blind spot, as hook-verified-parity.test.ts: a `//` inside a string literal truncates the line.
   *  If it ever matters, put the branch on its own line. */
  const code = (rel: string): string =>
    readFileSync(join(root, rel), 'utf8').replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')

  for (const rel of shells) {
    it(`${rel} creates and wires the workflow tail`, () => {
      const src = code(rel)
      expect(src, `${rel} does not create the workflow tail`).toMatch(/createWorkflowAgentsTail/)
      // begin/end bracket the watch; release tears it down on node teardown. All three or the
      // lifecycle is half-wired.
      expect(src, `${rel} never calls workflowTail.begin(`).toMatch(/workflowTail\.begin\(/)
      expect(src, `${rel} never calls workflowTail.end(`).toMatch(/workflowTail\.end\(/)
      expect(src, `${rel} never calls workflowTail.release(`).toMatch(/workflowTail\.release\(/)
      // Detection gates on the literal Workflow tool name in the raw listener (normalize.ts is
      // untouched and maps it to a generic 'working').
      expect(src, `${rel} does not gate on the 'Workflow' tool name`).toMatch(/===\s*'Workflow'/)
    })
  }
})
