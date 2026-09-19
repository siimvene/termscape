import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for the canvas-control confirm's "Don't ask again" SCOPE — the checkbox that now
 * offers "while nodeterm is running" or "always in this project".
 *
 * Source-level for the usual reason: the dialog is built inline in a 14,000-line component's render
 * and the grant happens in its `onConfirm`, neither of which has a unit seam. The BEHAVIOUR of both
 * halves is proven against real primitives elsewhere — the decision table in
 * `shared/control-confirm.test.ts`, the store write in `state/controlConfirmGate.test.ts`, the
 * Settings row in `AgentsSection.controlConfirm.test.tsx`. What is pinned here is the wiring
 * between them, where a mistake is silent: a waiver granted for the wrong project, granted on a
 * DENIAL, or carried over from the previous dialog.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** How many times a literal appears. Deliberately NOT a regex: the needles here carry `.` and `?`,
 *  and hand-escaping a literal into a pattern is the idiom that quietly drops a character nobody
 *  thought to list (CodeQL's js/incomplete-sanitization caught exactly that here — `\` was missing).
 *  Counting with `split` asks no escaping question at all. */
function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/** The control confirm's dialog element, from its option block to its `onCancel`. */
function dialogBody(): string {
  const start = src.indexOf('confirm.waiveVerb\n              ? {')
  expect(start, 'the waive option').toBeGreaterThan(-1)
  const end = src.indexOf('onCancel={() => {', start)
  expect(end, 'the cancel handler after it').toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('the "Don’t ask again" scope (source pins)', () => {
  it('defaults to the app-run waiver — the pre-existing, bounded behaviour', () => {
    // A dialog that appeared under the user's hands must not pre-select the durable grant. Ticking
    // and clicking through has to buy exactly what it always bought.
    expect(src).toContain(
      "const [controlWaiveScope, setControlWaiveScope] = useState<'session' | 'project'>('session')"
    )
  })

  it('resets BOTH the tick and the scope every time the dispatch raises one', () => {
    // A scope carried over from the previous dialog would grant a durable, project-scoped waiver
    // to a user who only meant to tick the box this time. Both destructive cases must reset both.
    const resets = [...src.matchAll(/setControlWaive\(false\)\n\s*setControlWaiveScope\('session'\)/g)]
    expect(resets.length, 'write and close both reset both').toBe(2)
    // …and no case resets only one of the two.
    const lone = [...src.matchAll(/setControlWaive\(false\)(?!\n\s*setControlWaiveScope)/g)]
    expect(lone.length, 'every setControlWaive(false) is followed by a scope reset').toBe(0)
  })

  it('offers the project by NAME, not as "this project"', () => {
    // Canvas control answers a background agent in its OWN project without moving the user's tab,
    // so "this project" would name whatever they happen to be looking at while the waiver landed
    // somewhere else. The fallback wording is only for a call whose project could not be resolved.
    const body = dialogBody()
    expect(body).toContain('confirm.waiveProjectName')
    expect(body).toMatch(/Always in "\$\{confirm\.waiveProjectName\}"/)
  })

  it('grants on CONFIRM only — a denial must never widen anything', () => {
    const start = src.indexOf('onConfirm={() => {', src.indexOf('confirm.waiveVerb\n              ? {'))
    const end = src.indexOf('onCancel={() => {', start)
    const onConfirm = src.slice(start, end)
    const onCancel = src.slice(end, src.indexOf('/>', end))
    expect(onConfirm).toContain('waiveControlConfirmForProject(confirm.waiveVerb, confirm.waiveProjectId)')
    expect(onConfirm).toContain('waiveForSession(confirm.waiveVerb)')
    // Nothing that grants anything may appear on the cancel path.
    expect(onCancel).not.toContain('waiveControlConfirmForProject')
    expect(onCancel).not.toContain('waiveForSession')
  })

  it('the durable grant uses the CALLER’s project id, never the active one', () => {
    // `waiveProjectId` is set from `ctlProject`, which is the source's project. Reading
    // `activeProjectId` at the grant site would waive the confirm in the project the human is
    // looking at — a waiver in the wrong repo, which is the exact failure this scope prevents.
    const onConfirm = src.slice(
      src.indexOf('onConfirm={() => {', src.indexOf('confirm.waiveVerb\n              ? {')),
      src.indexOf('onCancel={() => {', src.indexOf('confirm.waiveVerb\n              ? {'))
    )
    expect(onConfirm).not.toContain('activeProjectId')
    for (const field of ['waiveProjectId: ctlProject?.id', 'waiveProjectName: ctlProject?.name']) {
      expect(countOf(src, field), field).toBe(2)
    }
  })

  it('a failed durable grant falls back to the app-run waiver, never to nothing', () => {
    // `waiveControlConfirmForProject` returns false when no project owns the call. Losing the tick
    // there would silently give the user nothing for a box they ticked — and they would find out
    // by being asked again on the very next call.
    const onConfirm = src.slice(
      src.indexOf('onConfirm={() => {', src.indexOf('confirm.waiveVerb\n              ? {')),
      src.indexOf('onCancel={() => {', src.indexOf('confirm.waiveVerb\n              ? {'))
    )
    expect(onConfirm).toMatch(/if \(!scoped\) useControlConfirm\.getState\(\)\.waiveForSession/)
  })

  it('the gate is asked about the CALLER’s project, in both destructive cases', () => {
    // The per-project waiver AND the permission mode the bypass lock reads both belong to the
    // project the call acts on. Off canvas that is not the active one.
    expect(countOf(src, 'controlConfirmDecision(verb, ctlProject?.id)')).toBe(2)
    expect(src).not.toMatch(/controlConfirmDecision\(verb\)/)
  })

  it('the waived NOTICE names the project, in both cases', () => {
    // Losing the dialog must not mean losing the record, and "which waiver let this through" is
    // the part of the record that lets a user revoke the right one.
    expect(countOf(src, 'waivedNotice(')).toBe(2)
    expect(
      countOf(src, 'ctlProject?.name\n                )'),
      'both notices pass the project name'
    ).toBe(2)
  })
})
