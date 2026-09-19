// One `tmux list-sessions` per host per switch, instead of one `has-session` per node.
//
// WHY THIS EXISTS (measured, 2026-09-14). Every remote terminal node asks the host "does my tmux
// session already exist?" before it spawns, because the answer decides whether the renderer
// replays a scrollback snapshot and re-issues `claude --resume` (cold) or lets tmux repaint (warm).
// That probe was one ssh child per node, and a project switch mounts every node in ONE tick — so a
// project with N remote terminals fired N probe channels at the same instant as its N pty channels.
//
// A stock sshd allows `MaxSessions 10` CHANNELS on one connection, and our ControlMaster is one
// connection. Past that limit ssh answers `mux_client_request_session: session request failed:
// Session open refused by peer`; the refused child then tries to become a master itself, cannot
// bind the socket the live master already owns (`ControlSocket … already exists, disabling
// multiplexing`) and completes a FULL TCP+KEX+auth login instead. Both lines in that order are the
// user-visible symptom, and they are one failure, not two. Enough simultaneous logins then trip the
// host's `MaxStartups` and some are reset outright, which fails a terminal, which starts the
// reconnect backoff — seconds of black pane.
//
// Measured against a real sshd (MaxSessions 10, 20 ms RTT), one switch to a 12-terminal project:
//   per-node probes: 14 refusals, 12 full logins, 4 connections reset, 1.67 s to paint all panes
//   coalesced (here):  3 refusals,  3 full logins, 0 connections reset, 1.06 s
// With 18 terminals the per-node version left a pane that never painted at all (17/18).
//
// The verdict contract is unchanged, and it is the load-bearing part: only tmux's own exit 1
// ("no server running") is evidence of absence. Any other outcome — ssh 255 on a dead master,
// 127 with tmux off the remote PATH, a timeout — is a failed READ, and a failed read answers
// "exists", because a transport failure read as "cold" makes the desktop type `claude --resume …`
// into a LIVE fullscreen agent session (see `probeSaysAbsent`).

/** How long one host's session list may answer for. Long enough to cover a single mount burst,
 *  short enough that the answer cannot survive into an unrelated interaction. The coalescing of
 *  CONCURRENT callers (the burst itself) does not depend on this at all — it rides the in-flight
 *  promise — so the window only serves stragglers. */
export const REMOTE_SESSION_INDEX_TTL_MS = 1000

/** What one `tmux list-sessions` read established. `unknown` is a failed READ, never absence. */
export type SessionListOutcome = { kind: 'names'; names: string[] } | { kind: 'unknown' }

/**
 * What we know about ONE session, kept tri-state on purpose.
 *
 * `exists()` folds `unknown` into "exists" because its caller is about to type into a pane and a
 * failed read must never be mistaken for a cold session. A second caller — the early-attach gate
 * (`SshProjectManager` publishes the ControlMaster before its setup chain finishes) — needs the
 * OPPOSITE fold: it may only skip the wait when the host POSITIVELY listed the session, because
 * attaching early to a session that does not exist creates it without the tmux `-f` config and the
 * creation-time `-e` hook env. Both folds are honest; neither may be derived from the other's
 * boolean, so the verdict is exposed as it is actually known.
 */
export type SessionVerdict = 'present' | 'absent' | 'unknown'

export interface RemoteSessionIndexDeps<Ctx> {
  /** Run `tmux list-sessions` on the host behind `controlPath` and classify the result. `ctx` is
   *  whatever the caller needs to BUILD that command (the project's `SshConnection`); the index
   *  itself never looks inside it, which is what keeps this module free of ssh types. */
  list: (controlPath: string, ctx: Ctx) => Promise<SessionListOutcome>
  now?: () => number
}

interface Entry {
  at: number
  outcome?: SessionListOutcome
  inflight?: Promise<SessionListOutcome>
  /** Sessions THIS process created since the entry was made. A session we just spawned exists,
   *  whatever a list read taken a moment earlier said — without this a respawn inside the window
   *  would be told "cold" and replay a snapshot over a live pane. */
  spawned: Set<string>
}

export class RemoteSessionIndex<Ctx> {
  private byPath = new Map<string, Entry>()
  private now: () => number
  constructor(private deps: RemoteSessionIndexDeps<Ctx>) {
    this.now = deps.now ?? (() => Date.now())
  }

  /**
   * Does `sessionId` exist on the host behind `controlPath`?
   *
   * `true` also means "we could not tell" — the caller must treat it as a warm attach, which types
   * nothing into the pane. Concurrent callers for the same host share ONE list read.
   */
  async exists(controlPath: string, sessionId: string, ctx: Ctx): Promise<boolean> {
    // A failed read is never evidence of absence.
    return (await this.verdict(controlPath, sessionId, ctx)) !== 'absent'
  }

  /**
   * The tri-state answer behind `exists`. `unknown` is a failed READ (dead master, ssh missing, a
   * timeout) — callers that would ACT on absence must treat it as "do not know", not as absence.
   */
  async verdict(controlPath: string, sessionId: string, ctx: Ctx): Promise<SessionVerdict> {
    const entry = this.fresh(controlPath)
    if (entry?.spawned.has(sessionId)) return 'present'
    if (entry?.outcome) return verdict(entry.outcome, sessionId)
    if (entry?.inflight) return verdict(await entry.inflight, sessionId)

    const spawned = entry?.spawned ?? new Set<string>()
    const inflight = this.deps
      .list(controlPath, ctx)
      .catch((): SessionListOutcome => ({ kind: 'unknown' }))
      .then((outcome) => {
        const held = this.byPath.get(controlPath)
        // Only settle the entry this read belongs to: `invalidate` may have replaced it while the
        // read was on the wire, and caching onto the newer entry would resurrect a stale answer.
        if (held && held.inflight === inflight) {
          held.outcome = outcome
          held.inflight = undefined
          held.at = this.now()
        }
        return outcome
      })
    this.byPath.set(controlPath, { at: this.now(), inflight, spawned })
    return verdict(await inflight, sessionId)
  }

  /** Record a session this process just created on that host. */
  markPresent(controlPath: string, sessionId: string): void {
    const entry = this.fresh(controlPath)
    if (entry) entry.spawned.add(sessionId)
    else this.byPath.set(controlPath, { at: this.now(), spawned: new Set([sessionId]) })
  }

  /** Forget everything known about a host — used when its session set changed under us (a kill). */
  invalidate(controlPath: string): void {
    this.byPath.delete(controlPath)
  }

  private fresh(controlPath: string): Entry | undefined {
    const entry = this.byPath.get(controlPath)
    if (!entry) return undefined
    // An in-flight read is always current: it was started now and nothing may supersede it by age.
    if (entry.inflight) return entry
    if (this.now() - entry.at > REMOTE_SESSION_INDEX_TTL_MS) {
      this.byPath.delete(controlPath)
      return undefined
    }
    return entry
  }
}

function verdict(outcome: SessionListOutcome, sessionId: string): SessionVerdict {
  if (outcome.kind === 'unknown') return 'unknown'
  return outcome.names.includes(sessionId) ? 'present' : 'absent'
}
