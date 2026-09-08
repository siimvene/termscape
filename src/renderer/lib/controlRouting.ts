// WHICH CANVAS answers a canvas-control request — the routing half of the `nodeterm` CLI's
// authorization boundary (Canvas's onAgentControl effect). Pure, so it is unit-testable where the
// React component is not (vitest runs in the node environment); same reasoning as presenceTravel,
// whose project-travel rules this reuses.
//
// WHY IT EXISTS: React Flow only ever holds the ACTIVE project's nodes, but tmux sessions of every
// OTHER open project keep running — they survive an app restart and are re-adopted on boot. Their
// agents still hold NODETERM_CANVAS_CONTROL and still reach the (rewritten) hook endpoint, so their
// control calls arrive at a canvas that has never heard of the source node. Looking the source up
// in the live canvas alone therefore rejected every agent outside the project the app happened to
// come up on — reported as "source node is not a control-capable agent", which is what a node
// carrying a non-control agent gets, so the failure read as a lost capability rather than as the
// wrong canvas answering. Resolve the OWNING project instead and answer out of ITS serialized
// nodes — never by switching the user's view to it (see LIVE_ONLY_VERBS below for the contract).

import { canControlCanvas, type AgentId } from '@shared/agents/config'
import { projectTravel } from './presenceTravel'
import {
  projectCapabilityGrantedFor,
  type CapabilityAckMap
} from '@shared/project-capability-consent'

/** The little the routing needs to know about a project (a structural subset of `Project`). */
export interface ControlProject {
  id: string
  closed?: boolean
  unavailable?: boolean
  nodes: readonly { id: string }[]
}

/**
 * Where a control request must be applied:
 * - `active`  — the source is on the live canvas (or its project is already active): apply here.
 * - `switch`  — an open project that is NOT on screen: answer from its serialized store.
 * - `reopen`  — a closed project (its sessions still run): answer from its store; it stays closed.
 * - `blocked` — a project whose files are unreadable: there is no store to answer from.
 * - `unknown` — no open project owns this node id.
 * The kind names are the ones `projectTravel` (presence) uses, because the ownership rule is the
 * same; what Canvas DOES with `switch`/`reopen` here is answer from the store, never travel.
 */
export type ControlRoute =
  | { kind: 'active' }
  | { kind: 'switch'; projectId: string }
  | { kind: 'reopen'; projectId: string }
  | { kind: 'blocked'; projectId: string }
  | { kind: 'unknown' }

/** Which project owns `sourceNodeId`, and what Canvas must do to be able to act on it. */
export function routeControlSource(
  projects: readonly ControlProject[],
  activeProjectId: string,
  sourceNodeId: string
): ControlRoute {
  const owner = projects.find((p) => p.nodes.some((n) => n.id === sourceNodeId))
  if (!owner) return { kind: 'unknown' }
  const travel = projectTravel(
    projects.map((p) => ({ id: p.id, closed: p.closed, unavailable: p.unavailable, nodes: [] })),
    activeProjectId,
    owner.id
  )
  // `none` means "already there" — the live canvas is the right one even if its store copy lags.
  if (travel.kind === 'none') return { kind: 'active' }
  if (travel.kind === 'blocked') return { kind: 'blocked', projectId: owner.id }
  return travel
}

/**
 * Verbs that can ONLY run against the LIVE canvas — and are therefore REFUSED (never travelled to)
 * when their source node lives in a project that is not on screen.
 *
 * The contract, in one sentence: **a canvas-control call never switches the user's view.** Routing
 * is by SOURCE (`routeControlSource(projects, activeId, sourceNodeId)`), so the old "travel to the
 * owning project first" rule meant that any agent in a background project issuing a verb yanked
 * the human away from whatever they were doing — most visibly at the end of a task, when an
 * orchestrator opens its review node, moves its kanban card, or closes its stations. Every verb
 * that creates, reads or edits NODES is now answered from the owning project's SERIALIZED store
 * (`Canvas.tsx`'s store-backed `ControlSurface`): the write lands in the same nodes the next
 * whole-file save writes and the project load reads, and a session opened this way is armed for
 * cold open — it starts when that project is next viewed, exactly the `--project` contract.
 *
 * What stays here is what has no store representation at all:
 * - `open-worktree` / `close-worktree` — the worktree registry (`useWorktrees`) and the
 *   project-setup runs are bound to the ACTIVE project's checkout; a binding minted for a project
 *   that is not loaded would be reconciled against the wrong repo.
 * - `branch` — restarts a RUNNING session's pane through the live node's own restart path.
 * - `browser` — drives a real `<webview>` guest, which exists only while its node is mounted.
 *
 * `send`/`reply`/`open-project` never reach the routing at all (Canvas.tsx dispatches them before
 * it), so they are not listed; the membership below is what `Canvas.tsx` consults AFTER the
 * source has been routed to a non-active project.
 */
export const LIVE_ONLY_VERBS: ReadonlySet<string> = new Set([
  'open-worktree',
  'close-worktree',
  'branch',
  'browser'
])

/**
 * Does this verb have to run against the LIVE canvas? True only for `LIVE_ONLY_VERBS`; everything
 * else is store-answerable when its source is off screen.
 */
export function needsLiveCanvas(verb: string): boolean {
  return LIVE_ONLY_VERBS.has(verb)
}

/** The refusal a live-only verb gets from a background project: named, terminal (the cause does
 *  not clear on its own), and explicit that the canvas will NOT switch on the agent's behalf. */
export function liveOnlyRefusal(verb: string, projectName: string): string {
  return (
    `${verb}: this project ("${projectName}") is not on screen, and ${verb} needs its live canvas — ` +
    "the view never switches on an agent's behalf; ask the user to open the project first"
  )
}

/**
 * The capability half of the guard: may a session in this node drive the canvas?
 *
 * The empty/absent default MIRRORS pty-manager's spawn-time default (`options.agentId ?? 'claude'`):
 * a plain terminal node received the claude hook env at spawn, so a manual `claude` there holds
 * NODETERM_CANVAS_CONTROL — rejecting it here would contradict the env it was handed.
 */
export function sourceIsControlCapable(agentId: unknown): boolean {
  const id = typeof agentId === 'string' && agentId ? agentId : 'claude'
  return canControlCanvas(id as AgentId)
}

/**
 * The `browser` verb's resolve answer — the two things ONLY the renderer knows, computed purely so
 * Canvas.tsx's IPC handler is a thin wrapper testable here. Main asks over `browserControlResolve`,
 * makes the security decision itself (owner + capability + CDP gate), and does the CDP work; this
 * function NEVER touches a debugger.
 *
 * WHY MAIN STILL DECIDES from these facts: an XSS-in-a-node-title-style bug lands in the renderer,
 * the more attackable half, so the allowlist and the ledger stay main-side. The renderer reports
 * facts (does this node's project exist, is the source control-capable, is the capability on right
 * now — read LIVE via `projectCapabilityGrantedFor`, never cached); main re-orders them into the
 * refusal decision in `browser-drive.ts`.
 */
export interface BrowserResolveNode {
  id: string
  agentId?: unknown
  /** The node's display title — reported so main can make the cookie-read trace human-readable
   *  (PR 9). Never a security input. */
  title?: string
}
export interface BrowserResolveProject {
  id: string
  cwd?: string
  agentBrowserControl?: boolean
  capabilityAck?: CapabilityAckMap
  nodes: readonly BrowserResolveNode[]
}
export type BrowserResolveAnswer =
  | { ok: false; refusal: string }
  | {
      ok: true
      projectId: string
      projectCwd?: string
      sourceControlCapable: boolean
      capabilityOn: boolean
      /** The owner (source) agent node's title and the driven browser node's title — for the cookie
       *  trace only. Empty string when unknown; main falls back to the node id. */
      sourceTitle: string
      browserTitle: string
    }

export function answerBrowserResolve(
  project: BrowserResolveProject | undefined,
  sourceNodeId: string,
  browserNodeId?: string
): BrowserResolveAnswer {
  // No open project owns the source, or the node is not on its canvas: a named, non-revoking
  // refusal. (Same class as every other verb's "source node is not on an open canvas".)
  if (!project) return { ok: false, refusal: 'source node is not on an open canvas' }
  const node = project.nodes.find((n) => n.id === sourceNodeId)
  if (!node) return { ok: false, refusal: 'source node is not on an open canvas' }
  const browserNode = browserNodeId ? project.nodes.find((n) => n.id === browserNodeId) : undefined
  return {
    ok: true,
    projectId: project.id,
    projectCwd: project.cwd,
    sourceControlCapable: sourceIsControlCapable(node.agentId),
    // LIVE read — the drive-time capability check the whole feature's safety rests on. A project.json
    // hand-edit that flipped the switch off is reflected here the next time an agent drives, which is
    // exactly drive time.
    capabilityOn: projectCapabilityGrantedFor(project, 'agentBrowserControl'),
    sourceTitle: typeof node.title === 'string' ? node.title : '',
    browserTitle: typeof browserNode?.title === 'string' ? browserNode.title : ''
  }
}
