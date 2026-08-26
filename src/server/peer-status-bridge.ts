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
    out.set(nodeId, {
      state: n.state as AgentState,
      agentId: typeof n.agentId === 'string' ? n.agentId : undefined,
      sessionId: typeof n.sessionId === 'string' ? n.sessionId : undefined,
      name: typeof n.name === 'string' ? n.name : undefined,
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

  const sweep = () => {
    for (const [nodeId, n] of readPeerMirror(file)) {
      if (own(nodeId) !== undefined) continue
      const key = `${n.state} ${n.sessionId ?? ''} ${n.name ?? ''} ${n.updatedAt ?? 0}`
      if (last.get(nodeId) === key) continue
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
  const timer = setInterval(sweep, POLL_MS)
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
