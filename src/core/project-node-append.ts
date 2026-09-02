// Pure append of a PHONE-REGISTERED terminal node into a project.json's raw text — the host side
// of the relay `projects.registerNode` verb (the phone's twin of this logic lives in
// nodeterm-ios ProjectNodeRegistrar and writes over direct SSH; both converge on one node shape).
//
// Works on the RAW parsed object, not the typed mirrors, so every field this version does not
// know (bridges, dino scores, future schema) round-trips untouched — the file is rewritten whole.
// Returns null whenever nothing must be written: unparsable/wrong-shape text (a file we couldn't
// parse must never be invented or overwritten), a duplicate id (a retry must not churn rev), or
// an unsafe id (it becomes a tmux session name).

import { agentConfig } from '../shared/agents/config'
import { boundAccountId } from '../shared/agents/account-binding'
import { isSafeNodeId } from '../shared/safe-id'
import { isSafeAccountId } from './claude-accounts-core'

/** What the phone is allowed to choose; everything else is host-derived. */
export interface RemoteNodeInput {
  id: string
  title?: string
  agentId?: string
  /**
   * Managed Claude account the phone actually launched the session under (its `CLAUDE_CONFIG_DIR`).
   * Not host-derivable: the desktop cannot tell from the outside which identity a session runs as,
   * and the DIRECT-SSH registration path has always written it. Dropping it off the relay leg meant
   * an off-LAN session started under account X registered as the SYSTEM account — after which every
   * reader scoped by account (transcript, context meter, find-bar index) resolved against the wrong
   * root, and a cold restore resumed the conversation under the wrong identity.
   */
  accountId?: string
}

/** The desktop id shape (`term-<base36 ms>-<token>`). Anything else is refused — the id is
 *  interpolated into tmux session names, so the alphabet stays strictly boring.
 *
 *  The tail was `\d{1,6}` while the desktop minted a monotonic counter. That counter restarted at
 *  zero on every renderer start (and every HMR reload), so it was a collision generator and is now
 *  a random hex token — and this guard, which is what the PHONE's ids are checked against, would
 *  have refused every id the phone mints once nodeterm-ios adopts the same shape. Widened to the
 *  same boring alphabet; an empty tail (`term-abc-`) is still refused. */
const SAFE_NODE_ID = /^term-[a-z0-9]+-[a-z0-9]{1,16}$/

/** One title ceiling for every host-side write of a client-supplied node title — the registrar's
 *  append below AND the relay `node.rename` verb (host-service) clamp to the same number, so a
 *  rename can never persist a title the registration path would have refused. */
export const TITLE_MAX = 120

/**
 * A `data.ssh` block usable as a donor: the two fields the pty manager needs to dial the host.
 * Half a spec is worse than none — it would produce a node that claims to be remote and cannot
 * connect.
 */
function isSshSpec(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const c = value as { host?: unknown; user?: unknown }
  return typeof c.host === 'string' && c.host !== '' && typeof c.user === 'string' && c.user !== ''
}

/**
 * Narrow an off-machine argument into the four fields a remote caller is allowed to choose, or
 * REFUSE it whole (`null`). Used by the `workspace:register-node` handler
 * (WorkspaceStore.registerIpc), where the payload arrives as JSON from a WS-RPC client rather than
 * from a typed in-process caller.
 *
 * It does NOT judge the VALUES — `appendProjectNode` below owns the id alphabet and the account
 * alphabet, and a second copy of those is the one that drifts. What it owns is the far narrower
 * question of whether each field is the right KIND of thing, and the answer to "no" is a refusal,
 * never a repair.
 *
 * That distinction is the whole point, and it was learned the expensive way. The first version
 * simply DROPPED a field of the wrong type, which reads as harmless until you follow `accountId`:
 * appendProjectNode deliberately refuses a bad one rather than writing the node without it (see the
 * comment at that check — quietly dropping it resurrects the wrong-identity bug the field exists to
 * fix), and dropping it HERE turned that refusal into dead code. A malformed request would have
 * been answered `true`, with the session silently registered against the system account: every
 * account-scoped reader then resolves in the wrong root, and a cold restore resumes the
 * conversation as the wrong identity. A request we cannot read is refused, not reinterpreted as a
 * different, weaker request that happens to be expressible.
 *
 * `null` is the one exception, and it is an interop rule rather than a leniency: a JSON encoder
 * asked to write an absent optional very commonly emits `null` (Swift's `encode` versus
 * `encodeIfPresent` is exactly this fork, and the client this serves is a Swift one), and no
 * field-level equivalent of the wire protocol's `undef` marker exists to tell the two apart. So
 * `null` means "omitted" and every OTHER wrong type — a number, an object, an array, a boolean —
 * means "this request is malformed", which is the honest reading of both.
 */
export function remoteNodeInput(value: unknown): RemoteNodeInput | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string') return null
  const input: RemoteNodeInput = { id: v.id }
  for (const key of ['title', 'agentId', 'accountId'] as const) {
    const raw = v[key]
    if (raw === undefined || raw === null) continue
    if (typeof raw !== 'string') return null
    input[key] = raw
  }
  return input
}

export function appendProjectNode(
  raw: string,
  input: RemoteNodeInput,
  now: Date,
  accountColor?: string
): string | null {
  // Two predicates, both required, because they bound different things and neither subsumes the
  // other. SAFE_NODE_ID owns the SHAPE (the boring `term-<alnum>-<alnum≤16>` alphabet that stays
  // safe as a tmux session name); its middle segment is unbounded, so it alone accepts a 136-char
  // id. isSafeNodeId owns the LENGTH — the same NODE_ID_MAX=128 cap the pty boundary enforces in
  // PtyManager.create. Without it a registration could answer TRUE and persist a node whose
  // persistKey pty:create then REJECTS as too long, so the node exists on the canvas but its
  // session can never be opened: a dead node plus rev churn, on both this channel and the
  // pre-existing desktop relay registerNode path. ANDed rather than swapped: isSafeNodeId's charset
  // (`[A-Za-z0-9._-]`, uppercase and dots and arbitrary structure) is a strict SUPERSET of the
  // term-shape, so replacing SAFE_NODE_ID with it would widen the accepted set and break the
  // boring-session-name invariant. Keeping both keeps the narrow shape and merely adds the ≤128 bound.
  if (!SAFE_NODE_ID.test(input.id) || !isSafeNodeId(input.id)) return null
  // Refused, not silently dropped: an account id becomes a config-DIR path segment
  // (`claude-accounts/<id>`, `~/.nodeterm/claude-accounts/<id>` on a host), so a bad one must never
  // reach the file — and quietly writing the node WITHOUT it would resurrect exactly the
  // wrong-identity bug this field exists to fix. Same alphabet the path builders enforce.
  // (`typeof` first: RegExp.test coerces, so a numeric id would sail through isSafeAccountId.)
  if (
    input.accountId !== undefined &&
    (typeof input.accountId !== 'string' || !isSafeAccountId(input.accountId))
  ) {
    return null
  }
  let root: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    root = parsed as Record<string, unknown>
  } catch {
    return null
  }
  if (root.version !== 1 || typeof root.rev !== 'number' || !Array.isArray(root.nodes)) return null
  // Every ELEMENT has to be an object too, not just the array. `"nodes":[null]` is perfectly valid
  // JSON, so the parse above accepts it and the "unparsable file" refusal never fires — and the
  // reads below (`n.kind` in isTerminal, `n.position`/`n.size` in the placement scan) then throw on
  // it. A throw here is not a worse `null`: this function's callers turn `null` into an honest
  // `false`, while a throw escapes as a rejected promise, which the `workspace:register-node`
  // channel delivers to a remote client as a transport-level handler error instead of the boolean
  // its contract promises. Refused at the boundary rather than with `n?.` at each read, because
  // there are several reads and the next one added would not know to guard itself.
  if (!root.nodes.every((n) => typeof n === 'object' && n !== null && !Array.isArray(n))) return null
  const nodes = root.nodes as Array<Record<string, unknown>>
  if (nodes.some((n) => n?.id === input.id)) return null

  const isTerminal = (n: Record<string, unknown>): boolean =>
    ((n.kind as string | undefined) ?? 'terminal') === 'terminal'
  const sibling = nodes.find(isTerminal)

  // Place the new node just below the lowest existing node (canvas y grows downward), aligned to
  // its x; an empty canvas starts at 100/100.
  let x = 100
  let y = 100
  let lowest: { node: Record<string, unknown>; y: number } | null = null
  for (const n of nodes) {
    const ny = (n.position as { y?: unknown } | undefined)?.y
    if (typeof ny !== 'number') continue
    if (!lowest || ny > lowest.y) lowest = { node: n, y: ny }
  }
  if (lowest) {
    const lx = (lowest.node.position as { x?: unknown }).x
    x = typeof lx === 'number' ? lx : 100
    const lh = (lowest.node.size as { height?: unknown } | undefined)?.height
    y = lowest.y + (typeof lh === 'number' ? lh : 560) + 40
  }

  // An agent node looks exactly like one minted by the canvas (createAgentNode): the agent's
  // label as the starting title, and the bound account's default color where the host resolved
  // one, else the agent's — titleAuto then lets the agent's own session name take over, same as
  // desktop. `accountColor` is host-derived (the phone cannot choose it) and already resolved
  // through the shared `agentAccountColor`, so a phone-started session under a colored account
  // lands on the canvas in that color instead of the agent's. A plain terminal keeps the mobile
  // defaults.
  //
  // `boundAccountId` is the ONE decision behind both the stamp and the color, exactly as
  // `createAgentNode` reads them off one local: split them and a node can end up carrying an
  // account it is not painted for, or painted for one it does not carry. The caller may hand us a
  // color for an id we then refuse — that is fine and deliberate, because it keeps the rule in one
  // place instead of asking every caller to re-derive it.
  //
  // A non-string `agentId` reads as "no agent stated" here, the same way the config lookup below
  // has always treated it — a garbage value must not be mistaken for a known OTHER agent and cost
  // a real Claude node its binding.
  const agentId = typeof input.agentId === 'string' ? input.agentId : undefined
  const bound = boundAccountId(input.accountId, agentId)
  const agent = agentId !== undefined ? agentConfig(agentId) : undefined
  const node: Record<string, unknown> = {
    id: input.id,
    kind: 'terminal',
    position: { x, y },
    size: { width: 900, height: 560 },
    title:
      typeof input.title === 'string'
        ? input.title.slice(0, TITLE_MAX)
        : (agent?.label ?? 'Mobile session'),
    titleAuto: true,
    color: (bound ? accountColor : undefined) ?? agent?.color ?? '#7aa2f7',
    group: null,
    tags: [],
    collapsed: false,
    // Sibling nodes carry the project's portable cwd (usually "./…").
    cwd: typeof sibling?.cwd === 'string' ? sibling.cwd : '.'
  }
  if (agentId !== undefined) node.agentId = agentId
  if (bound) node.accountId = bound
  // Desktop remote nodes carry the connection spec PER NODE — a sibling terminal in the same
  // project has the right values; copy verbatim. No genuine donor → a plain local node.
  //
  // "Genuine" is load-bearing, and the rule used to be `n.ssh !== undefined` — which does not even
  // ask about `sshRemoteTmux`, yet force-set it to true on the new node. But `data.ssh` alone means
  // something else entirely: a plain `ssh <host>` terminal (or a host attachment) that runs on the
  // LOCAL pty. So on a LOCAL project holding one such node, the phone's session — which really runs
  // on this desktop's own machine — was written as a remote tmux node on that host; the desktop then
  // dialled the host and `tmux new-session -A` obligingly created a brand-new EMPTY session there,
  // while the phone's real session sat unreachable on this machine. Only a node that is ITSELF a
  // remote tmux session, with a spec complete enough to dial, describes the same context.
  const sshDonor = nodes.find((n) => isTerminal(n) && n.sshRemoteTmux === true && isSshSpec(n.ssh))
  if (sshDonor) {
    node.ssh = sshDonor.ssh
    node.sshRemoteTmux = true
  }

  root.nodes = [...nodes, node]
  root.rev = (root.rev as number) + 1
  root.savedAt = now.toISOString()
  return JSON.stringify(root, null, 2)
}

/**
 * Pure removal of a node from a project.json's raw text — the host side of the relay
 * `pty.destroy` verb ("End session" on the phone), mirroring what the desktop's × does to the
 * canvas after `transport.destroy`. Same raw-object discipline as `appendProjectNode`: every
 * field this version does not know round-trips untouched, and dangling references the node may
 * leave behind (kanban assignments, bridges, ropes) are deliberately NOT chased here — their
 * readers already tolerate and lazily prune dead ids, exactly as they do after a desktop delete.
 *
 * Returns null whenever nothing must be written: unparsable/wrong-shape text (a file we couldn't
 * parse must never be invented or overwritten), or a node id that simply isn't in this file —
 * which is an ANSWER (try the next project), not an error.
 */
export function removeProjectNode(raw: string, nodeId: string, now: Date): string | null {
  if (typeof nodeId !== 'string' || !nodeId) return null
  let root: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    root = parsed as Record<string, unknown>
  } catch {
    return null
  }
  if (root.version !== 1 || typeof root.rev !== 'number' || !Array.isArray(root.nodes)) return null
  const nodes = root.nodes as Array<Record<string, unknown>>
  const target = nodes.find((n) => n?.id === nodeId)
  if (!target) return null
  // Terminal-only, restoring this function's documented "a DESTROYED session's node" contract. A
  // node's `kind` is absent (legacy default = terminal) or one of terminal/sticky/group/editor/…;
  // only a terminal has a tmux session behind it, and removal here is the file-half of the relay's
  // pty.destroy ("End session"). Without the guard, a caller that names an arbitrary id could
  // delete a sticky note, or a GROUP FRAME whose children then point at a parent that no longer
  // exists — nodeStatesToFlow re-emits them with `extent:'parent'` against a missing node, and a
  // worktree-bound frame's ungroup/unbind is bypassed, persisting a dead cwd. Refuse (honest false)
  // rather than delete something the caller had no session-level business touching.
  //
  // THIS GUARD, not the transport, is what makes the terminal-only contract true. It is tempting to
  // argue the relay's pty.destroy could only ever reach a terminal because it targets an ATTACHED
  // stream's persistKey, and that only the new arbitrary-id `workspace:remove-node` channel needs
  // guarding. That reasoning is wrong, and believing it is how the guard would get deleted as
  // redundant: relay `pty.attach` takes a CLIENT-CHOSEN node id, does not check canvas membership
  // or kind, and `attachDetached`'s `tmux new-session -A` will CREATE a session for it (see
  // `handleAttach` in main/remote/host-service.ts). Attaching proves a tmux session exists, never
  // that the id names a terminal node on anybody's canvas. Both transports need this.
  const kind = (target.kind as string | undefined) ?? 'terminal'
  if (kind !== 'terminal') return null

  root.nodes = nodes.filter((n) => n?.id !== nodeId)
  root.rev = (root.rev as number) + 1
  root.savedAt = now.toISOString()
  return JSON.stringify(root, null, 2)
}
