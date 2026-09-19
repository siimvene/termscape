import { describe, it, expect } from 'vitest'
import { sessionPauseOffer, type SessionPauseInput } from './sessionPause'

const ok = { ok: true } as const
const base: SessionPauseInput = {
  orphan: false,
  agentId: 'claude',
  wired: true,
  eligibility: ok
}

describe('sessionPauseOffer', () => {
  it('offers an enabled pause for a mounted, idle agent session', () => {
    const o = sessionPauseOffer(base)
    expect(o.show).toBe(true)
    expect(o).toMatchObject({ disabled: false })
    // The hint has to say what is KEPT, not just what is stopped — that is the whole difference
    // between this control and the `×` beside it.
    if (o.show) expect(o.hint).toMatch(/conversation, tmux session and scrollback/)
  })

  // A panel that spans every `nt-*` session on the machine is mostly NOT agents. A dead control on
  // each of those rows is noise about something that was never possible.
  it('shows nothing at all for a row that could never be paused', () => {
    expect(sessionPauseOffer({ ...base, orphan: true })).toEqual({ show: false })
    expect(sessionPauseOffer({ ...base, agentId: undefined })).toEqual({ show: false })
    // A permanent property of the agent, not a passing state — so no button, not a dead one.
    expect(
      sessionPauseOffer({ ...base, eligibility: { ok: false, reason: 'not-resumable' } })
    ).toEqual({ show: false })
  })

  // The opposite call: these rows DO owe the user a reason, so they render disabled rather than
  // vanishing.
  it('refuses a session whose terminal is not mounted here, and says so', () => {
    const o = sessionPauseOffer({ ...base, wired: false })
    expect(o).toMatchObject({ show: true, disabled: true })
    if (o.show) expect(o.hint).toMatch(/Open this session on its canvas first/)
  })

  it('refuses a busy session with the same sentence the node menu uses', () => {
    const o = sessionPauseOffer({ ...base, eligibility: { ok: false, reason: 'working' } })
    expect(o).toMatchObject({ show: true, disabled: true })
    if (o.show) expect(o.hint).toMatch(/busy/)
  })

  it('refuses a session that has not reported an id', () => {
    const o = sessionPauseOffer({ ...base, eligibility: { ok: false, reason: 'no-session' } })
    expect(o).toMatchObject({ show: true, disabled: true })
    if (o.show) expect(o.hint).toMatch(/has not reported an id/)
  })

  it('refuses a session we already exited, rather than offering it twice', () => {
    for (const flags of [{ paused: true }, { hibernated: true }]) {
      const o = sessionPauseOffer({ ...base, ...flags })
      expect(o).toMatchObject({ show: true, disabled: true })
      if (o.show) expect(o.hint).toMatch(/already paused/)
    }
  })

  // Ordering matters: an already-paused node is ALSO un-wired once its terminal unmounts, and a
  // busy verdict on a paused node would be stale. The "already done" answer must win.
  it('reports already-paused ahead of the wiring and busy refusals', () => {
    const o = sessionPauseOffer({
      ...base,
      paused: true,
      wired: false,
      eligibility: { ok: false, reason: 'working' }
    })
    if (o.show) expect(o.hint).toMatch(/already paused/)
  })

  // …but "this agent can never be paused" outranks even that: it is the one fact that makes the
  // control meaningless rather than merely unavailable.
  it('keeps not-resumable hidden even when other refusals also apply', () => {
    expect(
      sessionPauseOffer({
        ...base,
        paused: true,
        wired: false,
        eligibility: { ok: false, reason: 'not-resumable' }
      })
    ).toEqual({ show: false })
  })
})
