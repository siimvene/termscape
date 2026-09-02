import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for the fork's held-launch CONSENT model where it meets the two React components
 * (same class as `pending-launch-delivery.source.test.ts`, and for the same reason: no unit seam
 * inside Canvas / TerminalNode). The decisions are proven on the pure registry in
 * `lib/pendingLaunch.test.ts`; what only the source can state is that every path that can send a
 * launch claims through the SHARED registry, settles through the key-checked settle (including on a
 * REJECTED rpc), and that every path that removes a node also revokes this process's consent for it.
 *
 * Consort review of the v0.3.5 merge (2026-09-02): three SERIOUS findings on the ▶ / fire-effect
 * pair (independent latches ⇒ double submit; settle by node id ⇒ a peer's replacement launch
 * cleared or failed; no rejection handler ⇒ wedged latch) and two from the blind security pass
 * (consent surviving node removal; consent surviving backoff exhaustion).
 */
const canvas = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8')
const node = readFileSync(new URL('../nodes/TerminalNode.tsx', import.meta.url), 'utf8')

/** From `const deleteNodes = useCallback(` to the start of the record branch. */
function deleteNodesHead(): string {
  const start = canvas.indexOf('const deleteNodes = useCallback(')
  expect(start).toBeGreaterThan(-1)
  return canvas.slice(start, start + 1200)
}

describe('▶ Run now (TerminalNode) — shared claim, key-checked settle, rejection handled', () => {
  it('claims through beginLaunch — no component-local latch — and revokes consent before the send', () => {
    expect(node).toMatch(
      /const sentKey = beginLaunch\(id, pendingLaunch\)\s*\n\s*if \(sentKey === null\) return\s*\n\s*forgetArmed\(id\)/
    )
    expect(node).not.toContain('runNowInFlight')
  })

  it('settles against the launch the node holds NOW, read fresh off the flow store', () => {
    expect(node).toMatch(/getNode\(id\) as CanvasNode \| undefined\)\?\.data\.pendingLaunch/)
    expect(node).toContain("if (settleLaunch(id, sentKey, ok, currentLaunch()) === 'stale') return")
  })

  it('a rejected rpc takes the refusal path: claim released, launch kept, badge warned', () => {
    // The second `.then` handler. Without it a relay close (`failPending()`) left the claim set
    // forever and ▶ dead until remount.
    expect(node).toMatch(
      /\(\) => \{[\s\S]{0,600}?if \(settleLaunch\(id, sentKey, false, currentLaunch\(\)\) === 'refused'\)\s*\n\s*useLaunchDelivery\.getState\(\)\.markFailed\(id, 1\)/
    )
  })
})

describe('consent ends with the node — every removal path calls forgetArmed', () => {
  it('local delete (deleteNodes)', () => {
    expect(deleteNodesHead()).toMatch(
      /autoCloseArmedRef\.current\.delete\(id\)\s*\n\s*autoCloseReadRef\.current\.delete\(id\)\s*\n\s*forgetArmed\(id\)/
    )
  })

  it('React Flow’s own remove change (handleNodesChange)', () => {
    expect(canvas).toMatch(/if \(c\.type === 'remove'\) \{[\s\S]{0,200}?forgetArmed\(c\.id\)/)
  })

  it('a peer’s remove mutation, on the active project AND on a background one', () => {
    // Two branches, two pins: a cold-open arming lives in exactly the background-project branch.
    expect(canvas.match(/forgetArmed\(mutation\.id\)/g)?.length).toBe(2)
    expect(canvas).toMatch(
      /if \(mutation\.op === 'remove'\) \{[\s\S]{0,700}?forgetArmed\(mutation\.id\)[\s\S]{0,300}?applyNodeMutation\(projectId, mutation\)/
    )
    expect(canvas).toMatch(
      /const gone = nodesRef\.current\.find\(\(n\) => n\.id === mutation\.id\)[\s\S]{0,800}?forgetArmed\(mutation\.id\)/
    )
  })

  it('closing a project (its nodes come back from the git-shared file as LOADED launches)', () => {
    expect(canvas).toMatch(
      /const performCloseProject = useCallback\([\s\S]{0,900}?for \(const n of store\.getProject\(id\)\?\.nodes \?\? \[\]\) forgetArmed\(n\.id\)/
    )
  })
})
