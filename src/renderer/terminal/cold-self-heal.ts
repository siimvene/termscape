/**
 * Was a remote session we treated as a WARM reattach actually created by our own attach?
 *
 * THE INCIDENT (measured on the reporting host, 2026-09-15). The host's `nodeterm-rmt` tmux server
 * died, so every remote session was gone; ten minutes later a 108-node SSH project was opened and
 * 107 sessions had to be created in one mount burst. In the seven minutes around it sshd logged
 * **757 `Accepted publickey` full logins** — on a healthy ControlMaster that number is ~0, because
 * everything multiplexes over one connection. Under that pressure the per-node freshness read
 * times out, and the read's own fail-safe (`RemoteSessionIndex`: anything that is not tmux's exit 1
 * answers "exists", because typing `claude --resume …` into a LIVE agent pane is the worse failure)
 * hands back "warm" for a session that does not exist. `tmux new-session -A` then CREATES an empty
 * one, `fresh:false` skips the cold-restore branch, and the node sits at a bare shell forever with
 * the user's conversation stranded on disk.
 *
 *   15:29 burst,  22 sessions: 18 claude /  4 bash  -> 82% resumed
 *   15:39 burst, 107 sessions: 41 claude / 66 bash  -> 38% resumed
 *
 * Load-dependent, i.e. a race, not a deterministic bug.
 *
 * THE FIX IS A SECOND OPINION, NOT A DIFFERENT FOLD. The fail-safe stays exactly as it is: it is
 * right, and it is right for a reason that has not changed. What is added is that when the verdict
 * came from a FAILED read (`PtyCreateResult.freshUnverified`), the answer is re-asked ONCE after
 * the attach has landed — by which time the burst is over, the master is healthy, and tmux itself
 * can settle it authoritatively: `#{session_created}` survives a `new-session -A` attach, so a
 * session created within seconds of our own attach is one WE made.
 *
 * Every rule below is a refusal, and each closes a way this could type into somebody's live work.
 */

/** How young a session may be and still be read as "our attach created it".
 *
 *  Sized for the case it exists for, which is a SLOW one: the attach it is dated against is the
 *  same ssh round trip the burst was starving, so a couple of seconds is routine. It is bounded on
 *  the other side by what it has to exclude — a session a human opened and started working in —
 *  and 30 s is far short of that while covering a badly contended attach. */
export const COLD_SELF_HEAL_MAX_AGE_S = 30

export interface ColdSelfHealInput {
  /** The create's own verdict. `true` means the cold path already ran — nothing to heal. */
  fresh: boolean
  /** The create reported that `fresh:false` came from a read it could not complete. */
  freshUnverified: boolean
  /** Seconds since the session was created, on the machine that holds it. `null` = could not tell. */
  ageSeconds: number | null
  /** `#{pane_current_command}` for this node. `null` = could not tell. */
  paneCommand: string | null
  /** Does a shell own the pane? Injected (the caller owns `isShellCommand`) so this stays pure. */
  isShell: (command: string) => boolean
}

export type ColdSelfHealVerdict =
  /** The session was created by our own attach: run the cold-restore relaunch. */
  | 'cold'
  /** Anything else. Named so a caller (and a test) can say WHY nothing happened. */
  | 'verdict-was-read'
  | 'already-cold'
  | 'age-unknown'
  | 'session-predates-attach'
  | 'pane-not-a-shell'

/**
 * Rules, in the order they refuse:
 *
 *  1. **Never for a verdict that came from a real read.** A confident `fresh:false` is an answer,
 *     and re-asking it would spend a round trip per warm node on every switch — the channel
 *     pressure this whole area exists to reduce.
 *  2. **Never twice, and never when the cold path already ran.** `fresh` means the relaunch has
 *     happened; the caller additionally fires this at most once per spawn.
 *  3. **An unknown age is not evidence.** `null` covers an unreadable host, a dead master, a
 *     session-host backend and a garbled line — none of which say the session is new.
 *  4. **A session older than the window is somebody's live work**, whether ours or another
 *     client's, and nothing may be typed into it.
 *  5. **The pane must be a SHELL**, re-read at this moment — the same gate the hibernation wake and
 *     the resume-miss watcher keep. It is belt to rule 4's braces: if an agent CLI already owns the
 *     pane then whatever the clock says, the answer is no. `null` is "we could not see the pane",
 *     never "nothing is running in it", so it refuses too.
 */
export function coldSelfHealVerdict(input: ColdSelfHealInput): ColdSelfHealVerdict {
  if (input.fresh) return 'already-cold'
  if (!input.freshUnverified) return 'verdict-was-read'
  if (input.ageSeconds === null) return 'age-unknown'
  if (input.ageSeconds > COLD_SELF_HEAL_MAX_AGE_S) return 'session-predates-attach'
  if (!input.paneCommand || !input.isShell(input.paneCommand)) return 'pane-not-a-shell'
  return 'cold'
}
