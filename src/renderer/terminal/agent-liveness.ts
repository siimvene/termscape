/**
 * DID THIS NODE'S AGENT CLI DIE WITHOUT TELLING US? — the pure decision behind the DROPPED chip.
 *
 * Every ORDERLY way an agent CLI leaves its pane announces itself. Our own Eco `/exit` sets
 * `hibernated`; the manual "Pause session" sets `paused`; a user typing `/exit` themselves fires
 * the CLI's own SessionEnd hook, which `setState(id, undefined)` records as "no agent here now".
 * A kill announces nothing: the process is gone before it can run a hook, and because tmux's own
 * shell owns the pane, the PTY stays open and the node keeps rendering whatever badge it had. The
 * user is left with a live-looking card over a dead conversation, and — for Claude — the CLI's
 * parting "Resume this session with: claude --resume <uuid>" line plus a stray `^[%` sitting in
 * the pane as the only evidence.
 *
 * Measured on the host that prompted this (2026-09-04): 62 GB RAM with swap fully consumed, the
 * kernel's `oom_kill` counter at 187, and 147 live `claude` processes holding 44 GB. A session
 * dying under memory pressure is not an exotic case on a canvas this size — it is the normal
 * outcome. In the same sweep, 9 of 149 panes sat at a bare shell after a cold-restore
 * `claude --resume <id>` answered "No conversation found with session ID", which this same
 * predicate catches: the CLI is gone and nothing accounted for it, whichever way it went.
 *
 * THE SIGNAL is `#{pane_current_command}` reading as a shell while the status table still believes
 * an agent is sitting there. Each half is necessary and neither is sufficient, and the four
 * refusals below are what keep it from crying wolf — a false DROPPED is worse than no chip at all,
 * because the offered Resume would splice a second CLI into a pane that already has one.
 */
import { isShellCommand } from '@shared/agents/pane'
import { reportsSessionEnd } from '@shared/agents/config'

/**
 * How long one pane reading may take before it counts as unreadable. Generous next to the restart
 * poll's own budget because nothing waits on this answer — no line is about to be typed, and a
 * slow ControlMaster should postpone a badge, never mislabel a session.
 */
export const LIVENESS_QUERY_MS = 6000

/**
 * How often a WATCHED, parked agent node re-asks. Coarse on purpose: the thing being detected is a
 * process that has already died and cannot un-die, so the only thing a faster tick buys is load on
 * somebody's ssh master. The reveal edge is what makes the badge feel prompt.
 */
export const LIVENESS_POLL_MS = 30_000

/**
 * The cheap half of `looksDropped`: everything decidable WITHOUT reading the pane. Callers use it
 * to avoid paying for a tmux round trip on a node that could not be dropped whatever the pane says
 * — a plain terminal, a working agent, a node we hibernated ourselves.
 *
 * Kept beside `looksDropped` and asking the same questions in the same order so the two cannot
 * drift into disagreeing about who is a candidate (pinned by an exhaustive test). The full
 * predicate re-checks every one of these against a freshly read status, because the pane read is
 * an await and a turn can start inside it.
 */
export function looksDroppedCandidate(
  agentId: string | undefined,
  state: string | undefined,
  hibernated: boolean | undefined,
  paused: boolean | undefined
): boolean {
  if (hibernated || paused) return false
  if (!agentId || !reportsSessionEnd(agentId)) return false
  return state === 'done'
}

export interface DroppedCheckInput {
  /** The agent this node was CREATED as (`data.agentId`), not a guess from the pane. */
  agentId?: string
  /** The node's live agent state (`agentStatus.byId[id].state`) — TRANSIENT by design. */
  state?: string
  /** Our own Eco exit put the pane in this state. */
  hibernated?: boolean
  /** The manual "Pause session" put the pane in this state. */
  paused?: boolean
  /**
   * `#{pane_current_command}`, or `null` when the pane could not be read (tmux off, a dead
   * ControlMaster, a lapsed query). `null` is never evidence — the same contract
   * `queryPaneWithin` publishes.
   */
  pane: string | null
}

/**
 * Did this node's agent CLI leave its pane without any of the orderly exits accounting for it?
 *
 * Every `false` below is a deliberate refusal:
 *
 *  - **`pane === null` is not evidence.** A lapsed or failed pane query means "we cannot see this
 *    pane right now", never "nothing is running in it" — the rule `queryPaneWithin` already sets
 *    for the restart poll, and the reason a downed ControlMaster cannot make a canvas full of
 *    healthy remote nodes claim they died.
 *  - **`hibernated` / `paused` are OUR OWN exits.** The pane is a shell because we asked it to be.
 *    Those two already have chips (SLEEPING / PAUSED) that say so and resume on click; a third
 *    badge over the same fact would be an alarm about a feature working.
 *  - **The agent must report a session end** (`reportsSessionEnd`). This is the gate that keeps a
 *    user's own `/exit` from reading as a crash, and it is a MEASURED per-agent fact, not a
 *    courtesy: `normalize.ts` maps a session-end for claude, gemini, copilot and grok, and maps
 *    none at all for **codex and opencode**. On those two a clean manual quit leaves `state` at
 *    `done` and the pane at a shell — byte-identical to a kill — so there is nothing here to tell
 *    the two apart and this module refuses to guess. Widening the list without adding the
 *    normalizer branch first would put a DROPPED chip on every codex session its owner quit on
 *    purpose.
 *  - **Only `done`, never `working`.** `done` is the one state that means "the CLI is parked at
 *    its own prompt", where a shell reading has no innocent explanation. `working` is excluded
 *    even though a mid-turn kill is the likeliest way to die: a turn in flight is exactly when a
 *    tool subprocess can own the pane's foreground, and `pane_current_command` would report that
 *    subprocess — so the alarm would fire on a perfectly healthy agent running a shell command.
 *    `waiting`/`blocked` are excluded for the plainer reason that they already carry a NEEDS YOU
 *    badge the user is being called back for. An ABSENT state (`undefined`) is the app-restart
 *    case and the post-SessionEnd case at once, and neither is a crash.
 *
 * Note what this deliberately does NOT try to detect: a session whose CLI died BEFORE the app was
 * restarted. `state` is transient, so after a relaunch there is no belief left to contradict, and
 * inventing one from the pane alone would flag every plain terminal on the canvas.
 */
export function looksDropped(i: DroppedCheckInput): boolean {
  if (i.pane === null) return false
  if (!isShellCommand(i.pane)) return false
  return looksDroppedCandidate(i.agentId, i.state, i.hibernated, i.paused)
}
