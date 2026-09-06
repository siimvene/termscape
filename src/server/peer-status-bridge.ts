// Peer agent-status bridge (self-host fork): surface ANOTHER nodeterm instance's agent states
// on this Server Edition.
//
// Why this exists: a session's hooks POST to the hook server of the instance that SPAWNED it.
// On a machine running both the desktop app and the Server Edition against the same shared
// project files (the phone-desktop bridge), every desktop-spawned session is invisible to the
// server's hook flow — the phone showed UNKNOWN for all of them. The desktop already publishes
// exactly the needed facts for its own mobile companion: the agent-status MIRROR file
// (`<userData>/agent-status.json`, src/core/agent-status-mirror.ts). This module tails that
// file and re-broadcasts its per-node states as `agent:status` events.
//
// Rules:
// - Inert unless `NODETERM_PEER_STATUS_MIRROR` names the peer's mirror file (the launchd
//   wrapper sets it on the Mac; a future Linux server has no desktop peer and leaves it unset).
// - The server's OWN hook flow wins: a node this instance has live state for is never
//   overwritten by the peer file (`ownState` seam; disjoint by construction — a session POSTs
//   to its spawner — but the -D viewer fight taught us not to trust "by construction").
// - Change-gated: a node is re-broadcast only when its (state, sessionId, name, updatedAt)
//   tuple changes, so the file's frequent rewrites don't spam every WS client.
// - The mirror is replaced by atomic rename, so fs.watch is aimed at the DIRECTORY; a slow
//   poll backstops missed rename events (fs.watch on macOS is best-effort).
import * as fs from 'fs'
import * as path from 'path'
import { IPC } from '../shared/ipc'
import { nodeState } from '../core/agent-status-mirror'
import type { AgentState, NormalizedAgentEvent } from '../shared/agents/normalize'

const POLL_MS = 15_000

const STATES: ReadonlySet<string> = new Set(['working', 'waiting', 'blocked', 'done'])

interface PeerNode {
  state: AgentState
  agentId?: string
  sessionId?: string
  name?: string
  updatedAt?: number
}

/** Read the mirror's raw JSON once — shared by the node reader and the usage reader. */
function readMirrorJson(file: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Bounded copy of one string field, or undefined when absent / not a string. Same discipline as
 *  `readPeerMirror` below: the mirror is a same-user file, but its strings land verbatim in every
 *  WS client's store, so they are clamped rather than trusted forever (consort finding, applied
 *  here too on the security side-pass that reviewed the Codex rows). */
function boundedStr(v: unknown, max: number): string | undefined {
  return typeof v === 'string' ? v.slice(0, max) : undefined
}
const finiteNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

/** One usage row, whitelisted to the `MirrorUsageAccount` shape (agent-status-mirror.ts) with every
 *  string clamped; `null` for anything that is not a row. Only fields PRESENT in the source are
 *  emitted (the phone decodes tolerantly and defaults the rest), and unknown fields are dropped so an
 *  arbitrary object shape never reaches a client's render path. */
function readUsageAccount(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const a = v as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (a.accountId === null) out.accountId = null
  else if (typeof a.accountId === 'string') out.accountId = a.accountId.slice(0, 128)
  const label = boundedStr(a.label, 200)
  if (label !== undefined) out.label = label
  else if (a.label === null) out.label = null
  const email = boundedStr(a.email, 320)
  if (email !== undefined) out.email = email
  else if (a.email === null) out.email = null
  const agentId = boundedStr(a.agentId, 64)
  if (agentId !== undefined) out.agentId = agentId
  const status = boundedStr(a.status, 32)
  if (status !== undefined) out.status = status
  const updatedAt = finiteNum(a.updatedAt)
  if (updatedAt !== undefined) out.updatedAt = updatedAt
  if (Array.isArray(a.limits)) {
    const limits: Record<string, unknown>[] = []
    for (const l of a.limits) {
      if (typeof l !== 'object' || l === null || Array.isArray(l)) continue
      const lim = l as Record<string, unknown>
      const kind = boundedStr(lim.kind, 64)
      const usedPercent = finiteNum(lim.usedPercent)
      if (kind === undefined || usedPercent === undefined) continue
      const o: Record<string, unknown> = { kind, usedPercent }
      for (const k of ['group', 'severity', 'scopeLabel'] as const) {
        const s = boundedStr(lim[k], 200)
        if (s !== undefined) o[k] = s
        else if (lim[k] === null) o[k] = null
      }
      for (const k of ['resetsAt', 'windowMinutes'] as const) {
        const n = finiteNum(lim[k])
        if (n !== undefined) o[k] = n
        else if (lim[k] === null) o[k] = null
      }
      if (typeof lim.isActive === 'boolean') o.isActive = lim.isActive
      limits.push(o)
    }
    out.limits = limits
  }
  return out
}

/** Pass the mirror's `usage` block through, validated row by row (the desktop wrote it; the phone
 *  renders it): malformed rows are dropped, strings are bounded, unknown fields never cross. Returns
 *  null when the block is absent/malformed so the bridge can skip the broadcast. */
export function readPeerUsage(file: string): { updatedAt: number; accounts: unknown[] } | null {
  const raw = readMirrorJson(file)
  const u = raw?.usage
  if (typeof u !== 'object' || u === null) return null
  const accounts = (u as { accounts?: unknown }).accounts
  if (!Array.isArray(accounts)) return null
  const updatedAt = (u as { updatedAt?: unknown }).updatedAt
  return {
    updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
    accounts: accounts.map(readUsageAccount).filter((a): a is Record<string, unknown> => a !== null)
  }
}

/** Tolerant read of a peer mirror file: absent/corrupt/foreign-shaped → empty map, never throw. */
export function readPeerMirror(file: string): Map<string, PeerNode> {
  const out = new Map<string, PeerNode>()
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return out
  }
  if (typeof raw !== 'object' || raw === null) return out
  const nodes = (raw as { nodes?: unknown }).nodes
  if (typeof nodes !== 'object' || nodes === null) return out
  for (const [nodeId, v] of Object.entries(nodes as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) continue
    const n = v as Record<string, unknown>
    if (typeof n.state !== 'string' || !STATES.has(n.state)) continue
    // Length clamps: the mirror is a same-user file, but its strings land verbatim in every WS
    // client's store — bound them rather than trust the writer forever (consort finding).
    if (nodeId.length > 128) continue
    const str = (v: unknown, max: number): string | undefined =>
      typeof v === 'string' && v.length <= max ? v : undefined
    out.set(nodeId, {
      state: n.state as AgentState,
      agentId: str(n.agentId, 64),
      sessionId: str(n.sessionId, 128),
      name: typeof n.name === 'string' ? n.name.slice(0, 200) : undefined,
      updatedAt: typeof n.updatedAt === 'number' ? n.updatedAt : undefined
    })
  }
  return out
}

export interface PeerBridgeDeps {
  broadcast: (channel: string, payload: unknown) => void
  /** This instance's own live state for a node — peer data never overrides it. */
  ownState?: (nodeId: string) => AgentState | undefined
  watch?: boolean
}

/**
 * Start tailing `file` and re-broadcasting its states. Returns a stop function.
 * Events are NormalizedAgentEvent-shaped `kind:'state'` pushes, plus `sessionTitle` piggybacked
 * for clients that render names (the mirror is the ONLY place desktop session names exist —
 * the `sessionTitle` field on live hook events is declared but never emitted).
 */
export function startPeerStatusBridge(file: string, deps: PeerBridgeDeps): () => void {
  const own = deps.ownState ?? nodeState
  const last = new Map<string, string>()
  let lastUsageAt = -1

  const sweep = (full = false) => {
    // Account usage (Settings → Usage on the phone). The desktop mirror already carries every
    // local account's rate-limit snapshot; forward it change-gated on `updatedAt`, and replay in
    // full on the poll tick so a late-joining WS client is not stuck without numbers.
    const usage = readPeerUsage(file)
    if (usage && (full || usage.updatedAt !== lastUsageAt)) {
      lastUsageAt = usage.updatedAt
      deps.broadcast(IPC.accountsUsage, usage)
    }
    const seen = new Set<string>()
    for (const [nodeId, n] of readPeerMirror(file)) {
      if (own(nodeId) !== undefined) continue
      seen.add(nodeId)
      const key = `${n.state} ${n.sessionId ?? ''} ${n.name ?? ''} ${n.updatedAt ?? 0}`
      // `full` skips the change gate: WS clients that connected after a state was first
      // broadcast would otherwise read UNKNOWN until the peer changes something — the poll
      // tick doubles as the late-joiner replay (consort finding).
      if (!full && last.get(nodeId) === key) continue
      last.set(nodeId, key)
      const ev: NormalizedAgentEvent = {
        nodeId,
        agentId: n.agentId ?? 'claude',
        kind: 'state',
        state: n.state,
        sessionId: n.sessionId,
        sessionTitle: n.name
      }
      deps.broadcast(IPC.agentStatus, ev)
    }
    // A node that VANISHED from the mirror (closed on the peer) must not stay frozen on every
    // client — a session-end event resets it to unknown (consort finding).
    for (const nodeId of [...last.keys()]) {
      if (seen.has(nodeId)) continue
      last.delete(nodeId)
      const ev: NormalizedAgentEvent = {
        nodeId,
        agentId: 'claude',
        kind: 'session',
        sessionPhase: 'end'
      }
      deps.broadcast(IPC.agentStatus, ev)
    }
  }

  sweep()
  let watcher: fs.FSWatcher | undefined
  if (deps.watch !== false) {
    try {
      watcher = fs.watch(path.dirname(file), (_e, name) => {
        if (name === path.basename(file)) sweep()
      })
    } catch {
      /* directory missing: the poll below still covers a later appearance */
    }
  }
  const timer = setInterval(() => sweep(true), POLL_MS)
  timer.unref?.()
  return () => {
    watcher?.close()
    clearInterval(timer)
  }
}

/** Boot seam: start the bridge iff the env var names a peer mirror. */
export function maybeStartPeerStatusBridge(
  broadcast: PeerBridgeDeps['broadcast'],
  env: NodeJS.ProcessEnv = process.env
): (() => void) | undefined {
  const file = (env.NODETERM_PEER_STATUS_MIRROR || '').trim()
  if (!file) return undefined
  console.log(`peer-status bridge: tailing ${file}`)
  return startPeerStatusBridge(file, { broadcast })
}
