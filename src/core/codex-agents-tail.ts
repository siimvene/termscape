// Streams the per-agent activity of codex goal-mode (`spawn_agent`) subagents to the renderer.
//
// A codex child fires NO hooks of its own, but two disk facts make it visible (measured on
// codex-cli 0.146.0 + oh-my-codex collaboration mode, live runs 2026-08-29):
//  - The PARENT rollout logs `SubAgentActivity` items (kind 'started'/'completed' with the child's
//    `agent_thread_id` + `agent_path`) — sniffed by `parseCodexSubagentActivity` from the codex
//    context tail's `onLines`, the same seam claude's task-notification sniff uses. That sniff is
//    the whole lifecycle bracket: `started()` / `completed()` here hang off it.
//  - The CHILD writes a full rollout into the SAME sessions tree, filename carrying its thread id
//    (`rollout-<ts>-<agent_thread_id>.jsonl`), header `session_meta` self-declaring the lineage
//    plus `agent_nickname`/`agent_role`, and its final turn logging
//    `event_msg`/`task_complete` with `last_agent_message` — the result text.
//
// Correlation is therefore EXPLICIT (no adoption tricks, unlike workflow-agents-tail): the parent
// record names the child, the child's filename names itself. Events re-enter the pipeline as
// ordinary synthetic subagent-start/-end (toolUseId 'cxagent:<agentThreadId>') + chunks on the
// existing channels — the renderer needs zero changes. All read-only: if codex changes the layout
// we stream less, never crash. Remote (SSH) codex nodes are a documented degrade: this reads
// local disk only, and the gemini/codex raw-listener branch already skips remote nodes.
import fs from 'fs'
import path from 'path'
import { splitCompleteLines, SUBAGENT_READ_CAP } from './subagent-tail'

const POLL_MS = 500
const RESULT_CAP = 16 * 1024
// Emit a start without nickname/role after this many failed child-header reads (the child rollout
// can lag the parent's 'started' record; a plain card beats a card that never appears).
const LABEL_ATTEMPTS_MAX = 3
// Torn-line carry cap — same bound and reasoning as workflow-agents-tail.
const CARRY_CAP = 4 * SUBAGENT_READ_CAP
// completed() mirrors subagent-tail.finish: keep streaming through the grace window (the child's
// last lines may still be flushing when the parent logs 'completed'), force-close at its END.
const END_GRACE_MS = 1500
// Locating the child walks the sessions tree — bound the walk so a pathological tree can't spin.
const LOCATE_DIR_CAP = 400

export interface CodexAgentEvent {
  nodeId: string
  sessionId?: string
  toolUseId: string // synthetic: 'cxagent:<agentThreadId>'
  kind: 'subagent-start' | 'subagent-end'
  subagentType?: string // start only: the child's agent_role, else 'codex'
  taskLabel?: string // start only: 'nickname · agent_path leaf' (best available)
  result?: string // end only: the child's task_complete.last_agent_message, capped
}

export interface CodexAgentsTail {
  started(
    nodeId: string,
    sessionId: string | undefined,
    agentThreadId: string,
    agentPath: string | undefined,
    parentRolloutPath: string | undefined
  ): void
  /** Same args as started(): a `completed` for a thread whose `started` was never seen (buried in
   *  an offset-jumped burst) HEALS the card — start, final read, end — instead of dropping it. */
  completed(
    nodeId: string,
    sessionId: string | undefined,
    agentThreadId: string,
    agentPath: string | undefined,
    parentRolloutPath: string | undefined
  ): void
  release(nodeId: string): void
}

interface Child {
  nodeId: string
  sessionId?: string
  agentThreadId: string
  toolUseId: string
  agentPath?: string
  /** The sessions tree root the child's rollout must live under (derived from the parent's). */
  root: string
  /** The child's rollout path once located (null until the walk finds it). */
  path: string | null
  nickname?: string
  role?: string
  started: boolean
  ended: boolean
  labelAttempts: number
  offset: number
  carry: Buffer | null
  /** Latest task_complete.last_agent_message seen while tailing — becomes the end result. */
  lastAgentMessage?: string
  reading?: boolean
  /** completed() arrived — the grace-window force-close is scheduled. */
  closing?: boolean
  /** The pending force-close, so a grace-window re-open can CANCEL it instead of being eaten. */
  closeTimer?: ReturnType<typeof setTimeout>
  closed?: boolean
  /** release() tore this node down — in-flight reads must never emit (stale-card resurrection). */
  dropped?: boolean
}

/** content array → text (codex content entries are {type:'output_text'|'input_text', text}). */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text ?? '') : ''
      )
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** Short human argument for a codex function_call (`arguments` is a JSON STRING). */
function callArg(args: unknown): string {
  if (typeof args !== 'string' || !args) return ''
  let o: Record<string, unknown>
  try {
    o = JSON.parse(args)
  } catch {
    return ''
  }
  const cmd = o.cmd ?? o.command
  if (typeof cmd === 'string') return cmd.replace(/\s+/g, ' ').slice(0, 80)
  const p = o.file_path ?? o.path
  if (typeof p === 'string') return p.split('/').pop() || p
  if (typeof o.agent_type === 'string') return String(o.agent_type)
  return ''
}

function summarize(text: string): string {
  const t = text.trim()
  if (!t) return ''
  const lines = t.split('\n')
  const first = (lines.find((l) => l.trim()) ?? '').trim().slice(0, 100)
  const extra = lines.length > 1 ? ` … (+${lines.length - 1} lines)` : ''
  return `  ↳ ${first}${extra}`
}

/**
 * Render a chunk of child-rollout lines as the activity log streamed to the card: assistant prose
 * verbatim, tool calls as `$ name arg`, tool outputs summarized, inter-agent messages as `✉ …`.
 * Skips reasoning/meta/token records. Mirrors subagent-tail's formatSubagentChunk in spirit; the
 * record dialect is codex's (`{type:'response_item', payload:{type:…}}`), so it cannot be shared.
 */
export function formatCodexRolloutChunk(text: string): string {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let o: { type?: string; payload?: Record<string, unknown> }
    try {
      o = JSON.parse(s)
    } catch {
      continue
    }
    if (o.type !== 'response_item' || !o.payload) continue
    const p = o.payload
    switch (p.type) {
      case 'message': {
        if (p.role !== 'assistant') break // user/developer records carry huge injected preambles
        const t = textOf(p.content)
        if (t) out.push(t)
        break
      }
      case 'function_call': {
        const name = typeof p.name === 'string' ? p.name : 'tool'
        const arg = callArg(p.arguments)
        out.push(`$ ${name}${arg ? ` ${arg}` : ''}`)
        break
      }
      case 'function_call_output': {
        const sum = summarize(typeof p.output === 'string' ? p.output : '')
        if (sum) out.push(sum)
        break
      }
      case 'agent_message': {
        // Inter-agent mail (task handoffs, wait_for_agents replies) — one line keeps the log honest
        // about where the child's instructions came from without dumping the whole payload.
        const first = textOf(p.content).split('\n').find((l) => l.trim())
        if (first) out.push(`✉ ${first.trim().slice(0, 100)}`)
        break
      }
    }
  }
  return out.filter(Boolean).join('\n')
}

/** Latest task_complete.last_agent_message in a set of complete lines (cheap pre-filter). */
export function pickTaskComplete(lines: string[]): string | undefined {
  let latest: string | undefined
  for (const line of lines) {
    const s = line.trim()
    if (!s || !s.includes('task_complete')) continue
    let o: { type?: string; payload?: { type?: string; last_agent_message?: unknown } }
    try {
      o = JSON.parse(s)
    } catch {
      continue
    }
    if (o.type !== 'event_msg' || o.payload?.type !== 'task_complete') continue
    if (typeof o.payload.last_agent_message === 'string') latest = o.payload.last_agent_message
  }
  return latest
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * The `sessions` tree root the child's rollout must live under, walked UP from the parent's own
 * rollout path until the literal `sessions` segment — never a fixed number of dirname() hops,
 * which a shallower future layout would silently walk ABOVE the jailed tree. No `sessions`
 * segment within a few hops ⇒ null ⇒ the child is never located (fail closed, never wider).
 */
export function sessionsRootOf(parentRolloutPath: string): string | null {
  let dir = path.dirname(parentRolloutPath)
  for (let i = 0; i < 6; i++) {
    if (path.basename(dir) === 'sessions') return dir
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
  return null
}

export function createCodexAgentsTail(deps: {
  event: (ev: CodexAgentEvent) => void
  chunk: (payload: { toolUseId: string; chunk: string }) => void
}): CodexAgentsTail {
  // Keyed by agentThreadId (globally unique). Closed entries are KEPT until node teardown so a
  // later 'started' re-opens without replaying — deliberate linear growth per live node, bounded
  // by its fleet size (small structs, buffers nulled at close); release() clears them.
  const children = new Map<string, Child>()
  let timer: ReturnType<typeof setInterval> | null = null

  // Closed entries are KEPT (a later 'started' re-opens them without replaying the transcript),
  // so idleness is "no child still needs ticks", never children.size — else the timer would poll
  // a map of finished children forever.
  const stopTimerIfIdle = (): void => {
    if (!timer) return
    for (const c of children.values()) if (!c.closed && !c.dropped) return
    clearInterval(timer)
    timer = null
  }

  // Find the child's rollout under the sessions root: bounded depth-first walk, newest date dirs
  // first (entries reverse-sorted), matching the thread id embedded in the filename. The id was
  // validated by the sniffer, so it cannot smuggle a separator into the match.
  const locate = async (c: Child): Promise<string | null> => {
    const stack = [c.root]
    let visited = 0
    while (stack.length && visited < LOCATE_DIR_CAP) {
      const dir = stack.pop() as string
      visited++
      let entries: fs.Dirent[]
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : 1))
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl') && e.name.includes(c.agentThreadId)) {
          return path.join(dir, e.name)
        }
      }
      // Push ascending so the stack pops newest-first (dated dirs sort lexically = chronologically).
      for (const e of entries) if (e.isDirectory()) stack.push(path.join(dir, e.name))
    }
    return null
  }

  // Read nickname/role from the child rollout's session_meta header (first line).
  const readHeader = async (c: Child): Promise<boolean> => {
    if (!c.path) return false
    let firstLine: string
    try {
      const fd = await fs.promises.open(c.path, 'r')
      try {
        const buf = Buffer.alloc(64 * 1024)
        const { bytesRead } = await fd.read(buf, 0, buf.length, 0)
        const s = buf.subarray(0, bytesRead).toString('utf-8')
        const nl = s.indexOf('\n')
        if (nl === -1 && bytesRead === buf.length) return false // header longer than the probe
        firstLine = nl === -1 ? s : s.slice(0, nl)
      } finally {
        await fd.close()
      }
    } catch {
      return false
    }
    let o: { payload?: { agent_nickname?: unknown; agent_role?: unknown } }
    try {
      o = JSON.parse(firstLine)
    } catch {
      return false
    }
    if (typeof o.payload?.agent_nickname === 'string') c.nickname = o.payload.agent_nickname
    if (typeof o.payload?.agent_role === 'string') c.role = o.payload.agent_role
    return !!(c.nickname || c.role)
  }

  const label = (c: Child): string | undefined => {
    const leaf = c.agentPath?.split('/').filter(Boolean).pop()
    if (c.nickname && leaf) return `${c.nickname} · ${leaf}`
    return c.nickname ?? leaf
  }

  // Emit subagent-start once nickname/role resolve OR after LABEL_ATTEMPTS_MAX failed reads
  // (force = 'completed' already arrived — the card must exist before it can end).
  const tryEmitStart = async (c: Child, force = false): Promise<void> => {
    if (c.started || c.dropped) return
    if (!c.path) c.path = await locate(c)
    const labeled = await readHeader(c)
    c.labelAttempts++
    if (!force && !labeled && c.labelAttempts < LABEL_ATTEMPTS_MAX) return
    if (c.dropped) return // release() may have landed across the awaits above
    c.started = true
    deps.event({
      nodeId: c.nodeId,
      sessionId: c.sessionId,
      toolUseId: c.toolUseId,
      kind: 'subagent-start',
      subagentType: c.role || 'codex',
      taskLabel: label(c)
    })
  }

  const emitEnd = (c: Child): void => {
    if (c.dropped) return
    deps.event({
      nodeId: c.nodeId,
      sessionId: c.sessionId,
      toolUseId: c.toolUseId,
      kind: 'subagent-end',
      result: c.lastAgentMessage?.slice(0, RESULT_CAP)
    })
    c.ended = true
  }

  const flushCarry = (c: Child): void => {
    if (c.dropped || !c.carry?.length) return
    const s = c.carry.toString('utf-8')
    c.carry = null
    // The file is complete now, so the held-back bytes are a real final record that just lacks its
    // trailing newline — a task_complete here is the child's RESULT, not noise.
    const result = pickTaskComplete([s])
    if (result !== undefined) c.lastAgentMessage = result
    const out = formatCodexRolloutChunk(s)
    if (out) deps.chunk({ toolUseId: c.toolUseId, chunk: out + '\n' })
  }

  // Tail the child rollout: offset read + torn-line carry, chunks formatted per codex dialect,
  // task_complete captured for the eventual end result. On `final`, DRAIN (bounded rounds — a
  // backlog bigger than one read cap must not lose its tail, the trailing task_complete included)
  // then flush the held carry. Normal ticks read one cap per tick (pacing).
  const tailChild = async (c: Child, final = false): Promise<void> => {
    if (c.dropped) return
    // Keep retrying the locate after a forced/label-exhausted start — the child file can lag the
    // parent's 'started' record past LABEL_ATTEMPTS_MAX, and a card whose transcript never
    // arrives is a worse bug than a late one.
    if (!c.path) {
      c.path = await locate(c)
      if (!c.path) {
        if (final) flushCarry(c)
        return
      }
    }
    const rounds = final ? 8 : 1
    for (let i = 0; i < rounds; i++) {
      let size = -1
      try {
        size = (await fs.promises.stat(c.path)).size
      } catch {
        break
      }
      if (size <= c.offset) break
      const len = Math.min(size - c.offset, SUBAGENT_READ_CAP)
      const buf = Buffer.alloc(len)
      try {
        const fd = await fs.promises.open(c.path, 'r')
        try {
          await fd.read(buf, 0, len, c.offset)
        } finally {
          await fd.close()
        }
      } catch {
        break
      }
      c.offset += len
      const data = c.carry?.length ? Buffer.concat([c.carry, buf]) : buf
      const { text, carry } = splitCompleteLines(data)
      c.carry = carry && carry.length > CARRY_CAP ? null : carry
      const result = pickTaskComplete(text.split('\n'))
      if (result !== undefined) c.lastAgentMessage = result
      const out = formatCodexRolloutChunk(text)
      if (out && !c.dropped) deps.chunk({ toolUseId: c.toolUseId, chunk: out + '\n' })
    }
    if (final) flushCarry(c)
  }

  const tick = (): void => {
    for (const c of children.values()) {
      if (c.closed || c.dropped) continue
      if (c.reading) continue
      c.reading = true
      void (async () => {
        try {
          if (!c.started) await tryEmitStart(c)
          if (c.started && !c.ended) await tailChild(c)
        } finally {
          c.reading = false
        }
      })()
    }
    stopTimerIfIdle()
  }

  const track = (
    nodeId: string,
    sessionId: string | undefined,
    agentThreadId: string,
    agentPath: string | undefined,
    parentRolloutPath: string | undefined
  ): Child | undefined => {
    if (!parentRolloutPath) return undefined // no parent path → no root to search; degrade silently
    const root = sessionsRootOf(parentRolloutPath)
    if (!root) return undefined // layout we don't recognize — never walk outside the jailed tree
    const c: Child = {
      nodeId,
      sessionId,
      agentThreadId,
      toolUseId: `cxagent:${agentThreadId}`,
      agentPath,
      root,
      path: null,
      started: false,
      ended: false,
      labelAttempts: 0,
      offset: 0,
      carry: null
    }
    children.set(agentThreadId, c)
    if (!timer) timer = setInterval(tick, POLL_MS)
    return c
  }

  const scheduleClose = (c: Child): void => {
    c.closing = true
    // Grace window (mirrors subagent-tail.finish): ticks keep streaming while the child's last
    // lines flush; the force-close (final drain + start-heal + end) runs at the window's END.
    c.closeTimer = setTimeout(() => {
      c.closeTimer = undefined
      void (async () => {
        for (let i = 0; c.reading && i < 20; i++) await sleep(50)
        if (c.dropped || c.ended || !c.closing) return // released, done, or re-opened meanwhile
        if (!c.started) await tryEmitStart(c, true) // the card must exist before ending
        // A tick read still stalled past the bounded wait OWNS offset/carry — end on the state we
        // have rather than run a second concurrent read over the same cursors.
        if (!c.reading) await tailChild(c, true)
        emitEnd(c)
        c.closed = true
        // Keep the entry: a later 'started' for the same thread re-opens it (offset preserved).
        stopTimerIfIdle()
      })()
    }, END_GRACE_MS)
  }

  return {
    started(nodeId, sessionId, agentThreadId, agentPath, parentRolloutPath) {
      const existing = children.get(agentThreadId)
      if (existing) {
        if (existing.dropped) return
        if (existing.closing && !existing.closed && !existing.ended) {
          // A follow-up task for the same child arrived INSIDE the grace window — cancel the
          // pending force-close and keep the card live (it never ended; no second start needed).
          if (existing.closeTimer) clearTimeout(existing.closeTimer)
          existing.closeTimer = undefined
          existing.closing = false
          if (!timer) timer = setInterval(tick, POLL_MS)
          return
        }
        if (!existing.ended) return // duplicate 'started' for a live child
        // The parent re-engaged a finished child (a later turn) — re-open the card. Keep the
        // located path and offset so the earlier transcript is not replayed.
        existing.started = false
        existing.ended = false
        existing.closing = false
        existing.closed = false
        existing.labelAttempts = 0
        if (!timer) timer = setInterval(tick, POLL_MS)
        return
      }
      track(nodeId, sessionId, agentThreadId, agentPath, parentRolloutPath)
    },

    completed(nodeId, sessionId, agentThreadId, agentPath, parentRolloutPath) {
      let c = children.get(agentThreadId)
      if (c && (c.ended || c.closing || c.dropped)) return
      // A 'completed' for a thread we never saw start: its 'started' fell into an offset-jumped
      // burst the context tail skipped. Heal it — track now, and the grace close below emits the
      // start (force) before the end, with whatever transcript the locate still finds.
      if (!c) c = track(nodeId, sessionId, agentThreadId, agentPath, parentRolloutPath)
      if (!c) return
      scheduleClose(c)
    },

    release(nodeId) {
      for (const [key, c] of children)
        if (c.nodeId === nodeId) {
          c.dropped = true // in-flight async reads still hold the object — mute them
          if (c.closeTimer) clearTimeout(c.closeTimer)
          c.closeTimer = undefined
          children.delete(key)
        }
      stopTimerIfIdle()
    }
  }
}
