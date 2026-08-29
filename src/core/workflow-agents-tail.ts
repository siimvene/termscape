// Streams the per-agent activity of a Claude Code **Workflow** tool call to the renderer.
//
// The Workflow tool spawns N agents IN-PROCESS: they fire NO per-agent hooks, so the
// subagent-tail mechanism (which keys off a spawning tool_use_id in an agent-*.meta.json) can't
// find them. Instead their transcripts land under
//   <parent transcript minus .jsonl>/subagents/workflows/<wf_runId>/
// with, per agent, agent-<agentId>.jsonl (transcript; first line is a user record carrying the
// prompt) + agent-<agentId>.meta.json ({agentType, spawnDepth, model} — NO toolUseId), plus a
// journal.jsonl of {type:'started'|'result', agentId, result?} records. The parent session's own
// hooks DO fire for the Workflow tool call itself (PreToolUse/PostToolUse, tool_name 'Workflow'),
// which is what begin()/end() hang off — detection lives in the shells' raw listeners.
//
// This service watches those journal + agent files and turns them into subagent-start/-end events
// plus streamed transcript chunks, so a Workflow call renders the same subagent cards a hook-driven
// Task fan-out does. All read-only: if Claude changes the layout we stream less, never crash.
import fs from 'fs'
import path from 'path'
import { formatSubagentChunk, splitCompleteLines, SUBAGENT_READ_CAP } from './subagent-tail'

const POLL_MS = 500
// The journal result text can be a full final message; cap it like a chunk so one giant result
// can't be forwarded whole.
const RESULT_CAP = 16 * 1024
// A per-agent prompt (the first user line) is bounded — read only enough of it to find that line.
const FIRST_LINE_READ_CAP = 64 * 1024
// Emit a start without a label after this many failed label reads (both meta.json and the agent
// jsonl can lag the journal 'started' record; a card with no label beats a card that never appears).
const LABEL_ATTEMPTS_MAX = 3
// A torn line is held back and re-prepended on the next read, so a single line that never
// terminates would otherwise accumulate ~SUBAGENT_READ_CAP per tick forever. Past this the carry
// is DROPPED (the line's tail then fails to parse and is skipped — degraded, bounded).
const CARRY_CAP = 4 * SUBAGENT_READ_CAP
// end() mirrors subagent-tail.finish: the dir keeps streaming through this grace window (files may
// still be flushing when the PostToolUse fires) and the force-close runs at the END of it.
const END_GRACE_MS = 1500
// journal.jsonl agentIds are lowercase hex; a 'started'/'result' record is parsed DATA, so a forged
// agentId ('../../evil') must be refused before it can build a path — validate before any fs use.
const AGENT_ID_RE = /^[0-9a-f]{1,64}$/

export interface WorkflowAgentEvent {
  nodeId: string
  sessionId?: string
  toolUseId: string // synthetic: 'wfagent:<wfDirName>:<agentId>'
  kind: 'subagent-start' | 'subagent-end'
  subagentType?: string // start only: meta.json model, else 'workflow'
  taskLabel?: string // start only: first user-message snippet, whitespace-collapsed, <=120 chars
  result?: string // end only: journal result text, capped at 16 KB
}

export interface WorkflowAgentsTail {
  begin(
    wfToolUseId: string,
    nodeId: string,
    sessionId: string | undefined,
    transcriptPath: string | undefined
  ): void
  end(wfToolUseId: string): void
  release(nodeId: string): void
}

interface BeginEntry {
  key: string
  nodeId: string
  sessionId?: string
  root: string
  /** This begin has had its first successful readdir of the root — see the adoption trick. */
  adopted: boolean
  /** At least one wf_* dir has been attached to this begin (association book-keeping). */
  hasDir: boolean
}

interface AgentState {
  agentId: string
  synthToolUseId: string
  /** subagent-start has been emitted. */
  started: boolean
  /** subagent-end has been emitted; stop tailing. */
  ended: boolean
  /** Failed label-resolution attempts so far (see LABEL_ATTEMPTS_MAX). */
  labelAttempts: number
  jsonlOffset: number
  /** Bytes past the last newline of the previous read, held back and prepended next read. */
  jsonlCarry: Buffer | null
}

interface WfDir {
  name: string // the wf_* dir name (the synthetic toolUseId prefix)
  path: string
  nodeId: string
  sessionId?: string
  /** The begin() this dir was associated to — end(that key) closes it. */
  beginKey: string
  journalOffset: number
  journalCarry: Buffer | null
  agents: Map<string, AgentState>
  /** An async read is in flight — the next tick skips this dir instead of double-reading. */
  reading?: boolean
  /** end()'s grace-window force-close ran — ticks skip it. */
  closed?: boolean
  /** release() tore this node down. An in-flight async read still holds the object, so every
   *  emission site re-checks this flag — a dropped dir must never emit (stale-card resurrection). */
  dropped?: boolean
}

/** content string-or-array → text (mirrors subagent-tail's local textOf, which isn't exported). */
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

/** Cap the held-back torn-line carry — see CARRY_CAP. */
function capCarry(carry: Buffer | null): Buffer | null {
  return carry && carry.length > CARRY_CAP ? null : carry
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function createWorkflowAgentsTail(deps: {
  event: (ev: WorkflowAgentEvent) => void
  chunk: (payload: { toolUseId: string; chunk: string }) => void
}): WorkflowAgentsTail {
  // Insertion order matters: it is the "oldest → newest" order association walks.
  const begins = new Map<string, BeginEntry>()
  const dirs = new Map<string, WfDir>() // keyed by full dir path (globally unique)
  let timer: ReturnType<typeof setInterval> | null = null

  const stopTimerIfIdle = (): void => {
    if (!begins.size && !dirs.size && timer) {
      clearInterval(timer)
      timer = null
    }
  }

  // Attach a newly discovered dir to a begin() ON THE SAME ROOT: the oldest active one that has no
  // dir yet, else the newest active one, else the caller's own (possibly already-ended) entry.
  // Scoping to the root is load-bearing — two concurrent Workflow calls on DIFFERENT nodes have
  // different transcript roots, and a global walk would attribute one node's agents to the other.
  // Nested child workflows and concurrent calls on ONE node share a root and resolve to the same
  // nodeId, so any misattribution within a root is bounded to that node and harmless.
  const associateDir = (root: string, fallback?: BeginEntry): BeginEntry | undefined => {
    let last: BeginEntry | undefined
    for (const b of begins.values()) {
      if (b.root !== root) continue
      if (!b.hasDir) {
        b.hasDir = true
        return b
      }
      last = b
    }
    if (last) {
      last.hasDir = true
      return last
    }
    if (fallback) {
      fallback.hasDir = true
      return fallback
    }
    return undefined
  }

  const flushAgentCarry = (dir: WfDir, a: AgentState): void => {
    if (dir.dropped || !a.jsonlCarry?.length) return
    const out = formatSubagentChunk(a.jsonlCarry.toString('utf-8'))
    a.jsonlCarry = null
    if (out) deps.chunk({ toolUseId: a.synthToolUseId, chunk: out + '\n' })
  }

  // Tail an agent's transcript: offset read + torn-line carry + formatSubagentChunk, identical to
  // subagent-tail. On `final` (its 'result' landed / the workflow ended) flush the held carry as
  // the real last line.
  const tailAgent = async (dir: WfDir, a: AgentState, final = false): Promise<void> => {
    if (dir.dropped) return
    const file = path.join(dir.path, `agent-${a.agentId}.jsonl`)
    let size = -1
    try {
      size = (await fs.promises.stat(file)).size
    } catch {
      if (final) flushAgentCarry(dir, a)
      return
    }
    if (size > a.jsonlOffset) {
      const len = Math.min(size - a.jsonlOffset, SUBAGENT_READ_CAP)
      const buf = Buffer.alloc(len)
      try {
        const fd = await fs.promises.open(file, 'r')
        try {
          await fd.read(buf, 0, len, a.jsonlOffset)
        } finally {
          await fd.close()
        }
      } catch {
        if (final) flushAgentCarry(dir, a)
        return
      }
      a.jsonlOffset += len
      const data = a.jsonlCarry?.length ? Buffer.concat([a.jsonlCarry, buf]) : buf
      const { text, carry } = splitCompleteLines(data)
      a.jsonlCarry = capCarry(carry)
      const out = formatSubagentChunk(text)
      if (out && !dir.dropped) deps.chunk({ toolUseId: a.synthToolUseId, chunk: out + '\n' })
    }
    if (final) flushAgentCarry(dir, a)
  }

  // Read the agent's prompt from the first line of its transcript. Bounded to FIRST_LINE_READ_CAP
  // (the line may lag the journal record, so a null return means "retry next tick").
  const resolveLabel = async (dir: WfDir, agentId: string): Promise<string | undefined> => {
    const file = path.join(dir.path, `agent-${agentId}.jsonl`)
    let size = -1
    try {
      size = (await fs.promises.stat(file)).size
    } catch {
      return undefined
    }
    if (size <= 0) return undefined
    const len = Math.min(size, FIRST_LINE_READ_CAP)
    const buf = Buffer.alloc(len)
    try {
      const fd = await fs.promises.open(file, 'r')
      try {
        await fd.read(buf, 0, len, 0)
      } finally {
        await fd.close()
      }
    } catch {
      return undefined
    }
    const s = buf.toString('utf-8')
    const nl = s.indexOf('\n')
    // No newline within the cap: only trust it if we actually read the whole (small) file — an
    // unterminated first line is still parseable; a line truncated at the cap is not.
    const firstLine = nl === -1 ? (size <= len ? s : null) : s.slice(0, nl)
    if (!firstLine) return undefined
    let o: { message?: { content?: unknown } }
    try {
      o = JSON.parse(firstLine)
    } catch {
      return undefined
    }
    const text = textOf(o?.message?.content).replace(/\s+/g, ' ').trim()
    return text ? text.slice(0, 120) : undefined
  }

  // Emit subagent-start once its label resolves OR after LABEL_ATTEMPTS_MAX failed reads (force = the
  // agent's 'result' or the workflow's end already arrived — a card must exist before it can complete).
  const tryEmitStart = async (dir: WfDir, a: AgentState, force = false): Promise<void> => {
    if (a.started || dir.dropped) return
    let model: string | undefined
    try {
      const meta = JSON.parse(
        await fs.promises.readFile(path.join(dir.path, `agent-${a.agentId}.meta.json`), 'utf-8')
      )
      if (typeof meta?.model === 'string') model = meta.model
    } catch {
      // meta may lag the journal — fall back to the default subagentType below.
    }
    const label = await resolveLabel(dir, a.agentId)
    a.labelAttempts++
    if (!force && !label && a.labelAttempts < LABEL_ATTEMPTS_MAX) return
    if (dir.dropped) return // release() may have landed across the awaits above
    a.started = true
    deps.event({
      nodeId: dir.nodeId,
      sessionId: dir.sessionId,
      toolUseId: a.synthToolUseId,
      kind: 'subagent-start',
      subagentType: model || 'workflow',
      taskLabel: label
    })
  }

  const emitEnd = (dir: WfDir, a: AgentState, resultText?: unknown): void => {
    if (dir.dropped) return
    deps.event({
      nodeId: dir.nodeId,
      sessionId: dir.sessionId,
      toolUseId: a.synthToolUseId,
      kind: 'subagent-end',
      result: typeof resultText === 'string' ? resultText.slice(0, RESULT_CAP) : undefined
    })
    a.ended = true
  }

  const makeAgent = (dir: WfDir, agentId: string): AgentState => ({
    agentId,
    synthToolUseId: `wfagent:${dir.name}:${agentId}`,
    started: false,
    ended: false,
    labelAttempts: 0,
    jsonlOffset: 0,
    jsonlCarry: null
  })

  const handleStarted = (dir: WfDir, agentId: unknown): void => {
    if (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId)) return // forged/garbled — refuse
    if (dir.agents.has(agentId)) return
    dir.agents.set(agentId, makeAgent(dir, agentId))
  }

  const handleResult = async (dir: WfDir, agentId: unknown, resultText: unknown): Promise<void> => {
    if (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId)) return
    let a = dir.agents.get(agentId)
    if (a?.ended) return
    if (!a) {
      // A 'result' for an agentId we never saw start (missed window) — heal it: start then end.
      a = makeAgent(dir, agentId)
      dir.agents.set(agentId, a)
    }
    if (!a.started) await tryEmitStart(dir, a, true)
    await tailAgent(dir, a, true) // final read + carry flush
    emitEnd(dir, a, resultText)
  }

  const readJournal = async (dir: WfDir): Promise<void> => {
    const file = path.join(dir.path, 'journal.jsonl')
    let size = -1
    try {
      size = (await fs.promises.stat(file)).size
    } catch {
      return // journal not written yet
    }
    if (size <= dir.journalOffset) return
    const len = Math.min(size - dir.journalOffset, SUBAGENT_READ_CAP)
    const buf = Buffer.alloc(len)
    try {
      const fd = await fs.promises.open(file, 'r')
      try {
        await fd.read(buf, 0, len, dir.journalOffset)
      } finally {
        await fd.close()
      }
    } catch {
      return
    }
    dir.journalOffset += len
    const data = dir.journalCarry?.length ? Buffer.concat([dir.journalCarry, buf]) : buf
    const { text, carry } = splitCompleteLines(data)
    dir.journalCarry = capCarry(carry)
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let rec: { type?: string; agentId?: unknown; result?: unknown }
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      if (rec.type === 'started') handleStarted(dir, rec.agentId)
      else if (rec.type === 'result') await handleResult(dir, rec.agentId, rec.result)
    }
  }

  const readDir = async (dir: WfDir): Promise<void> => {
    if (dir.reading || dir.closed || dir.dropped) return
    dir.reading = true
    try {
      await readJournal(dir) // discover started/result records (may emit start+end inline for heals)
      // Emit pending starts BEFORE streaming their chunks, so the card exists before its transcript.
      for (const a of dir.agents.values()) if (!a.started && !a.ended) await tryEmitStart(dir, a)
      for (const a of dir.agents.values()) if (a.started && !a.ended) await tailAgent(dir, a)
    } finally {
      dir.reading = false
    }
  }

  // Discover wf_* dirs under a begin's root. THE ADOPTION TRICK (no exclusion list): on the begin's
  // FIRST successful readdir — which begin() runs IMMEDIATELY, see below — every existing wf_* dir
  // is adopted with its journal offset set to the file's CURRENT size: a finished prior run emits
  // nothing, and a resumed run's APPENDED journal records still stream. A dir that APPEARS on a
  // LATER scan starts at offset 0. The immediate first scan is what makes the split correct for the
  // CURRENT run too: PreToolUse hooks are blocking (the tool executes only after the hook returns),
  // so this run's own wf_* dir cannot exist yet when begin() scans — any dir present at begin() is
  // genuinely historical, and this run's dir always lands in the offset-0 branch.
  const scanRoot = async (b: BeginEntry, fallbackSelf = false): Promise<void> => {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(b.root, { withFileTypes: true })
    } catch (err) {
      // An absent root at the first look is an ANSWER, not just a retry: no prior run ever
      // existed (a prior run would have created the root), so every dir that appears later —
      // even on the next successful scan — is the current run's and must stream from offset 0.
      // Only a definite ENOENT settles it; a transient EACCES says nothing about priors.
      if (!b.adopted && (err as NodeJS.ErrnoException)?.code === 'ENOENT') b.adopted = true
      return
    }
    const firstScan = !b.adopted
    b.adopted = true
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith('wf_')) continue
      const full = path.join(b.root, e.name)
      if (dirs.has(full)) continue // already known globally — never re-adopt
      let journalOffset = 0
      if (firstScan) {
        try {
          journalOffset = (await fs.promises.stat(path.join(full, 'journal.jsonl'))).size
        } catch {
          journalOffset = 0
        }
      }
      // fallbackSelf: end()'s late scan runs after its begin left the map — own the dir anyway.
      const assoc = associateDir(b.root, fallbackSelf ? b : undefined)
      if (!assoc) continue // no active begin on this root to own it (raced with release/end)
      dirs.set(full, {
        name: e.name,
        path: full,
        nodeId: assoc.nodeId,
        sessionId: assoc.sessionId,
        beginKey: assoc.key,
        journalOffset,
        journalCarry: null,
        agents: new Map()
      })
    }
  }

  const tick = (): void => {
    for (const b of begins.values()) void scanRoot(b)
    for (const dir of dirs.values()) void readDir(dir)
    stopTimerIfIdle()
  }

  return {
    begin(wfToolUseId, nodeId, sessionId, transcriptPath) {
      if (!transcriptPath || begins.has(wfToolUseId)) return
      const root = transcriptPath.replace(/\.jsonl$/, '') + '/subagents/workflows'
      const b: BeginEntry = {
        key: wfToolUseId,
        nodeId,
        sessionId,
        root,
        adopted: false,
        hasDir: false
      }
      begins.set(wfToolUseId, b)
      // Immediate first scan — the adoption trick's correctness depends on it running BEFORE the
      // workflow tool starts writing (see scanRoot). Waiting for the first 500 ms tick instead
      // opened a window where the current run's own dir was adopted as historical and its early
      // journal records silently skipped.
      void scanRoot(b)
      if (!timer) timer = setInterval(tick, POLL_MS) // runs only while a begin() is active
    },

    end(wfToolUseId) {
      const b = begins.get(wfToolUseId)
      begins.delete(wfToolUseId)
      // Mirrors subagent-tail.finish: the dirs stay OPEN through the grace window — the journal
      // and agent files may still be flushing when the PostToolUse fires, and the regular ticks
      // keep streaming them meanwhile. The force-close (final read, heal-start any stragglers,
      // emit their ends) runs at the END of the window, not before it. The late scanRoot catches
      // a dir created after the last tick — a sub-POLL_MS workflow may never have been scanned at
      // all, and its begin is already out of the map (hence fallbackSelf).
      void (async () => {
        if (b) await scanRoot(b, true)
        setTimeout(() => {
          void (async () => {
            const closing = [...dirs.values()].filter((d) => d.beginKey === wfToolUseId)
            for (const dir of closing) {
              // Bounded wait for an in-flight tick read, so the final pass sees its offsets.
              for (let i = 0; dir.reading && i < 20; i++) await sleep(50)
              if (dir.dropped) continue // release() landed during the grace window
              await readDir(dir)
              for (const a of dir.agents.values()) {
                if (a.ended) continue
                if (!a.started) await tryEmitStart(dir, a, true) // the card must exist before ending
                await tailAgent(dir, a, true)
                emitEnd(dir, a)
              }
              dir.closed = true
              dirs.delete(dir.path)
            }
            stopTimerIfIdle()
          })()
        }, END_GRACE_MS)
      })()
    },

    release(nodeId) {
      for (const [key, b] of begins) if (b.nodeId === nodeId) begins.delete(key)
      for (const [key, d] of dirs)
        if (d.nodeId === nodeId) {
          d.dropped = true // in-flight async reads still hold the object — mute them
          dirs.delete(key)
        }
      stopTimerIfIdle()
    }
  }
}
