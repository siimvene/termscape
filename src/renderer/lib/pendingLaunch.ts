// Pure logic for ARMED terminal nodes — the canvas-control `--after` dependency edge. A node
// opened with `--after <ids>` holds its launch command (see PendingLaunch in @shared/types)
// until every station it waits on has gone idle; this module decides when that is, and which
// dependency edges to draw meanwhile. Kept free of React/store imports so the satisfaction
// matrix is unit-testable — Canvas.tsx only wraps these in an effect and a setState.
import type { AgentState } from '@shared/agents/normalize'
import type { GitHubPullBoard } from '@shared/github-pull-status'
import type { PrWaitHold } from '@shared/pr-wait'
import {
  normalizeSuccessWaitHold,
  outcomeOf,
  successWaitSatisfied,
  type StationOutcomeRecord,
  type SuccessDepFacts,
  type SuccessWaitHold
} from '@shared/station-outcome'
import type { PendingLaunch } from '@shared/types'
import type { StationHandoverRecord } from '@shared/station-handover'
import { prHoldSatisfied } from './prWait'

/** The subset of a canvas node this module reads. */
export interface ArmedNode {
  id: string
  data: { pendingLaunch?: PendingLaunch }
}

/** The subset of the agentStatus store this module reads. */
export type StatusById = Record<
  string,
  { state?: AgentState; lastTurnError?: { at: number }; lastTurnInterrupted?: { at: number } } | undefined
>

/**
 * May a freshly-mounted agent node run its cold-restore `--resume` (or any in-place relaunch)?
 *
 * NO while it still holds a `pendingLaunch`. An armed node (canvas-control `--after`, or a
 * cold-opened node) has NEVER launched its agent: its `agentSessionId` was MINTED at creation and
 * names a conversation that does not exist yet — the held launch (`--session-id <id> …`, delivered
 * by the "Fire armed nodes" effect) is what creates it. Resuming first types `claude --resume <id>`
 * into the fresh shell, which prints "No conversation found with session ID: …", wastes a CLI start,
 * and then has the real launch delivered on top. Once the fire effect delivers and clears
 * `pendingLaunch`, a later cold restore resumes normally — so the gate is exactly the pending flag,
 * nothing more. Three cases: armed (`pendingLaunch` set) ⇒ false; delivered / plain restore (no
 * `pendingLaunch`) ⇒ true.
 */
export function mayRelaunchAgent(data: { pendingLaunch?: PendingLaunch }): boolean {
  return !data.pendingLaunch
}

export interface LaunchToFire {
  id: string
  command: string
  /** The file `command` reads its prompt from, which the loop checks before typing. */
  briefFile?: string
}

/**
 * Record the file a held launch reads its prompt from (`--prompt-file`, or a spilled `--prompt`).
 * Applied by every control open path after arming, so the delivery loop can check the file is still
 * there when the node finally launches — possibly weeks later, for a cold open.
 */
export function withLaunchBrief<T extends { data: { pendingLaunch?: PendingLaunch } }>(
  node: T,
  promptFile: string | undefined
): T {
  const p = node.data.pendingLaunch
  if (!promptFile || !p) return node
  return { ...node, data: { ...node.data, pendingLaunch: { ...p, promptFile } } }
}

/** What `launchesToFire` needs to judge a `--after-pr` wait: the ACTIVE project's pull request
 *  status (#1008's board, absent until the watch has read it) and the clock deadlines are on. */
export interface PrGateContext {
  board?: GitHubPullBoard
  now: number
}

/**
 * Stations with unfinished HANDED-OVER work (core/station-handover.ts, mirrored): a station here is
 * never a satisfied `--after` dep, whatever its state reads — its `done` is from before the work it
 * was just handed. Absent = nothing handed over.
 */
export type HandoverById = Readonly<Record<string, StationHandoverRecord | undefined>>

function handedOver(handovers: HandoverById | undefined, depId: string): boolean {
  return !!handovers && Object.prototype.hasOwnProperty.call(handovers, depId) && !!handovers[depId]
}

/** What `launchesToFire` needs to judge a `--after-success` wait: every station's latest task
 *  report (core's durable store, mirrored) and the clock deadlines are on. */
export interface SuccessGateContext {
  outcomes: Readonly<Record<string, StationOutcomeRecord>>
  now: number
}

/**
 * What the success wait knows about one station, from the same sources the `--after` gate reads:
 * whether it is still on the canvas, whether its turn is over without an error (`depSatisfied`'s
 * rule, so a success wait can never release where plain `--after` would still hold), and its report.
 */
export function successDepFacts(
  depId: string,
  status: StatusById,
  live: ReadonlySet<string>,
  outcomes: Readonly<Record<string, StationOutcomeRecord>>,
  handovers?: HandoverById
): SuccessDepFacts {
  const exists = live.has(depId)
  const reported = outcomeOf(outcomes, depId)
  return {
    exists,
    turnDone: exists && depSatisfied(depId, status, live, handovers),
    ...(reported ? { outcome: reported } : {})
  }
}

/**
 * Attach a `--after-success` wait to a node whose launch is already held — the sibling of
 * `withPrHold`, applied by every open path that applies that one, so no path can arm a node that
 * forgets a wait it was asked for.
 */
export function withSuccessHold<T extends { data: { pendingLaunch?: PendingLaunch } }>(
  node: T,
  hold: SuccessWaitHold | undefined
): T {
  const p = node.data.pendingLaunch
  if (!hold || !p) return node
  return { ...node, data: { ...node.data, pendingLaunch: { ...p, afterSuccess: hold } } }
}

/** Control opens reply before the PTY exists. Keep their command durable until delivery lands,
 * even with no dependencies (or dependencies that are already done). */
export function queueControlLaunch<T extends { data: { initialCommand?: string; pendingLaunch?: PendingLaunch } }>(
  node: T,
  after: string[] = [],
  awaitSetupGroup?: string
): T & { data: { pendingLaunch?: PendingLaunch } } {
  const command = node.data.initialCommand
  if (!command) return node
  return {
    ...node,
    data: {
      ...node.data,
      initialCommand: undefined,
      pendingLaunch: { after, command, attempted: false, ...(awaitSetupGroup ? { awaitSetupGroup } : {}) }
    }
  }
}

/**
 * Attach a `--after-pr` wait to a node whose launch is already held (by `queueControlLaunch`,
 * `armForColdOpen`, or `--after`). ONE helper for every open path — live, cold and `--project` —
 * so no path can arm a node that forgets the wait it was asked for. A node with nothing held has
 * nothing to wait with (the flag gate already refused `open-terminal` without `--cmd`).
 */
export function withPrHold<T extends { data: { pendingLaunch?: PendingLaunch } }>(
  node: T,
  hold: PrWaitHold | undefined
): T {
  const p = node.data.pendingLaunch
  if (!hold || !p) return node
  return { ...node, data: { ...node.data, pendingLaunch: { ...p, afterPr: hold } } }
}

/**
 * Is the file a held launch reads its prompt from still there, right before the launch is typed?
 * Only a definite "not there" answers false. No file to check, a check that fails (sync or async),
 * and any project not on this machine's disk answer true: an SSH project never gets a spilled file,
 * and there `exists === false` cannot tell a gone file from a dropped ControlMaster; a relay tab's
 * launches are refused elsewhere. The open-time check fails open the same way.
 */
export async function launchBriefPresent(
  path: string | undefined,
  project: { id: string; ssh?: unknown; remote?: boolean } | undefined,
  exists: (path: string) => Promise<boolean>
): Promise<boolean> {
  if (!path || !project || project.ssh || project.remote) return true
  try {
    return (await exists(path)) !== false
  } catch {
    return true
  }
}

/** A list row states only observed facts; absence of a launch error is not proof of a live CLI. */
export function controlLaunchState(
  pending: boolean,
  delivery: LaunchDelivery | undefined,
  status?: { dropped?: boolean; state?: AgentState },
  /** The node's `--after-pr` wait has passed its deadline: it will not start on its own. */
  prExpired = false,
  /** Where the node's `--after-success` wait stands, when it has one. */
  success?: 'met' | 'waiting' | 'blocked' | 'expired'
):
  | 'queued'
  | 'stalled'
  | 'failed'
  | 'starting'
  | 'brief-missing'
  | 'dropped'
  | 'working'
  | 'expired'
  | 'success-expired'
  | 'waiting-success'
  | 'blocked-failure'
  | undefined {
  if (pending) {
    if (delivery) return delivery.kind
    if (prExpired) return 'expired'
    if (success === 'expired') return 'success-expired'
    if (success === 'blocked') return 'blocked-failure'
    if (success === 'waiting') return 'waiting-success'
    return 'queued'
  }
  if (status?.dropped) return 'dropped'
  if (status?.state === 'working') return 'working'
  return undefined
}

/**
 * Is one dependency satisfied?
 *
 * `done` is the agent's busy→idle edge — the same signal that drives the completion badge and
 * notification. It means "this station has produced something and stopped", which is exactly
 * when a downstream station should start reading it. It does NOT mean "this station will never
 * run again": an agent that finishes turn 1 and awaits more input is also `done`. That is the
 * intended semantics for a station given one self-contained prompt, and it is documented as
 * such rather than being papered over with a turn counter that would guess differently.
 *
 * A dep that is no longer on the canvas counts as satisfied — a deleted node can never report,
 * so treating it as pending would strand the dependent forever. An UNKNOWN state (the dep
 * exists but has reported nothing yet) is deliberately NOT satisfied: right after a fan-out the
 * upstream stations have not emitted a hook event yet, and reading "no news" as "finished"
 * would fire every dependent immediately — the exact bug that makes a dependency edge useless.
 *
 * A dep that is `done` **with a live `lastTurnError`** is refused (issue #521). An errored station
 * reaches idle IMMEDIATELY and looked healthy from every surface an orchestrator can read, so a
 * whole dependency chain launched against an upstream that had produced nothing. Firing with a
 * warning instead was considered and dropped: a dependent that has already launched cannot
 * un-launch, so the warning would arrive after the damage. The armed node keeps its manual ▶
 * run-now escape, so the human — or the orchestrator, after a retry — is never stuck.
 *
 * The refusal ends by itself: `lastTurnError` is cleared by the upstream's next genuine new turn,
 * so a station that is nudged and answers successfully satisfies its dependents on that turn.
 *
 * A dep whose last turn the user INTERRUPTED (Esc / Ctrl+C — `lastTurnInterrupted`) is refused
 * for the same reason: an interrupted station is idle too, and its turn did not produce what the
 * dependent was waiting for. Claude sends no hook for an interrupt; the `done` comes from the
 * transcript marker (`recordTurnInterrupt`). Same escape (▶), same self-healing (next turn).
 *
 * A dep that has been HANDED NEW WORK it has not finished (`handovers`, core/station-handover.ts)
 * is refused too. A station is reused: an orchestrator hands it its next task and then arms a
 * dependent on it, and until the station starts that task its state is still the PREVIOUS task's
 * `done` — the dependent would start at once, on the old output. Core decides when the hand-over
 * is answered (a turn that started after it has ended); here it is only a membership test, so the
 * renderer and the Server Edition's factory cannot disagree.
 */
function depSatisfied(
  depId: string,
  status: StatusById,
  live: ReadonlySet<string>,
  handovers?: HandoverById
): boolean {
  if (!live.has(depId)) return true
  if (handedOver(handovers, depId)) return false
  const st = status[depId]
  return st?.state === 'done' && !st.lastTurnError && !st.lastTurnInterrupted
}

/** Why a dep is held (see `handedOverDeps`): new work handed to it, or ONLY tasks its last turn left
 *  running in the background. Named differently in the tooltip and in `list`. */
export function holdReason(record: StationHandoverRecord | undefined): 'work' | 'background' {
  return record?.background && !record.queued && record.since === undefined ? 'background' : 'work'
}

/** Of the deps this node is still waiting on, which are held because they were handed new work
 *  they have not finished — what the QUEUED tooltip and `list` name. */
export function handedOverDeps(
  node: ArmedNode,
  live: ReadonlySet<string>,
  handovers: HandoverById | undefined
): string[] {
  return (node.data.pendingLaunch?.after ?? []).filter((d) => live.has(d) && handedOver(handovers, d))
}

/** Of the deps this node is still waiting on, which are held because they ERRORED rather than
 *  because they have not finished? What the QUEUED tooltip names (issue #521). */
export function erroredDeps(
  node: ArmedNode,
  status: StatusById,
  live: ReadonlySet<string>
): string[] {
  return (node.data.pendingLaunch?.after ?? []).filter(
    (d) => live.has(d) && status[d]?.state === 'done' && !!status[d]?.lastTurnError
  )
}

/** Of the deps this node is still waiting on, which are held because the user INTERRUPTED their
 *  last turn? Named by the QUEUED tooltip, like `erroredDeps`. An errored dep is left to
 *  `erroredDeps` — that is the stronger fact, and one reason is enough. */
export function interruptedDeps(
  node: ArmedNode,
  status: StatusById,
  live: ReadonlySet<string>
): string[] {
  return (node.data.pendingLaunch?.after ?? []).filter(
    (d) =>
      live.has(d) &&
      status[d]?.state === 'done' &&
      !status[d]?.lastTurnError &&
      !!status[d]?.lastTurnInterrupted
  )
}

/**
 * Which armed nodes are ready to launch, given the live canvas and the current agent states.
 * `live` is passed in (rather than derived from `nodes`) because the caller already holds the
 * full node list while `nodes` here may be pre-filtered.
 *
 * `setupDone` is the SECOND gate, for a node opened into a worktree frame whose project runs a
 * setup script with `waitForSetup`: the node's command must not race an `npm ci` that is still
 * writing node_modules underneath it. It answers per group id, and the two gates are ANDed —
 * a node can be waiting on both its upstream stations and its checkout being ready.
 *
 * An ABSENT probe (`setupDone` not passed) means the gate is open. That is the honest default,
 * not laxness: the run store is rebuilt from live events, so after an app restart a node armed
 * with `awaitSetupGroup` has no run to hear from ever again, and reading "nothing known" as
 * "still running" would strand it forever — the same reasoning as a deleted dependency counting
 * as satisfied. (The caller's probe applies the same rule to a group with no entry.)
 */
/**
 * Launches armed BY THIS PROCESS (canvas-control `--after`, `verify`, cold-open arming), keyed by
 * node id and bound to the launch CONTENT. Only these may auto-fire. A `pendingLaunch` that arrived from disk
 * (`.nodeterm/project.json` is git-shared, hostile input) or from a canvas-sync peer is displayed —
 * QUEUED badge, ▶ Run now — but never typed into a shell without a click: before this gate a cloned
 * project.json carrying `{after:[],command:"curl … | sh"}` executed the moment the canvas opened
 * (consort security CRITICAL, 2026-09-02). Module-level and in-memory on purpose: forgetting on
 * reload is exactly what "loaded launches need consent" means. Applied at the ONE fire site in
 * Canvas (`launchesToFire(...).filter(f => wasArmedThisSession(f.id))`), so `launchesToFire` itself
 * stays a pure dependency-satisfaction function.
 */
/** The exact launch a consent was given for — command + deps + setup gate. A consent is worth
 *  nothing if the payload under it can change: a canvas-sync peer may upsert the same node id with
 *  another command, so the registry binds id AND content, and the fire site re-derives the key from
 *  the node's CURRENT `pendingLaunch` (consort re-review CRITICAL, 2026-09-02). */
export function launchKey(p: PendingLaunch): string {
  return JSON.stringify([p.command, p.after, p.awaitSetupGroup ?? null])
}
const armedThisSession = new Map<string, string>()
export function markArmedThisSession(id: string, launch: PendingLaunch | undefined): void {
  if (!launch || !launch.command) return
  armedThisSession.set(id, launchKey(launch))
}
/** True only when THIS process armed `id` with exactly this launch (content-bound). */
export function wasArmedThisSession(id: string, current: PendingLaunch | undefined): boolean {
  if (!current) return false
  return armedThisSession.get(id) === launchKey(current)
}
/** A consent is consumed once the launch has been delivered (or dropped): it must not survive to
 *  authorize a later launch that reuses the id. */
export function forgetArmed(id: string): void {
  armedThisSession.delete(id)
}
/** Test hook only. */
export function resetArmedThisSession(): void {
  armedThisSession.clear()
}

/**
 * The ONE in-flight registry for held-launch deliveries, shared by the two paths that can type a
 * `pendingLaunch` into a shell: the canvas fire effect (consented launches) and the node's manual
 * ▶ Run now (the click is the consent). They used to keep independent latches (a Canvas ref and a
 * TerminalNode ref) that could not see each other, so a consented launch whose canvas `sendText`
 * was mid-flight could be submitted a second time by ▶ (consort review SERIOUS, 2026-09-02).
 *
 * Keyed by node id, bound to the launch CONTENT (`launchKey`) for the same reason the consent
 * registry is: a settle callback must act on the launch it SENT, not on whatever the node holds by
 * the time the promise resolves — a canvas-sync peer may have replaced it meanwhile, and then a
 * landed A must not clear B, and a refused A must not mark B failed. `beginLaunch` is the only way
 * in and it is synchronous, so a double-click, a fire-effect re-run and a ▶ during a canvas send
 * all see the same entry. Module-level like the consent registry; nothing here is persisted.
 */
const launchesInFlight = new Map<string, string>()

/**
 * Claim `id` for one delivery attempt. Returns the key the caller must hand back to `settleLaunch`,
 * or `null` when a delivery for this node is already outstanding — in which case the caller sends
 * NOTHING. Refuses on the id alone (not id+content): two concurrent sends into one pty is never
 * what anyone meant, whatever they carry.
 */
export function beginLaunch(id: string, launch: PendingLaunch): string | null {
  if (launchesInFlight.has(id)) return null
  const key = launchKey(launch)
  launchesInFlight.set(id, key)
  return key
}

export function isLaunchInFlight(id: string): boolean {
  return launchesInFlight.has(id)
}

/**
 * What a settled delivery means for the node. `landed`/`refused` speak about the launch that was
 * sent AND is still the one on the node; `stale` means the node's launch changed (or went away)
 * while the send was in flight, so the outcome says nothing about what the node holds now — the
 * caller must neither clear it nor mark it failed.
 */
export type LaunchVerdict = 'landed' | 'refused' | 'stale'

/**
 * Settle the attempt `beginLaunch` opened. Releases the in-flight claim (only if it is still OURS —
 * a stale settle must not free a newer launch's claim) and decides the verdict against the node's
 * CURRENT `pendingLaunch`, which the caller reads fresh at settle time (store / nodesRef), never
 * from its own closure. `ok=false` covers both a refusal (`sendText` resolved false) and a
 * REJECTED RPC (relay closed, `failPending()`): a rejection used to have no handler at all, which
 * left the manual latch set forever and ▶ dead until remount. Every settle path is pure and
 * synchronous so the sequences above are unit-testable without React.
 */
export function settleLaunch(
  id: string,
  sentKey: string,
  ok: boolean,
  current: PendingLaunch | undefined
): LaunchVerdict {
  // A landed send consumed the consent WHEREVER it landed: the command was typed into a shell, so
  // even a stale settle (the node's launch changed, or the user switched projects before it
  // landed and this canvas cannot see the node) must not leave a consent that would auto-type it
  // AGAIN when that node is next on screen (consort re-review SERIOUS, 2026-09-03). The node then
  // shows QUEUED with ▶ as the manual way onward — no replay, no loss.
  if (ok) forgetArmed(id)
  // No claim, or not OUR claim ⇒ this settle belongs to a send that was abandoned (the node was
  // removed / replaced wholesale while it was in flight — see abandonLaunch) or already settled.
  // Two node lifetimes can carry the same launchKey (delete + undo, peer remove + re-add), so the
  // content match alone must not be allowed to clear the RESTORED launch on the strength of a send
  // that went into the session the removal destroyed.
  if (launchesInFlight.get(id) !== sentKey) return 'stale'
  launchesInFlight.delete(id)
  if (!current || launchKey(current) !== sentKey) return 'stale'
  return ok ? 'landed' : 'refused'
}

/**
 * The node is gone (deleted, removed by a peer or the phone, dropped by a whole-project reload):
 * whatever send is outstanding for it now belongs to a session that no longer exists, so its settle
 * must find no claim and touch nothing. Called beside `forgetArmed` on every removal path.
 */
export function abandonLaunch(id: string): void {
  launchesInFlight.delete(id)
}

/**
 * After a WHOLESALE replacement of the active project's node list (an external-change reload of
 * the .nodeterm file, the conflict bar's "reload", the legacy phone mutation result): every consent
 * and every in-flight claim whose node is no longer in the list, or whose launch content differs
 * from what was consented to / sent, is dropped. The per-node removal paths cannot see these — the
 * list is swapped underneath them — and without this a node removed by a reload and restored later
 * with the same id and content inherited this process's consent (consort re-review, 2026-09-03).
 * NOT called on a project switch: a cold-open `--project` arming relies on its consent surviving the
 * interval in which its nodes are not the live list.
 */
export function pruneArmed(nodes: readonly { id: string; pendingLaunch?: PendingLaunch }[]): void {
  const current = new Map<string, PendingLaunch | undefined>()
  for (const n of nodes) current.set(n.id, n.pendingLaunch)
  const keep = (id: string, key: string): boolean => {
    const p = current.get(id)
    return !!p && launchKey(p) === key
  }
  for (const [id, key] of armedThisSession) if (!keep(id, key)) armedThisSession.delete(id)
  for (const [id, key] of launchesInFlight) if (!keep(id, key)) launchesInFlight.delete(id)
}

/** Test hook only. */
export function resetLaunchesInFlight(): void {
  launchesInFlight.clear()
}

export function launchesToFire(
  nodes: readonly ArmedNode[],
  status: StatusById,
  live: ReadonlySet<string>,
  setupDone?: (groupId: string) => boolean,
  deliveries?: Record<string, LaunchDelivery | undefined>,
  pr?: PrGateContext,
  success?: SuccessGateContext,
  /** Stations with unfinished handed-over work — never a satisfied dep (see `depSatisfied`). */
  handovers?: HandoverById
): LaunchToFire[] {
  const out: LaunchToFire[] = []
  for (const n of nodes) {
    const p = n.data.pendingLaunch
    if (!p || !p.command || p.manualOnly || p.executor === 'server') continue
    if (deliveries?.[n.id]?.kind === 'failed') continue
    // A headless start (#925) owns this pane and is typing the launch into it. Its claim makes the
    // node manualOnly, which the guard above already skips; this covers a live copy that has not
    // caught up with the claim yet while the store already says so.
    if (deliveries?.[n.id]?.kind === 'starting') continue
    if (p.awaitSetupGroup && !(setupDone?.(p.awaitSetupGroup) ?? true)) continue
    // The THIRD gate (`--after-pr`). Unlike the setup gate, an absent context is CLOSED: a caller
    // that did not say what the pull requests look like has told us nothing, and "no news" is
    // exactly what must never release a launch (the same rule as an unknown agent state).
    if (p.afterPr && !(pr && prHoldSatisfied(p.afterPr, pr.board, pr.now))) continue
    // The FOURTH gate (`--after-success`): every named station reported SUCCESS and its turn is over.
    // Closed without a context, for the same reason as the PR gate: no news is never a success.
    // Re-read through the shape rule: live node data can arrive by a path that did not cross a
    // serializer seam (a peer's canvas mutation), and a malformed hold must hold, never throw.
    const successHold = normalizeSuccessWaitHold(p.afterSuccess)
    if (
      successHold &&
      !(
        success &&
        successWaitSatisfied(
          successHold,
          (d) => successDepFacts(d, status, live, success.outcomes, handovers),
          success.now
        )
      )
    )
      continue
    if (p.after.every((d) => depSatisfied(d, status, live, handovers))) {
      out.push({ id: n.id, command: p.command, ...(p.promptFile ? { briefFile: p.promptFile } : {}) })
    }
  }
  return out
}

/** The deps an armed node is still waiting on — what the node badge and tooltip report. */
export function unmetDeps(
  node: ArmedNode,
  status: StatusById,
  live: ReadonlySet<string>,
  handovers?: HandoverById
): string[] {
  const p = node.data.pendingLaunch
  if (!p) return []
  return p.after.filter((d) => !depSatisfied(d, status, live, handovers))
}

export interface DependencyEdge {
  id: string
  source: string
  target: string
}

/**
 * The dashed dep→node edges to draw for everything still waiting. Derived from node data on
 * every render rather than persisted as edges: a pending dependency is a STATE, not a durable
 * relation, and it disappears when the launch fires. (The durable relation `--after` also
 * creates is an ordinary context bridge, so the downstream node can still read its upstream
 * long after the arrow is gone.)
 */
export function dependencyEdges(
  nodes: readonly ArmedNode[],
  live: ReadonlySet<string>
): DependencyEdge[] {
  const out: DependencyEdge[] = []
  for (const n of nodes) {
    for (const dep of n.data.pendingLaunch?.after ?? []) {
      // A dep that is gone draws nothing — it is already satisfied, and an edge to a node that
      // isn't there would be dropped by React Flow anyway.
      if (live.has(dep)) out.push({ id: `dep-${dep}-${n.id}`, source: dep, target: n.id })
    }
  }
  return out
}

/**
 * How long an armed node whose gate is OPEN may sit with no terminal to deliver into before the
 * badge says so. It is a WARNING, not a deadline: the launch is still held and still fires the
 * moment the session comes up (an SSH host that reconnects, a spawn behind a slow `npm ci`).
 *
 * Chosen well past a cold project switch on a loaded canvas, so an ordinary open never trips it.
 */
export const LAUNCH_STALL_MS = 45_000

/**
 * What the delivery loop has to say about ONE armed node's held launch — the visible half of the
 * two failure modes that used to be a `console.warn` nobody reads. Declared here rather than in
 * the store so the rendering below stays pure and testable; the store only holds it.
 */
export type LaunchDelivery =
  | { kind: 'stalled'; since: number }
  | { kind: 'failed'; attempts: number; at: number }
  /** A headless start (#925) is in flight: core owns the pane, so ▶ must not type into it. */
  | { kind: 'starting'; since: number }
  /** The file the launch reads its prompt from was gone at delivery: held for ▶, never typed. */
  | { kind: 'brief-missing'; path: string; at: number }

/**
 * Which delivery records the Canvas sweep retires: every record whose node is no longer an armed
 * node on the ACTIVE canvas (delivered, run by hand with ▶, deleted, or in another project) —
 * EXCEPT a `starting` one. A headless start (#925) runs precisely for a node that is not on the
 * active canvas, and its orchestrator owns the record end to end (`clear` on success or
 * not-persistent, `markFailed` otherwise). Retiring it here would re-enable ▶ the moment the user
 * switched to that project mid-start — the manualOnly claim alone reads as a failed launch — and ▶
 * would then type into a pane core is still typing into.
 */
export function deliveriesToRetire(
  byId: Record<string, LaunchDelivery | undefined>,
  isArmedOnCanvas: (nodeId: string) => boolean
): string[] {
  return Object.keys(byId).filter((id) => byId[id]?.kind !== 'starting' && !isArmedOnCanvas(id))
}

/**
 * The QUEUED badge's tooltip. One function for every case so the sentences cannot drift, and
 * so the two warnings are held to the same standard as the ordinary one: say what is true, name
 * what would fix it, and never claim a cause that was not measured.
 *
 * `stalled` is careful about that last point. We know the terminal has not come up; we do NOT know
 * why (a host that is down, a spawn that failed, a machine under load all look identical from
 * here), so the text says what we observed and leaves the diagnosis to the node's own overlay,
 * which does know.
 *
 * `starting` comes first, ahead even of the relay sentence: while core is typing the launch, no
 * sentence may offer ▶, and "waiting for X" would describe a wait that is already over.
 */
export function launchTooltip(
  delivery: LaunchDelivery | undefined,
  waitingOn: string,
  command: string,
  erroredOn?: string,
  relay = false,
  /** The node's `--after-pr` wait: what is still unmet (`prHoldSummary`), whether it has passed
   *  its deadline, and that deadline as the caller formats it (a locale string is not pure). */
  pr?: { expired: boolean; summary: string; deadline: string },
  /** The node's `--after-success` wait: where it stands (`successWaitStatus`), the unmet stations
   *  (`successWaitSummary`), and its deadline as the caller formats it. */
  success?: { status: 'met' | 'waiting' | 'blocked' | 'expired'; summary: string; deadline: string },
  /** The deps held because the user interrupted their last turn (`interruptedDeps`). */
  interruptedOn?: string,
  /** The deps that were handed new work they have not finished (core/station-handover.ts), named. */
  handedOverOn?: string
): string {
  if (delivery?.kind === 'starting') return 'Starting in the background — an agent asked for this session to run now.'
  const runs = `Runs:\n${command}`
  if (relay) return `Launch delivery from a relay tab is unavailable. Open the host to run this command.\n${runs}`
  // Checked right before typing: the file the prompt is read from went away (a spill outlived its
  // TTL while a cold-opened node waited, or a `--prompt-file` was deleted). Typing the command would
  // start the agent with an empty prompt, so it is held, and ▶ is the human's call.
  if (delivery?.kind === 'brief-missing')
    return (
      `The file this launch reads its prompt from no longer exists:\n${delivery.path}\n` +
      'It was not started, because the agent would get no brief. Open the node again with its ' +
      `prompt, or press \u25b6 to run it anyway.\n${runs}`
    )
  if (delivery?.kind === 'failed')
    return (
      'Launch delivery is unconfirmed; automatic retry is stopped.\n' +
      `Inspect the terminal, then press \u25b6 to retry at a shell prompt.\n${runs}`
    )
  // Issue #521: an errored upstream is idle, so without this the tooltip would say "waiting for X
  // to finish" about a station that finished twenty minutes ago. Named first, because it is the
  // one case where waiting will not end on its own.
  if (erroredOn)
    return (
      `${erroredOn} ended its last turn on an error, so this is held rather than started on ` +
      'what it did not produce.\n' +
      `Retry or nudge it — a successful turn releases this — or press ▶ to run it now.\n${runs}`
    )
  // Same shape: an interrupted upstream is idle, and nothing will release this on its own.
  if (interruptedOn)
    return (
      `${interruptedOn} was interrupted before its turn finished, so this is held rather than ` +
      'started on unfinished work.\n' +
      `Give it its next prompt — a turn that finishes releases this — or press ▶ to run it now.\n${runs}`
    )
  // A wait that passed its deadline will not end on its own either — the one other case where
  // "waiting for" would be a promise nobody keeps.
  if (pr?.expired)
    return (
      `The wait on pull requests passed its deadline (${pr.deadline}), so this will not start on ` +
      'its own.\n' +
      `Press \u25b6 to run it now.\n${runs}`
    )
  if (success?.status === 'expired')
    return (
      `The wait for stations to report success passed its deadline (${success.deadline}), so this ` +
      'will not start on its own.\n' +
      `Press \u25b6 to run it now.\n${runs}`
    )
  // A reported failure is the other wait that will not end on its own: named, with both ways out.
  if (success?.status === 'blocked')
    return (
      `Held on ${success.summary}.\n` +
      'It does not start on a task that did not succeed. Retry that station — this starts when it ' +
      `reports success — or press \u25b6 to run it now.\n${runs}`
    )
  if (delivery?.kind === 'stalled')
    return (
      'Ready to run, but this terminal has not started yet — the launch is still held and ' +
      'fires as soon as it does.\n' +
      `Press \u25b6 to try it now.\n${runs}`
    )
  // A station that just got new work still reads `done` from its previous task; saying "waiting for
  // X to finish" alone would read as a wait that should already be over.
  if (handedOverOn)
    return (
      `Waiting for ${handedOverOn} to finish — a turn that ended before that work was done does not ` +
      `count${waitingOn ? ` (all waits: ${waitingOn})` : ''}, then runs:\n${command}`
    )
  if (success?.status === 'waiting') {
    // `waitingOn` here is the caller's list of the OTHER stations (plain `--after`), if any.
    const stations = waitingOn ? `${waitingOn} to finish and for ` : ''
    const prs = pr?.summary ? `, and for ${pr.summary}` : ''
    return (
      `Waiting for ${stations}a reported success from ${success.summary}${prs}, until ` +
      `${success.deadline}, then runs:\n${command}`
    )
  }
  if (pr?.summary) {
    const stations = waitingOn ? `${waitingOn} to finish and for ` : ''
    return `Waiting for ${stations}${pr.summary}, until ${pr.deadline}, then runs:\n${command}`
  }
  return waitingOn
    ? `Waiting for ${waitingOn} to finish, then runs:\n${command}`
    : `Queued; waiting for launch delivery.\n${runs}`
}
