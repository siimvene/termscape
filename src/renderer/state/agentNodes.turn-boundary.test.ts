// Issue #547 — the turn boundary must not take a subagent that is still running with it.
//
// `clearForParent` ran on every new turn on the assumption that the previous fan-out is stale by
// definition. That is true of a FINISHED card and false of a working one: Claude launches subagents
// async, and "waiting for N background agents to finish" is exactly the state in which the next
// prompt gets typed. Nothing rehydrates `byId` afterwards — `start()` fires only from a live
// `PreToolUse` and a subagent past that emits no second one — so the card was gone for the rest of
// the run while the agent kept working.
//
// The more expensive half is the Eco consequence, which is why `buildHibernationCandidates` is
// exercised here rather than left to the store test above it: the guard's evidence ("any card that
// has not finished pins its parent") is derived from this same store, so the wipe let a parent with
// live background agents read as idle and get its CLI `/exit`ed.
import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentNodes } from './agentNodes'
import { buildHibernationCandidates } from '../lib/hibernationCandidates'
import { FANOUT_COMPACT_THRESHOLD } from '../lib/fanoutGroup'
import { WORKING_STALE_MS } from '@shared/agents/stale'

const reset = (): void => {
  useAgentNodes.setState({
    byId: {},
    activityById: {},
    positions: {},
    sizes: {},
    expanded: {},
    selectedId: null
  })
}

describe('clearFinishedForParent — the turn boundary (issue #547)', () => {
  beforeEach(reset)

  it('keeps a card whose subagent is still working', () => {
    const s = useAgentNodes.getState()
    s.start('tu-running', { parentNodeId: 'n1', label: 'audit the parser' })
    s.clearFinishedForParent('n1')
    expect(useAgentNodes.getState().byId['tu-running']?.state).toBe('working')
  })

  it('drops the finished ones in the same pass', () => {
    const s = useAgentNodes.getState()
    s.start('tu-done', { parentNodeId: 'n1' })
    s.start('tu-running', { parentNodeId: 'n1' })
    s.finish('tu-done', { tokens: 10 })
    s.clearFinishedForParent('n1')
    const { byId } = useAgentNodes.getState()
    expect(Object.keys(byId)).toEqual(['tu-running'])
  })

  it('takes the dropped card’s overrides and leaves the kept card’s alone', () => {
    const s = useAgentNodes.getState()
    s.start('tu-done', { parentNodeId: 'n1' })
    s.start('tu-running', { parentNodeId: 'n1' })
    s.finish('tu-done', {})
    s.setPosition('tu-done', { x: 1, y: 1 })
    s.setPosition('tu-running', { x: 2, y: 2 })
    s.appendActivity('tu-running', 'still going')
    s.clearFinishedForParent('n1')
    const st = useAgentNodes.getState()
    expect(st.positions['tu-done']).toBeUndefined()
    expect(st.positions['tu-running']).toEqual({ x: 2, y: 2 })
    expect(st.activityById['tu-running']).toBe('still going')
  })

  it('touches no other parent', () => {
    const s = useAgentNodes.getState()
    s.start('tu-a', { parentNodeId: 'n1' })
    s.start('tu-b', { parentNodeId: 'n2' })
    s.finish('tu-b', {})
    s.clearFinishedForParent('n1')
    expect(useAgentNodes.getState().byId['tu-b']).toBeDefined()
  })

  it('a kept card still accepts its late finish()', () => {
    // The #402 property this rests on: `finish()` must land on an entry that was KEPT rather than
    // cleared. If the card had been dropped, the end event would have nothing to write to.
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    s.clearFinishedForParent('n1')
    useAgentNodes.getState().finish('tu1', { tokens: 42 })
    expect(useAgentNodes.getState().byId['tu1']).toMatchObject({ state: 'done', tokens: 42 })
  })

  it('clearForParent is still unconditional — the removal paths lose nothing', () => {
    // deleteNodes / deleteProject / the cross-project close / the orphan kill / SessionEnd: the node
    // is gone, so there is no work left to represent.
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    s.clearForParent('n1')
    expect(useAgentNodes.getState().byId['tu1']).toBeUndefined()
  })

  it('the selection follows the card that was actually dropped', () => {
    const s = useAgentNodes.getState()
    s.start('tu-done', { parentNodeId: 'n1' })
    s.start('tu-running', { parentNodeId: 'n1' })
    s.finish('tu-done', {})
    s.select('tu-running')
    s.clearFinishedForParent('n1')
    expect(useAgentNodes.getState().selectedId).toBe('tu-running')
    useAgentNodes.getState().finish('tu-running', {})
    useAgentNodes.getState().clearFinishedForParent('n1')
    expect(useAgentNodes.getState().selectedId).toBeNull()
  })
})

describe('clearFinishedForParent — the aggregate fan-out card follows the threshold, not only "all done"', () => {
  // Canvas collapses MORE THAN FANOUT_COMPACT_THRESHOLD live cards into one `fanout-<pid>` card and
  // draws fewer individually (lib/fanoutGroup). The aggregate's overrides used to be dropped only
  // when EVERY card had finished, so a fan-out that shrank from 7 to 1 stopped rendering the
  // aggregate while its dragged position/size/expansion/selection sat unseen — and resurrected on
  // the next turn that grew past the threshold (consort review MINOR, 2026-09-02).
  beforeEach(reset)
  const fanOut = (n: number): void => {
    const s = useAgentNodes.getState()
    for (let i = 0; i < n; i++) s.start(`tu${i}`, { parentNodeId: 'n1' })
    s.setPosition('fanout-n1', { x: 3, y: 4 })
    s.setSize('fanout-n1', { width: 360, height: 480 })
    s.toggleExpanded('fanout-n1')
    s.select('fanout-n1')
  }
  const aggregateState = () => {
    const st = useAgentNodes.getState()
    return {
      pos: st.positions['fanout-n1'],
      size: st.sizes['fanout-n1'],
      expanded: st.expanded['fanout-n1'],
      selected: st.selectedId === 'fanout-n1'
    }
  }

  it('drops the aggregate once the survivors no longer render as one card', () => {
    fanOut(FANOUT_COMPACT_THRESHOLD + 1) // 7: compact
    const s = useAgentNodes.getState()
    for (let i = 0; i < FANOUT_COMPACT_THRESHOLD; i++) s.finish(`tu${i}`, {}) // 6 done, 1 working
    s.clearFinishedForParent('n1')
    expect(Object.keys(useAgentNodes.getState().byId)).toEqual([`tu${FANOUT_COMPACT_THRESHOLD}`])
    expect(aggregateState()).toEqual({ pos: undefined, size: undefined, expanded: undefined, selected: false })
  })

  it('keeps the aggregate while the survivors are still a compact fan-out', () => {
    fanOut(FANOUT_COMPACT_THRESHOLD + 2) // 8
    useAgentNodes.getState().finish('tu0', {}) // 7 still working: aggregate still on screen
    useAgentNodes.getState().clearFinishedForParent('n1')
    expect(Object.keys(useAgentNodes.getState().byId)).toHaveLength(FANOUT_COMPACT_THRESHOLD + 1)
    expect(aggregateState()).toEqual({
      pos: { x: 3, y: 4 },
      size: { width: 360, height: 480 },
      expanded: true,
      selected: true
    })
  })
})

describe('sweepStaleWorking — the decay a kept card owes', () => {
  beforeEach(reset)

  it('marks a card working past WORKING_STALE_MS as done', () => {
    // Required, not optional: a subagent whose end never arrives (crashed CLI, killed pane, slept
    // machine) would otherwise pin its card — and its parent, against Eco — forever, which is worse
    // than the bug being fixed.
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    const startedAt = useAgentNodes.getState().byId['tu1'].startedAt
    s.sweepStaleWorking(startedAt + WORKING_STALE_MS + 1)
    const card = useAgentNodes.getState().byId['tu1']
    expect(card.state).toBe('done')
    expect(card.durationMs).toBeGreaterThan(WORKING_STALE_MS)
  })

  it('leaves a card that is merely young alone', () => {
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    const startedAt = useAgentNodes.getState().byId['tu1'].startedAt
    s.sweepStaleWorking(startedAt + WORKING_STALE_MS - 1)
    expect(useAgentNodes.getState().byId['tu1'].state).toBe('working')
  })

  it('does not overwrite a real finish', () => {
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    s.finish('tu1', { durationMs: 500, result: 'ok' })
    s.sweepStaleWorking(Date.now() + WORKING_STALE_MS * 10)
    expect(useAgentNodes.getState().byId['tu1']).toMatchObject({ durationMs: 500, result: 'ok' })
  })

  it('a decayed card is then taken by the next turn boundary', () => {
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    const startedAt = useAgentNodes.getState().byId['tu1'].startedAt
    s.sweepStaleWorking(startedAt + WORKING_STALE_MS + 1)
    useAgentNodes.getState().clearFinishedForParent('n1')
    expect(useAgentNodes.getState().byId['tu1']).toBeUndefined()
  })
})

describe('Eco still sees the live subagent after a new turn (issue #547)', () => {
  beforeEach(reset)

  const candidates = () =>
    buildHibernationCandidates({
      nodes: [{ id: 'n1', agentId: 'claude' }],
      statusById: { n1: { state: 'done' } },
      subagents: Object.values(useAgentNodes.getState().byId).map((v) => ({
        parentNodeId: v.parentNodeId,
        status: v.state
      })),
      isOffscreen: () => true,
      isRemote: () => false,
      isWired: () => true
    })

  it('pins the parent while a background agent is still running', () => {
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    s.clearFinishedForParent('n1') // the new turn
    expect(candidates()[0].liveSubagents).toBe(true)
  })

  it('stops pinning once the card finishes and the turn boundary takes it', () => {
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    s.finish('tu1', {})
    s.clearFinishedForParent('n1')
    expect(candidates()[0].liveSubagents).toBe(false)
  })

  it('stops pinning after the decay, so a lost end cannot block Eco forever', () => {
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    const startedAt = useAgentNodes.getState().byId['tu1'].startedAt
    s.sweepStaleWorking(startedAt + WORKING_STALE_MS + 1)
    expect(candidates()[0].liveSubagents).toBe(false)
  })
})
