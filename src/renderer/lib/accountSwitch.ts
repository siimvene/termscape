// The renderer-side decision + ordered choreography for switching a running CLAUDE terminal node
// onto another managed Claude account (or back to the system `~/.claude`). NOTHING here is the
// security boundary: the transcript copy is a main/server handler validated against
// `accountConfigDir`, and the pty SIGTERM is identity-gated in core. These pure functions are the
// renderer's own fail-closed refusals + the ordered action plan, so the UI can never ORIGINATE a
// half-switch (a node whose `accountId` flipped without the transcript, stranding the resume) nor a
// switch of a session that is busy, remote, unidentified, or not Claude.
//
// The choreography deliberately mirrors the MODEL SWITCH in `nodes/TerminalNode.tsx`
// (terminateForeground → transport.recycle → updateNodeData respawn bump): the cold-restore
// auto-resume then relaunches `claude --resume <sid>` under the newly-stamped account dir, so the
// conversation continues on the target account. The COPY runs FIRST and, if it fails, NOTHING
// destructive runs — a resume that finds no transcript in the target dir is a lost conversation.

import type { ClaudeAccount } from '@shared/types'
import { capabilityAgentId, type AgentId } from '@shared/agents/config'

/**
 * Claude account ids are interpolated into a filesystem path on the handler side
 * (`accountConfigDir` → `<userData>/claude-accounts/<id>`), so a forged settings/relay id must be
 * refused HERE too, before it is ever handed across the IPC. Mirrors `ACCOUNT_ID_RE` in
 * `src/core/claude-accounts-core.ts` (which the renderer cannot import — it pulls in `node:path`);
 * the handler re-validates, this is defense in depth.
 */
const CLAUDE_ACCOUNT_ID_RE = /^[A-Za-z0-9_-]+$/

/** States in which the pane must be left alone — identical rule to `restartEligibility`'s
 *  `BUSY_STATES` (agent-restart.ts): `blocked` means a permission / question dialog owns the
 *  prompt, so a SIGTERM'd relaunch would race an answer, and `working` means a turn is mid-flight. */
export const BUSY_STATES: ReadonlySet<string> = new Set(['working', 'blocked'])

export type AccountSwitchRefusal =
  | 'not-claude'
  | 'busy'
  | 'no-session'
  | 'not-local'
  | 'same-account'
  | 'account-pending'
  | 'account-unavailable'
  | 'hibernated'

/** The live facts the planner reads off the node + its agent status. `source` is the session's
 *  `SessionSource` ('local' | 'relay' | 'server'); `ssh` marks an SSH-project node (source is
 *  'local' but its transcripts + accounts live on the HOST, so it is refused like a relay tab). */
export interface AccountSwitchState {
  agentId?: string
  source?: string
  ssh?: boolean
  sessionId?: string
  accountId?: string
  state?: string
  cwd?: string
  /** Eco put this CLI to sleep — the pane holds a bare shell, so the identity-gated SIGTERM can
   *  never succeed. The remedy is "wake it, then switch", which the refusal notice says. */
  hibernated?: boolean
}

export interface AccountSwitchPlan {
  /** The node's current account (undefined = system `~/.claude`) — the copy source. */
  sourceAccountId: string | undefined
  /** The chosen account (undefined = system) — the copy target + the node's new `accountId`. */
  targetAccountId: string | undefined
  /** The conversation id copied + resumed. */
  sessionId: string
  cwd: string
}

export type AccountSwitchDecision =
  | { ok: true; plan: AccountSwitchPlan }
  | { ok: false; reason: AccountSwitchRefusal }

/**
 * Decide whether a UI-originated Claude account SWITCH may be ORIGINATED for a node. Fail-closed —
 * proceeds only on `{ ok: true }`. `target` empty/undefined = the SYSTEM account (`~/.claude`).
 *
 * The refusal order matches the task's stated matrix; each verdict is independently reachable:
 *   1. not a Claude node (`capabilityAgentId` so a claude-base custom agent still qualifies);
 *   2. a remote session (relay tab, or an SSH-project node) — other machines' account dirs;
 *   3. busy (`working`/`blocked`) — an exit typed into a permission prompt ANSWERS it;
 *   4. no resumable conversation id — nothing to copy or resume into;
 *   5. a no-op switch to the account already in use;
 *   6. a target that is missing / forged / remote / still pending login.
 */
export function planAccountSwitch(
  node: AccountSwitchState,
  target: string | undefined,
  accounts: readonly ClaudeAccount[]
): AccountSwitchDecision {
  if (capabilityAgentId((node.agentId ?? '') as AgentId) !== 'claude')
    return { ok: false, reason: 'not-claude' }
  // A relay tab belongs to another Mac; an SSH-project node's transcripts + managed accounts live
  // on the host. The local copy handler could only read/write THIS machine's account dirs.
  if (node.source !== 'local' || node.ssh) return { ok: false, reason: 'not-local' }
  if (node.hibernated) return { ok: false, reason: 'hibernated' }
  if (BUSY_STATES.has(node.state ?? '')) return { ok: false, reason: 'busy' }
  const sessionId = node.sessionId?.trim()
  // cwd deliberately NOT required: the copy's scan leg resolves strictly by sessionId, so a
  // cwd-less (inline-canvas) node is switchable — requiring cwd here refused it with a false
  // "no resumable conversation" notice (review finding).
  if (!sessionId) return { ok: false, reason: 'no-session' }
  const source = node.accountId || undefined
  // The SOURCE id rides the git-shared project.json, i.e. it is forgeable — refuse a malformed
  // one here too (the handler re-validates; this keeps the defense-in-depth claim true).
  if (source !== undefined && !CLAUDE_ACCOUNT_ID_RE.test(source))
    return { ok: false, reason: 'account-unavailable' }
  const chosen = target || undefined
  if (source === chosen) return { ok: false, reason: 'same-account' }
  if (chosen !== undefined) {
    // A forged/hostile id never becomes a copy target (it is interpolated into a path handler-side).
    if (!CLAUDE_ACCOUNT_ID_RE.test(chosen)) return { ok: false, reason: 'account-unavailable' }
    const account = accounts.find((a) => a.id === chosen)
    // Explicitly picked but absent / remote ⇒ refuse (never silently resolve to another login):
    // a `host`ed account is a remote account whose dir is on that host, not copyable locally.
    if (!account || account.host) return { ok: false, reason: 'account-unavailable' }
    if (account.pending) return { ok: false, reason: 'account-pending' }
  }
  return {
    ok: true,
    plan: { sourceAccountId: source, targetAccountId: chosen, sessionId, cwd: node.cwd ?? '' }
  }
}

/** Result of the transcript copy (mirrors `ClaudeApi.copySessionTranscript`'s contract). */
export type CopyOutcome =
  | { ok: true; copied: number }
  | { ok: false; reason: 'not-found' | 'invalid' | 'error' | 'target-unavailable' }

/** The injected effects the ordered driver runs — TerminalNode supplies the real IO. */
export interface AccountSwitchEffects {
  /** Copy the session transcript from the source account dir into the target. Runs FIRST. */
  copyTranscript: () => Promise<CopyOutcome>
  /** Re-asked AFTER the copy resolves, BEFORE anything destructive: the copy is an await window
   *  in which a turn can start or the node can unmount — a plan-time verdict is stale by seconds
   *  (the repo's Eco fire-time rule). `null` = still eligible. */
  recheckEligible?: () => AccountSwitchRefusal | null
  /** Identity-gated SIGTERM of the pane's foreground Claude process group. `false` ⇒ abort. */
  terminateForeground: () => Promise<boolean>
  /** Recycle the tmux session so a fresh shell spawns under the new account env. */
  recycle: () => void
  /** Stamp the node's new `accountId` + bump `respawnNonce` (the cold-restore auto-resume relaunch). */
  commit: () => void
}

export type AccountSwitchOutcome =
  | { ok: true; copied: number }
  | { ok: false; reason: 'copy-failed'; copy: Extract<CopyOutcome, { ok: false }>['reason'] }
  | { ok: false; reason: 'terminate-failed' }
  | { ok: false; reason: 'recheck-failed'; refusal: AccountSwitchRefusal }

/**
 * Run the switch effects in the ONE safe order. The invariant the whole feature exists for:
 * the COPY happens before any destructive step, and a failed copy mutates NOTHING (no SIGTERM, no
 * recycle, no data change) — a resume that finds no transcript in the target dir is a lost
 * conversation. A refused SIGTERM (a stale menu whose pane now runs vim, or a session that ended)
 * aborts before the recycle, so nothing is killed and the node keeps its account.
 */
export async function executeAccountSwitch(
  effects: AccountSwitchEffects
): Promise<AccountSwitchOutcome> {
  const copy = await effects.copyTranscript()
  if (!copy.ok) return { ok: false, reason: 'copy-failed', copy: copy.reason }
  const stale = effects.recheckEligible?.()
  if (stale) return { ok: false, reason: 'recheck-failed', refusal: stale }
  if (!(await effects.terminateForeground())) return { ok: false, reason: 'terminate-failed' }
  effects.recycle()
  effects.commit()
  return { ok: true, copied: copy.copied }
}

// --- per-node executor registry (glue, mirrors registerAgentRestart in terminal/agent-restart.ts) --
// The menu lives in Canvas.tsx and the choreography in TerminalNode.tsx; a node registers its
// executor on mount so the menu can invoke the pane-scoped `transport`/`api`/`updateNodeData` the
// switch needs without Canvas importing the node component.

/** Flat result code the registered executor returns — string-only so it composes with the shared
 *  `guardConcurrentRestart` (which reports its own `'not-eligible'` when a run is already in
 *  flight). Refusal reasons pass through verbatim; the driver's object outcome is flattened to
 *  `'switched' | 'copy-failed' | 'terminate-failed'`. Canvas maps each to a user notice. */
export type AccountSwitchResult =
  | 'switched'
  | 'not-eligible'
  | AccountSwitchRefusal
  | 'copy-failed'
  | 'terminate-failed'

export type AccountSwitchFn = (
  targetAccountId: string | undefined
) => Promise<AccountSwitchResult>

const switchFns = new Map<string, AccountSwitchFn>()

export function registerAccountSwitch(nodeId: string, fn: AccountSwitchFn): () => void {
  switchFns.set(nodeId, fn)
  return () => {
    if (switchFns.get(nodeId) === fn) switchFns.delete(nodeId)
  }
}

export function accountSwitchFn(nodeId: string): AccountSwitchFn | undefined {
  return switchFns.get(nodeId)
}

export function __resetAccountSwitchForTests(): void {
  switchFns.clear()
}
