import type { ChatSendRefusal } from './chatSendGate'

/**
 * Pure decisions behind the ⌘M panel's live progress (`nodes/ChatPanel.tsx`): the status row at the
 * end of the thread while the agent works, and the throttled tail refresh that makes the answer
 * appear as it is written instead of only when the turn ends.
 */

/**
 * Minimum gap between two tail reads started by hook events. An SSH project reads its transcript
 * over ssh (a ranged `dd` per read), and a busy turn fires a hook event per tool call — so the
 * refresh is throttled, with a TRAILING read guaranteed (see `planLiveReload`), so the last event
 * of a burst is never lost.
 */
export const CHAT_LIVE_RELOAD_MIN_MS = 1500

/**
 * How long the working row shows after a send with no `working` hook event behind it. Normally
 * UserPromptSubmit flips the state within a second and the real state takes over; this bounds the
 * row for an agent whose hooks never report (a custom agent, a session with hooks unwired), so a
 * spinner can never spin forever over a turn nobody is tracking.
 */
export const CHAT_OPTIMISTIC_WORKING_MS = 15_000

/** What the row at the end of the thread says; `null` = no row. */
export type ChatActivity = 'working' | 'dialog' | null

/**
 * Derived from the composer's send refusal (`lib/chatSendGate.ts`), not from the raw state, so the
 * row and the placeholder can never disagree — and a pane the CLI has left (asleep / paused /
 * dropped / exited) shows no spinner even while a stale `working` or an optimistic send says so.
 * `optimistic` = the user just sent and no state change has happened since (the glue retires it on
 * the next state change or after `CHAT_OPTIMISTIC_WORKING_MS`). A read-only transcript (a closed
 * node) has no live session to report on.
 */
export function chatActivity(s: { refusal: ChatSendRefusal; optimistic: boolean; readOnly: boolean }): ChatActivity {
  if (s.readOnly) return null
  if (s.refusal === 'working') return 'working'
  if (s.refusal === 'dialog') return 'dialog'
  if (s.refusal === null && s.optimistic) return 'working'
  return null
}

export type LiveReloadPlan = { kind: 'run' } | { kind: 'wait'; ms: number } | { kind: 'hold' } | { kind: 'skip' }

/**
 * A hook event arrived for this node (or a deferred one is being retried): what now?
 * - `skip` — the agent is no longer working. The working→idle reload already reads the final tail;
 *   a pending event is dropped.
 * - `hold` — keep the event pending and do nothing: a tail read is in flight (never overlap one —
 *   its settle retries), or the panel has no layout box / the document is hidden (the same gate as
 *   paging; reveal and visibilitychange retry). A hidden panel costs no ssh round trips.
 * - `wait` — a read started less than `minMs` ago: retry after the rest of the interval (the
 *   trailing call).
 * - `run` — read the tail now.
 */
export function planLiveReload(s: {
  working: boolean
  visible: boolean
  inFlight: boolean
  now: number
  lastStartAt: number | null
  minMs?: number
}): LiveReloadPlan {
  const minMs = s.minMs ?? CHAT_LIVE_RELOAD_MIN_MS
  if (!s.working) return { kind: 'skip' }
  if (s.inFlight || !s.visible) return { kind: 'hold' }
  if (s.lastStartAt !== null) {
    const since = s.now - s.lastStartAt
    if (since < minMs) return { kind: 'wait', ms: minMs - since }
  }
  return { kind: 'run' }
}
