import { describe, expect, it, vi, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createCodexAgentsTail, formatCodexRolloutChunk, pickTaskComplete, sessionsRootOf, type CodexAgentEvent } from './codex-agents-tail'
import { parseCodexSubagentActivity, liveCodexSubagentActivities } from './codex-session'

// --- fixtures (record shapes measured on codex-cli 0.146.0, live runs 2026-08-29) ---------------

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const THREAD = '01a04df0-f1ed-75b2-94b6-0354118780a1'

const sessionMeta = (nickname: string, role: string): string =>
  JSON.stringify({
    type: 'session_meta',
    payload: {
      id: THREAD,
      agent_nickname: nickname,
      agent_role: role,
      agent_path: '/root/architecture_review',
      source: { subagent: { thread_spawn: { parent_thread_id: 'parent-1', depth: 1 } } }
    }
  })

const assistantMsg = (text: string): string =>
  JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
  })

const developerMsg = (text: string): string =>
  JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] }
  })

const functionCall = (name: string, args: Record<string, unknown>): string =>
  JSON.stringify({
    type: 'response_item',
    payload: { type: 'function_call', name, arguments: JSON.stringify(args) }
  })

const taskComplete = (msg: string): string =>
  JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: msg } })

const subagentActivity = (kind: 'started' | 'completed', threadId: string, agentPath = '/root/architecture_review'): string =>
  JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: { type: 'SubAgentActivity', kind, agent_thread_id: threadId, agent_path: agentPath }
    }
  })

interface Harness {
  base: string
  dateDir: string
  parentPath: string
}

function setup(): Harness {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cxtail-'))
  const dateDir = path.join(base, 'sessions', '2026', '08', '29')
  fs.mkdirSync(dateDir, { recursive: true })
  const parentPath = path.join(dateDir, 'rollout-2026-08-29T17-00-00-parent-1.jsonl')
  fs.writeFileSync(parentPath, '') // only the PATH matters to the tail (root derivation)
  return { base, dateDir, parentPath }
}

const childFile = (h: Harness, threadId = THREAD): string =>
  path.join(h.dateDir, `rollout-2026-08-29T17-33-51-${threadId}.jsonl`)

const cleanups: string[] = []
afterEach(() => {
  while (cleanups.length) {
    try {
      fs.rmSync(cleanups.pop()!, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

function makeTail(): {
  tail: ReturnType<typeof createCodexAgentsTail>
  events: CodexAgentEvent[]
  chunks: { toolUseId: string; chunk: string }[]
} {
  const events: CodexAgentEvent[] = []
  const chunks: { toolUseId: string; chunk: string }[] = []
  const tail = createCodexAgentsTail({
    event: (ev) => events.push(ev),
    chunk: (p) => chunks.push(p)
  })
  return { tail, events, chunks }
}

const chunkText = (chunks: { chunk: string }[]): string => chunks.map((c) => c.chunk).join('')

// --- sniffer -----------------------------------------------------------------------------------

describe('parseCodexSubagentActivity', () => {
  it('parses started/completed items and ignores everything else', () => {
    const acts = parseCodexSubagentActivity([
      subagentActivity('started', THREAD),
      assistantMsg('not an activity'),
      JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Other', kind: 'started', agent_thread_id: THREAD } } }),
      subagentActivity('completed', THREAD)
    ])
    expect(acts).toEqual([
      { kind: 'started', agentThreadId: THREAD, agentPath: '/root/architecture_review' },
      { kind: 'completed', agentThreadId: THREAD, agentPath: '/root/architecture_review' }
    ])
  })

  it('refuses a forged agent_thread_id before it can reach a filename match', () => {
    expect(parseCodexSubagentActivity([subagentActivity('started', '../../evil')])).toEqual([])
    expect(parseCodexSubagentActivity([subagentActivity('started', 'a/b')])).toEqual([])
    expect(parseCodexSubagentActivity([subagentActivity('started', '')])).toEqual([])
  })

  it('liveCodexSubagentActivities drops replayed pairs, keeps still-live starteds', () => {
    const done = 'aaaaaaaa-1111-1111-1111-111111111111'
    const live = 'bbbbbbbb-2222-2222-2222-222222222222'
    const acts = parseCodexSubagentActivity([
      subagentActivity('started', done),
      subagentActivity('completed', done),
      subagentActivity('started', live)
    ])
    expect(liveCodexSubagentActivities(acts)).toEqual([
      { kind: 'started', agentThreadId: live, agentPath: '/root/architecture_review' }
    ])
  })
})

describe('sessionsRootOf', () => {
  it('walks up to the literal sessions segment, whatever the depth', () => {
    expect(sessionsRootOf('/h/.codex/sessions/2026/08/29/rollout-x.jsonl')).toBe('/h/.codex/sessions')
    expect(sessionsRootOf('/h/.codex/sessions/2026/rollout-x.jsonl')).toBe('/h/.codex/sessions')
  })
  it('refuses a path with no sessions segment — never walks above the jailed tree', () => {
    expect(sessionsRootOf('/tmp/rollout-x.jsonl')).toBeNull()
    expect(sessionsRootOf('/a/b/c/d/e/f/g/rollout-x.jsonl')).toBeNull()
  })
})

// --- formatter ---------------------------------------------------------------------------------

describe('formatCodexRolloutChunk', () => {
  it('renders assistant prose + tool calls, skips developer preambles and meta', () => {
    const out = formatCodexRolloutChunk(
      [
        sessionMeta('Dirac', 'architect'),
        developerMsg('You are Architect (Oracle). Huge injected preamble…'),
        assistantMsg('reading the module now'),
        functionCall('exec_command', { cmd: "sed -n '1,50p' foo.ts" }),
        taskComplete('done')
      ].join('\n')
    )
    expect(out).toContain('reading the module now')
    expect(out).toContain("$ exec_command sed -n '1,50p' foo.ts")
    expect(out).not.toContain('Oracle')
    expect(out).not.toContain('session_meta')
  })

  it('pickTaskComplete returns the latest last_agent_message', () => {
    expect(pickTaskComplete([taskComplete('first'), assistantMsg('x'), taskComplete('final answer')])).toBe('final answer')
    expect(pickTaskComplete([assistantMsg('x')])).toBeUndefined()
  })
})

// --- tail --------------------------------------------------------------------------------------

describe('createCodexAgentsTail', () => {
  it('1. started → labeled start card → chunks → completed → end with the child result', async () => {
    const h = setup()
    cleanups.push(h.base)
    fs.writeFileSync(
      childFile(h),
      [sessionMeta('Dirac', 'architect'), assistantMsg('hello from Dirac'), functionCall('exec_command', { cmd: 'ls' })].join('\n') + '\n'
    )
    const { tail, events, chunks } = makeTail()
    tail.started('nodeA', 'parent-1', THREAD, '/root/architecture_review', h.parentPath)

    await vi.waitFor(() => expect(events.find((e) => e.kind === 'subagent-start')).toBeTruthy(), {
      timeout: 8000,
      interval: 100
    })
    const start = events.find((e) => e.kind === 'subagent-start')!
    expect(start.toolUseId).toBe(`cxagent:${THREAD}`)
    expect(start.nodeId).toBe('nodeA')
    expect(start.sessionId).toBe('parent-1')
    expect(start.subagentType).toBe('architect')
    expect(start.taskLabel).toBe('Dirac · architecture_review')

    await vi.waitFor(() => expect(chunkText(chunks)).toContain('hello from Dirac'), {
      timeout: 8000,
      interval: 100
    })
    expect(chunkText(chunks)).toContain('$ exec_command ls')

    fs.appendFileSync(childFile(h), taskComplete('NO CRITICAL FINDINGS.') + '\n')
    tail.completed('nodeA', 'parent-1', THREAD, '/root/architecture_review', h.parentPath)
    await vi.waitFor(() => expect(events.find((e) => e.kind === 'subagent-end')).toBeTruthy(), {
      timeout: 8000,
      interval: 100
    })
    const end = events.find((e) => e.kind === 'subagent-end')!
    expect(end.toolUseId).toBe(`cxagent:${THREAD}`)
    expect(end.result).toBe('NO CRITICAL FINDINGS.')
    tail.release('nodeA')
  }, 20000)

  it('2. a child rollout that lags the started record is located on a later tick', async () => {
    const h = setup()
    cleanups.push(h.base)
    const { tail, events } = makeTail()
    tail.started('nodeB', 'parent-1', THREAD, '/root/audit', h.parentPath)
    await wait(300) // several locate attempts against a missing file
    fs.writeFileSync(childFile(h), sessionMeta('Sagan', 'executor') + '\n' + assistantMsg('late file') + '\n')
    await vi.waitFor(() => expect(events.find((e) => e.kind === 'subagent-start')).toBeTruthy(), {
      timeout: 8000,
      interval: 100
    })
    expect(events[0].taskLabel).toBe('Sagan · audit')
    tail.release('nodeB')
  }, 15000)

  it('3. completed for a child never located still yields a card (start-heal) and an end', async () => {
    const h = setup()
    cleanups.push(h.base)
    const { tail, events } = makeTail()
    tail.started('nodeC', 'parent-1', THREAD, '/root/ghost', h.parentPath)
    tail.completed('nodeC', 'parent-1', THREAD, '/root/ghost', h.parentPath) // no child file will ever exist
    await vi.waitFor(() => expect(events.find((e) => e.kind === 'subagent-end')).toBeTruthy(), {
      timeout: 8000,
      interval: 100
    })
    expect(events.find((e) => e.kind === 'subagent-start')).toBeTruthy()
    expect(events.find((e) => e.kind === 'subagent-end')!.result).toBeUndefined()
    tail.release('nodeC')
  }, 15000)

  it('4. release() mutes in-flight work — nothing emits after teardown', async () => {
    const h = setup()
    cleanups.push(h.base)
    fs.writeFileSync(childFile(h), sessionMeta('Rawls', 'executor') + '\n')
    const { tail, events } = makeTail()
    tail.started('nodeD', 'parent-1', THREAD, '/root/x', h.parentPath)
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 8000, interval: 100 })
    const count = events.length
    tail.release('nodeD')
    // The released child's in-flight/later reads are muted; nothing emits for its file. (A stale
    // 'completed' after release cannot arrive through the real wiring — releaseNodeTails untracks
    // the parent's context tail in the same teardown — so it is not simulated here: the tail's
    // completed() deliberately HEALS unknown threads, see the heal test below.)
    fs.appendFileSync(childFile(h), assistantMsg('after release') + '\n' + taskComplete('ignored') + '\n')
    await wait(1200)
    expect(events.length).toBe(count)
  }, 15000)

  it('6. a completed for a thread whose started was never seen HEALS the card (start + end)', async () => {
    const h = setup()
    cleanups.push(h.base)
    fs.writeFileSync(
      childFile(h),
      [sessionMeta('Rawls', 'executor'), assistantMsg('healed work'), taskComplete('healed result')].join('\n') + '\n'
    )
    const { tail, events, chunks } = makeTail()
    // No started() ever — the parent's record fell into an offset-jumped burst.
    tail.completed('nodeF', 'parent-1', THREAD, '/root/audit_kvart', h.parentPath)
    await vi.waitFor(() => expect(events.find((e) => e.kind === 'subagent-end')).toBeTruthy(), {
      timeout: 8000,
      interval: 100
    })
    const start = events.find((e) => e.kind === 'subagent-start')!
    expect(start).toBeTruthy()
    expect(start.toolUseId).toBe(`cxagent:${THREAD}`)
    expect(events.find((e) => e.kind === 'subagent-end')!.result).toBe('healed result')
    expect(chunkText(chunks)).toContain('healed work')
    tail.release('nodeF')
  }, 15000)

  it('7. a started arriving INSIDE the grace window cancels the close — the card stays live', async () => {
    const h = setup()
    cleanups.push(h.base)
    fs.writeFileSync(childFile(h), sessionMeta('Dirac', 'architect') + '\n' + assistantMsg('first task') + '\n')
    const { tail, events } = makeTail()
    tail.started('nodeG', 'parent-1', THREAD, '/root/arch', h.parentPath)
    await vi.waitFor(() => expect(events.find((e) => e.kind === 'subagent-start')).toBeTruthy(), {
      timeout: 8000,
      interval: 100
    })
    tail.completed('nodeG', 'parent-1', THREAD, '/root/arch', h.parentPath)
    await wait(300) // inside the grace window
    tail.started('nodeG', 'parent-1', THREAD, '/root/arch', h.parentPath) // quick follow-up task
    await wait(2000) // well past where the canceled close would have fired
    expect(events.find((e) => e.kind === 'subagent-end')).toBeUndefined()
    // The follow-up completing closes it normally.
    fs.appendFileSync(childFile(h), taskComplete('second result') + '\n')
    tail.completed('nodeG', 'parent-1', THREAD, '/root/arch', h.parentPath)
    await vi.waitFor(() => expect(events.find((e) => e.kind === 'subagent-end')).toBeTruthy(), {
      timeout: 8000,
      interval: 100
    })
    expect(events.find((e) => e.kind === 'subagent-end')!.result).toBe('second result')
    expect(events.filter((e) => e.kind === 'subagent-start').length).toBe(1) // never re-started
    tail.release('nodeG')
  }, 20000)

  it('8. a child file appearing after the label attempts ran out still streams (locate retry)', async () => {
    const h = setup()
    cleanups.push(h.base)
    const { tail, events, chunks } = makeTail()
    tail.started('nodeH', 'parent-1', THREAD, '/root/slow', h.parentPath)
    // Let the label attempts exhaust against a missing file → an unlabeled card starts.
    await vi.waitFor(() => expect(events.find((e) => e.kind === 'subagent-start')).toBeTruthy(), {
      timeout: 8000,
      interval: 100
    })
    expect(chunkText(chunks)).toBe('')
    // The file finally lands — the tail must still locate and stream it.
    fs.writeFileSync(childFile(h), sessionMeta('Late', 'executor') + '\n' + assistantMsg('late but streamed') + '\n')
    await vi.waitFor(() => expect(chunkText(chunks)).toContain('late but streamed'), {
      timeout: 8000,
      interval: 100
    })
    tail.release('nodeH')
  }, 15000)

  it('5. a later started for a finished child re-opens the card without replaying its transcript', async () => {
    const h = setup()
    cleanups.push(h.base)
    fs.writeFileSync(childFile(h), sessionMeta('Dirac', 'architect') + '\n' + assistantMsg('turn one') + '\n' + taskComplete('turn one done') + '\n')
    const { tail, events, chunks } = makeTail()
    tail.started('nodeE', 'parent-1', THREAD, '/root/arch', h.parentPath)
    await vi.waitFor(() => expect(events.find((e) => e.kind === 'subagent-start')).toBeTruthy(), {
      timeout: 8000,
      interval: 100
    })
    tail.completed('nodeE', 'parent-1', THREAD, '/root/arch', h.parentPath)
    await vi.waitFor(() => expect(events.find((e) => e.kind === 'subagent-end')).toBeTruthy(), {
      timeout: 8000,
      interval: 100
    })
    const chunksAfterFirst = chunkText(chunks)
    expect(chunksAfterFirst).toContain('turn one')

    // The parent re-engages the same child on a later turn.
    tail.started('nodeE', 'parent-1', THREAD, '/root/arch', h.parentPath)
    fs.appendFileSync(childFile(h), assistantMsg('turn two') + '\n')
    await vi.waitFor(
      () => expect(events.filter((e) => e.kind === 'subagent-start').length).toBe(2),
      { timeout: 8000, interval: 100 }
    )
    await vi.waitFor(() => expect(chunkText(chunks)).toContain('turn two'), {
      timeout: 8000,
      interval: 100
    })
    // The re-open kept the offset: turn one's text streamed exactly once.
    expect(chunkText(chunks).split('turn one').length - 1).toBe(1)
    tail.release('nodeE')
  }, 20000)
})
