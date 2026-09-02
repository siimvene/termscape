// Pure logic for ARMED terminal nodes — the canvas-control `--after` dependency edge. A node
// opened with `--after <ids>` holds its launch command (see PendingLaunch in @shared/types)
// until every station it waits on has gone idle; this module decides when that is, and which
// dependency edges to draw meanwhile. Kept free of React/store imports so the satisfaction
// matrix is unit-testable — Canvas.tsx only wraps these in an effect and a setState.
import type { AgentState } from '@shared/agents/normalize'
import type { PendingLaunch } from '@shared/types'

/** The subset of a canvas node this module reads. */
export interface ArmedNode {
  id: string
  data: { pendingLaunch?: PendingLaunch }
}

/** The subset of the agentStatus store this module reads. */
export type StatusById = Record<
  string,
  { state?: AgentState; lastTurnError?: { at: number } } | undefined
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
 */
function depSatisfied(depId: string, status: StatusById, live: ReadonlySet<string>): boolean {
  if (!live.has(depId)) return true
  const st = status[depId]
  return st?.state === 'done' && !st.lastTurnError
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
  setupDone?: (groupId: string) => boolean
): LaunchToFire[] {
  const out: LaunchToFire[] = []
  for (const n of nodes) {
    const p = n.data.pendingLaunch
    if (!p || !p.command) continue
    if (p.awaitSetupGroup && !(setupDone?.(p.awaitSetupGroup) ?? true)) continue
    if (p.after.every((d) => depSatisfied(d, status, live))) out.push({ id: n.id, command: p.command })
  }
  return out
}

/** The deps an armed node is still waiting on — what the node badge and tooltip report. */
export function unmetDeps(
  node: ArmedNode,
  status: StatusById,
  live: ReadonlySet<string>
): string[] {
  const p = node.data.pendingLaunch
  if (!p) return []
  return p.after.filter((d) => !depSatisfied(d, status, live))
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
 * The backoff between delivery attempts, in milliseconds, indexed by the number of attempts
 * ALREADY made. `null` = the schedule is exhausted; the launch has failed for good.
 *
 * This replaces a flat 5 × 400 ms budget (2 s from the moment the canvas mounted the node) that
 * measured the wrong thing entirely: it started when the CANVAS decided the node was ready to
 * launch, and spent itself while the terminal was still being spawned. A cold project switch —
 * load the canvas, mount the node, spawn tmux, settle the shell — routinely costs more than two
 * seconds, so the launch was abandoned before the session it was meant for existed. That is
 * issue #569 item 1: a node that says QUEUED forever with no way to tell it apart from one that
 * is simply waiting on a dependency.
 *
 * The fix is mostly NOT here: delivery is now gated on the node reporting its session ready
 * (`isSessionReady`), so the schedule below only has to cover the residual race between "the
 * shell settled" and "tmux will accept a paste for this session". It is nevertheless generous
 * and bounded — roughly 12 s of backoff across six attempts (`LAUNCH_DELIVERY_ATTEMPTS`) — because
 * the alternative to a bound is a retry loop nobody can see the end of.
 */
const LAUNCH_RETRY_SCHEDULE_MS = [400, 800, 1600, 3200, 6400] as const

export function launchRetryDelay(attemptsMade: number): number | null {
  return LAUNCH_RETRY_SCHEDULE_MS[attemptsMade - 1] ?? null
}

/**
 * Total SENDS a refused delivery gets before it is reported as failed. The schedule above is the
 * gaps BETWEEN sends, so it is one shorter than the attempt count: attempt n is followed by
 * `launchRetryDelay(n)`, and the send after the last gap is the final attempt (`launchRetryDelay`
 * of it is null). This used to equal the schedule length, which under-counted the sends by one
 * (six went out while the constant, and the copy derived from it, said five).
 */
export const LAUNCH_DELIVERY_ATTEMPTS = LAUNCH_RETRY_SCHEDULE_MS.length + 1

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

/**
 * The QUEUED badge's tooltip. One function for all three cases so the sentences cannot drift, and
 * so the two warnings are held to the same standard as the ordinary one: say what is true, name
 * what would fix it, and never claim a cause that was not measured.
 *
 * `stalled` is careful about that last point. We know the terminal has not come up; we do NOT know
 * why (a host that is down, a spawn that failed, a machine under load all look identical from
 * here), so the text says what we observed and leaves the diagnosis to the node's own overlay,
 * which does know.
 */
export function launchTooltip(
  delivery: LaunchDelivery | undefined,
  waitingOn: string,
  command: string,
  erroredOn?: string
): string {
  const runs = `Runs:\n${command}`
  // Issue #521: an errored upstream is idle, so without this the tooltip would say "waiting for X
  // to finish" about a station that finished twenty minutes ago. Named first, because it is the
  // one case where waiting will not end on its own.
  if (erroredOn)
    return (
      `${erroredOn} ended its last turn on an error, so this is held rather than started on ` +
      'what it did not produce.\n' +
      `Retry or nudge it — a successful turn releases this — or press ▶ to run it now.\n${runs}`
    )
  if (delivery?.kind === 'failed')
    return (
      `This session did not accept its launch — ${delivery.attempts} ` +
      `attempt${delivery.attempts === 1 ? ' was' : 's were'} refused, and nothing will retry it.\n` +
      `Press \u25b6 to run it now.\n${runs}`
    )
  if (delivery?.kind === 'stalled')
    return (
      'Ready to run, but this terminal has not started yet — the launch is still held and ' +
      'fires as soon as it does.\n' +
      `Press \u25b6 to try it now.\n${runs}`
    )
  return `Waiting for ${waitingOn} to finish, then runs:\n${command}`
}
