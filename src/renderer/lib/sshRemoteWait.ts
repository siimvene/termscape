/**
 * What a remote terminal waits for before it may spawn, and when it is allowed to stop waiting
 * early.
 *
 * WHY THIS EXISTS (measured, 2026-09-15, against a real sshd with a 25 ms one-way delay proxy =
 * 50 ms RTT). `SshProjectManager.connectOnce` used to publish a project's ControlMaster only with
 * `status: 'connected'` — i.e. after the reverse hook tunnel, ~23 serialized per-agent hook
 * installs, `printf $HOME`, the remote tmux.conf write + source-file and the Codex runtime staging
 * had all run. That chain is ~3.5 s. The attach itself is not the bottleneck at all: 18 remote
 * terminals attaching in parallel over a WARM master painted in a median of 0.16 s, everything
 * settled by 0.71 s. So every terminal of a switched-to project sat in the 20 s wait below,
 * printing "[connecting to user@host…]" into a blank pane, for a transport that was ready.
 *
 * The manager now publishes the control path the moment `ssh -O check` answers
 * (`SshProjectStatusEvent.masterControlPath`). This module decides who may act on that.
 *
 * THE RULE, and it is the load-bearing part: an early attach is safe ONLY for a node whose remote
 * tmux session ALREADY EXISTS. `tmux new-session -A` then merely attaches, and the two things the
 * setup chain provides — the remote tmux config (`-f`) and the hook/account environment (tmux
 * `-e`) — are read at session CREATION only, so a warm attach needs neither. A node whose session
 * is ABSENT, or whose host could not be read, must wait for the full `connected`: creating its
 * session without the hook env costs it agent-status badges silently, with no later event to
 * repair it. `confirmSession` is therefore the STRICT probe (`present` only — see
 * `PtyApi.remoteSessionConfirmed`), never the fail-safe `exists` boolean.
 */

/** The connection facts a spawn needs. The optional three are what the setup chain produces. */
export interface SshRemoteFacts {
  controlPath: string
  hookEndpointPath?: string
  tmuxConfPath?: string
  remoteHome?: string
}

export type SshRemoteWaitOutcome =
  /** The full connect landed: every setup fact is available, cold start included. */
  | { kind: 'full'; facts: SshRemoteFacts }
  /** The master answered and this node's session was confirmed present: attach now, no setup facts. */
  | { kind: 'early'; controlPath: string }
  /** No master within the window. The caller must spawn NOTHING (see `requireRemote`). */
  | { kind: 'none' }

export interface SshRemoteWaitDeps {
  /** The scope's full connection info, once `connect` resolved. */
  getFull: () => SshRemoteFacts | undefined
  /** The scope's early control path, once `-O check` answered. */
  getEarly: () => string | undefined
  /** Subscribe to changes of either of the two above; returns an unsubscribe. */
  subscribe: (cb: () => void) => () => void
  /**
   * Was this node's remote tmux session POSITIVELY listed on the host behind `controlPath`?
   * `null` = this caller may never attach early (no node id to ask about). A rejection is treated
   * as "not confirmed" — the node keeps waiting, which is the pre-feature behavior.
   */
  confirmSession: ((controlPath: string) => Promise<boolean>) | null
  /** How long to wait in total before giving up. */
  waitMs: number
}

/**
 * Resolve the connection a remote terminal should spawn over, or `none` if nothing appears in time.
 *
 * Ordering rules a refactor must not undo:
 *  - The FULL info always wins, even if it lands while an early confirmation is still on the wire.
 *    It is strictly better (it carries the setup facts) and a cold node depends on it.
 *  - A failed or negative confirmation does NOT end the wait; it falls back to waiting for full.
 *  - Each early control path is confirmed at most once. Without that, every unrelated store write
 *    during the wait would fire another `tmux list-sessions` round trip at the host.
 */
export async function waitForSshRemote(deps: SshRemoteWaitDeps): Promise<SshRemoteWaitOutcome> {
  const full = deps.getFull()
  if (full) return { kind: 'full', facts: full }

  return new Promise<SshRemoteWaitOutcome>((resolve) => {
    let settled = false
    let confirming: string | undefined
    const finish = (outcome: SshRemoteWaitOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsub()
      resolve(outcome)
    }
    const check = (): void => {
      if (settled) return
      const now = deps.getFull()
      if (now) {
        finish({ kind: 'full', facts: now })
        return
      }
      const early = deps.getEarly()
      if (!early || !deps.confirmSession || confirming === early) return
      confirming = early
      void deps.confirmSession(early).then(
        (confirmed) => {
          if (settled) return
          // Re-read both: the full info may have landed while this probe was on the wire, and the
          // early path may have been dropped (the master went away).
          const landed = deps.getFull()
          if (landed) finish({ kind: 'full', facts: landed })
          else if (confirmed && deps.getEarly() === early) finish({ kind: 'early', controlPath: early })
        },
        () => {
          // Unreadable host: not evidence the session is absent, but not a licence to attach
          // early either. Keep waiting for the full connect.
        }
      )
    }
    const unsub = deps.subscribe(check)
    const timer = setTimeout(() => {
      const last = deps.getFull()
      finish(last ? { kind: 'full', facts: last } : { kind: 'none' })
    }, deps.waitMs)
    check()
  })
}
