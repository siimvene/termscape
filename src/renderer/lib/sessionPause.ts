/**
 * MAY THIS SESSION-MEMORY ROW OFFER "PAUSE"? — the pure decision behind the panel's ⏻ control.
 *
 * The panel's only action used to be the `×` that ENDS a session, which is the wrong tool for the
 * thing it is most often opened for. Measured on the host that prompted this (2026-09-04): 149
 * `nt-` sessions, 46 GB of tree RSS, and 98.3% of a median session's 321 MB is the agent CLI's own
 * process — killing the tmux session on top reclaims the remaining 5.6 MB while destroying the
 * pane, its scrollback and the ability to warm-reattach. So the panel needs the reclaim that is
 * already built: exit the CLI, keep everything else, resume the conversation later.
 *
 * That mechanism exists and is NOT re-implemented here. This offers the SAME "Pause session" the
 * node's context menu offers — `pauseAgentNode(id, false)` → the node's registered `pause` closure
 * → `performExitPhase` — so a session paused from this panel is in exactly the state the PAUSED
 * chip already describes and the existing Resume already ends. Inventing a third depth ("panel
 * hibernate") would be a third concept for the user to hold, and a second exit path to keep in
 * step with Eco's.
 *
 * WHY A ROW MAY BE OFFERED NOTHING AT ALL rather than a disabled button: this panel lists every
 * `nt-*` session on the machine, and most of them are not agents — plain terminals, sticky-less
 * shells, other people's orphans. A disabled control on every one of those rows is noise about a
 * thing that was never possible, which is different from a control that is temporarily refused and
 * owes the user a reason.
 */

/** What the panel should render in a row's pause slot. */
export type SessionPauseOffer =
  /** Nothing at all — this row could never be paused (see the header). */
  | { show: false }
  /** A control, possibly refused. `hint` is the tooltip in BOTH cases: enabled it says what will
   *  happen, disabled it says why it will not. */
  | { show: true; disabled: boolean; hint: string }

export interface SessionPauseInput {
  /** No node on any canvas backs this row (`SessionMemoryView.orphan`). */
  orphan: boolean
  /** The node's created-with agent (`data.agentId`); absent = a plain terminal. */
  agentId?: string
  /**
   * Is this node MOUNTED here with a live pause closure (`agentPauseFns(id)`)? A session belonging
   * to a non-active or closed project is listed by the panel but has no terminal in this renderer
   * to type `/exit` into — the closure is registered by `TerminalNode`, so an unmounted node has
   * none. Refusing with that reason beats a button that silently does nothing.
   */
  wired: boolean
  /** Already exited by us — nothing left to reclaim. */
  paused?: boolean
  hibernated?: boolean
  /**
   * `restartEligibility(agentId, state, sessionId)`'s verdict, computed by the caller so this
   * module stays free of the agent registry. `ok: false` carries the reason the caller renders.
   */
  eligibility: { ok: true } | { ok: false; reason: 'working' | 'no-session' | 'not-resumable' }
}

/**
 * Refusals in the order a reader should meet them:
 *
 *  - **An orphan or a plain terminal shows nothing.** There is no agent CLI in that pane to quit,
 *    and for an orphan there is no node in this renderer at all.
 *  - **`not-resumable` shows nothing either.** Pause is exit + resume; an agent this app cannot
 *    bring back has nothing pause could do for it, and that is a permanent property of the agent,
 *    not a state that will change while the panel is open. A permanently-disabled button teaches
 *    less than no button.
 *  - **Already paused/hibernated is DISABLED, not hidden** — the row still exists and the user is
 *    entitled to know why the action they expected is not there. (Its memory is already reclaimed,
 *    so the row's number should be small; saying so beats silence.)
 *  - **Not wired is DISABLED with the real reason.** This is the common case in a panel that spans
 *    every project, and "open the project first" is actionable.
 *  - **Busy is DISABLED**, with the same sentence the node menu uses: an exit line typed into a
 *    permission prompt ANSWERS it rather than quitting.
 */
export function sessionPauseOffer(i: SessionPauseInput): SessionPauseOffer {
  if (i.orphan || !i.agentId) return { show: false }
  if (!i.eligibility.ok && i.eligibility.reason === 'not-resumable') return { show: false }
  if (i.paused || i.hibernated)
    return {
      show: true,
      disabled: true,
      hint: 'This session is already paused — its agent process has been exited.'
    }
  if (!i.wired)
    return {
      show: true,
      disabled: true,
      hint: 'Open this session on its canvas first — pausing types into its pane, so the terminal has to be here.'
    }
  if (!i.eligibility.ok)
    return {
      show: true,
      disabled: true,
      hint:
        i.eligibility.reason === 'working'
          ? 'This session is busy — try again once its turn (or permission prompt) is done.'
          : 'Nothing to resume yet — this session has not reported an id.'
    }
  return {
    show: true,
    disabled: false,
    hint: 'Pause session: quits the agent CLI to free its memory and keeps the conversation, tmux session and scrollback. Resume brings it back.'
  }
}
