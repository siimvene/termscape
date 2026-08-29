import { describe, expect, it, vi, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createWorkflowAgentsTail, type WorkflowAgentEvent } from './workflow-agents-tail'

// --- fixtures -----------------------------------------------------------------

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const userLine = (prompt: string): string =>
  JSON.stringify({ type: 'user', message: { content: prompt } })

const assistant = (text: string): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

const jrec = (type: string, agentId: string, result?: string): string =>
  JSON.stringify({ type, key: `v2:${agentId}`, agentId, ...(result != null ? { result } : {}) })

interface Harness {
  base: string
  transcriptPath: string
  root: string // <transcript minus .jsonl>/subagents/workflows
}

function setup(): Harness {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wftail-'))
  const transcriptPath = path.join(base, 'sess.jsonl')
  const root = path.join(base, 'sess', 'subagents', 'workflows')
  return { base, transcriptPath, root }
}

/** Create a wf_* run dir under the workflows root. */
function mkWfDir(h: Harness, name: string): string {
  const dir = path.join(h.root, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function writeAgent(dir: string, agentId: string, model: string, prompt: string): void {
  fs.writeFileSync(
    path.join(dir, `agent-${agentId}.meta.json`),
    JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1, model })
  )
  fs.writeFileSync(path.join(dir, `agent-${agentId}.jsonl`), userLine(prompt) + '\n')
}

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
  tail: ReturnType<typeof createWorkflowAgentsTail>
  events: WorkflowAgentEvent[]
  chunks: { toolUseId: string; chunk: string }[]
} {
  const events: WorkflowAgentEvent[] = []
  const chunks: { toolUseId: string; chunk: string }[] = []
  const tail = createWorkflowAgentsTail({
    event: (ev) => events.push(ev),
    chunk: (p) => chunks.push(p)
  })
  return { tail, events, chunks }
}

const chunkText = (chunks: { toolUseId: string; chunk: string }[]): string =>
  chunks.map((c) => c.chunk).join('')

// --- tests --------------------------------------------------------------------

describe('createWorkflowAgentsTail', () => {
  it('1. stays silent for a pre-existing wf dir with a complete journal', async () => {
    const h = setup()
    cleanups.push(h.base)
    const dir = mkWfDir(h, 'wf_done')
    // A finished prior run: started + result already written before begin().
    fs.writeFileSync(
      path.join(dir, 'journal.jsonl'),
      jrec('started', 'aaa') + '\n' + jrec('result', 'aaa', 'all done') + '\n'
    )
    const { tail, events, chunks } = makeTail()
    // begin() adopts existing dirs at the journal's CURRENT size on the first readdir, so the
    // completed run's records fall before the offset and emit nothing.
    tail.begin('wf-tool-1', 'nodeA', 'sessA', h.transcriptPath)
    await wait(1400) // two+ ticks
    expect(events).toEqual([])
    expect(chunks).toEqual([])
    tail.release('nodeA')
  }, 15000)

  it('2. streams start (model + label) → chunks → end for a dir that appears after begin', async () => {
    const h = setup()
    cleanups.push(h.base)
    // Root exists but is EMPTY at begin, so the first readdir adopts nothing and the dir created
    // below is a genuine later appearance → offset 0 → its whole journal streams.
    fs.mkdirSync(h.root, { recursive: true })
    const { tail, events, chunks } = makeTail()
    tail.begin('wf-tool-2', 'nodeB', 'sessB', h.transcriptPath)
    await wait(700) // first tick: empty root scanned + adopted

    const dir = mkWfDir(h, 'wf_run')
    writeAgent(dir, 'abc', 'claude-opus-4-8', 'Do the thing   with\nspaces')
    fs.appendFileSync(path.join(dir, 'agent-abc.jsonl'), assistant('hello from agent') + '\n')
    fs.writeFileSync(path.join(dir, 'journal.jsonl'), jrec('started', 'abc') + '\n')

    await vi.waitFor(
      () => expect(events.find((e) => e.kind === 'subagent-start')).toBeTruthy(),
      { timeout: 8000, interval: 100 }
    )
    const start = events.find((e) => e.kind === 'subagent-start')!
    expect(start.toolUseId).toBe('wfagent:wf_run:abc')
    expect(start.nodeId).toBe('nodeB')
    expect(start.sessionId).toBe('sessB')
    expect(start.subagentType).toBe('claude-opus-4-8')
    expect(start.taskLabel).toBe('Do the thing with spaces')

    await vi.waitFor(() => expect(chunkText(chunks)).toContain('hello from agent'), {
      timeout: 8000,
      interval: 100
    })

    fs.appendFileSync(path.join(dir, 'journal.jsonl'), jrec('result', 'abc', 'final result text') + '\n')
    await vi.waitFor(() => expect(events.find((e) => e.kind === 'subagent-end')).toBeTruthy(), {
      timeout: 8000,
      interval: 100
    })
    const end = events.find((e) => e.kind === 'subagent-end')!
    expect(end.toolUseId).toBe('wfagent:wf_run:abc')
    expect(end.result).toBe('final result text')
    tail.release('nodeB')
  }, 20000)

  it('3. resume: dir exists at first listing, appended journal records still stream', async () => {
    const h = setup()
    cleanups.push(h.base)
    const dir = mkWfDir(h, 'wf_resume')
    // A completed prior run present at begin — must emit nothing (adopted at size).
    fs.writeFileSync(
      path.join(dir, 'journal.jsonl'),
      jrec('started', 'aaa') + '\n' + jrec('result', 'aaa', 'old') + '\n'
    )
    const { tail, events, chunks } = makeTail()
    tail.begin('wf-tool-3', 'nodeC', undefined, h.transcriptPath)
    await wait(700) // first tick adopts at current size

    // The run resumes and APPENDS a new agent's records.
    writeAgent(dir, 'bbb', 'claude-opus-4-8', 'resumed prompt')
    fs.appendFileSync(path.join(dir, 'agent-bbb.jsonl'), assistant('resumed work') + '\n')
    fs.appendFileSync(path.join(dir, 'journal.jsonl'), jrec('started', 'bbb') + '\n')
    await vi.waitFor(
      () => expect(events.find((e) => e.toolUseId === 'wfagent:wf_resume:bbb')).toBeTruthy(),
      { timeout: 8000, interval: 100 }
    )
    fs.appendFileSync(path.join(dir, 'journal.jsonl'), jrec('result', 'bbb', 'resumed done') + '\n')
    await vi.waitFor(
      () =>
        expect(
          events.find((e) => e.toolUseId === 'wfagent:wf_resume:bbb' && e.kind === 'subagent-end')
        ).toBeTruthy(),
      { timeout: 8000, interval: 100 }
    )
    // The old finished agent (aaa) never emitted anything.
    expect(events.some((e) => e.toolUseId.endsWith(':aaa'))).toBe(false)
    expect(chunkText(chunks)).toContain('resumed work')
    tail.release('nodeC')
  }, 20000)

  it('4. refuses a traversing agentId — no fs access outside the root, no event', async () => {
    const h = setup()
    cleanups.push(h.base)
    fs.mkdirSync(h.root, { recursive: true })
    const openSpy = vi.spyOn(fs.promises, 'open')
    const readSpy = vi.spyOn(fs.promises, 'readFile')
    const statSpy = vi.spyOn(fs.promises, 'stat')
    const { tail, events, chunks } = makeTail()
    tail.begin('wf-tool-4', 'nodeD', 'sessD', h.transcriptPath)
    await wait(700)

    const dir = mkWfDir(h, 'wf_bad')
    fs.writeFileSync(path.join(dir, 'journal.jsonl'), jrec('result', '../../evil', 'pwn') + '\n')
    await wait(1400)

    expect(events).toEqual([])
    expect(chunks).toEqual([])
    const touchedEvil = [...openSpy.mock.calls, ...readSpy.mock.calls, ...statSpy.mock.calls].some(
      (c) => String(c[0]).includes('evil')
    )
    expect(touchedEvil).toBe(false)
    openSpy.mockRestore()
    readSpy.mockRestore()
    statSpy.mockRestore()
    tail.release('nodeD')
  }, 15000)

  it('5. end() closes open agents; release() drops everything without events', async () => {
    const h = setup()
    cleanups.push(h.base)
    fs.mkdirSync(h.root, { recursive: true })

    // -- end() closes a still-open agent --
    {
      const { tail, events } = makeTail()
      tail.begin('wf-tool-5a', 'nodeE', 'sessE', h.transcriptPath)
      await wait(700)
      const dir = mkWfDir(h, 'wf_open')
      writeAgent(dir, 'ccc', 'claude-opus-4-8', 'still running')
      fs.writeFileSync(path.join(dir, 'journal.jsonl'), jrec('started', 'ccc') + '\n')
      await vi.waitFor(() => expect(events.find((e) => e.kind === 'subagent-start')).toBeTruthy(), {
        timeout: 8000,
        interval: 100
      })
      tail.end('wf-tool-5a')
      await vi.waitFor(() => expect(events.find((e) => e.kind === 'subagent-end')).toBeTruthy(), {
        timeout: 8000,
        interval: 100
      })
      const end = events.find((e) => e.kind === 'subagent-end')!
      expect(end.toolUseId).toBe('wfagent:wf_open:ccc')
      expect(end.result).toBeUndefined() // no journal result — closed with none
    }

    // -- release() drops silently, and the tail stops reacting --
    {
      const h2 = setup()
      cleanups.push(h2.base)
      fs.mkdirSync(h2.root, { recursive: true })
      const { tail, events } = makeTail()
      tail.begin('wf-tool-5b', 'nodeF', 'sessF', h2.transcriptPath)
      await wait(700)
      const dir = mkWfDir(h2, 'wf_rel')
      writeAgent(dir, 'ddd', 'claude-opus-4-8', 'to be released')
      fs.writeFileSync(path.join(dir, 'journal.jsonl'), jrec('started', 'ddd') + '\n')
      await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), {
        timeout: 8000,
        interval: 100
      })
      const countAtRelease = events.length
      tail.release('nodeF')
      // Appending after release must produce nothing — the begin/dir/agent are gone and the timer
      // stops once idle.
      fs.appendFileSync(path.join(dir, 'journal.jsonl'), jrec('result', 'ddd', 'ignored') + '\n')
      await wait(1400)
      expect(events.length).toBe(countAtRelease)
    }
  }, 30000)

  it('7. attributes a dir to the begin on ITS root, not the globally oldest begin', async () => {
    // Two concurrent Workflow calls on DIFFERENT nodes (different transcripts → different roots).
    // nodeX's begin is older and still dir-less; a dir appearing under nodeY's root must attach to
    // nodeY — a global oldest-without-dir walk would hand nodeY's agents to nodeX.
    const hX = setup()
    const hY = setup()
    cleanups.push(hX.base, hY.base)
    fs.mkdirSync(hX.root, { recursive: true })
    fs.mkdirSync(hY.root, { recursive: true })
    const { tail, events } = makeTail()
    tail.begin('wf-tool-7x', 'nodeX', 'sessX', hX.transcriptPath)
    tail.begin('wf-tool-7y', 'nodeY', 'sessY', hY.transcriptPath)
    await wait(200) // let both immediate scans adopt their empty roots

    const dir = mkWfDir(hY, 'wf_scoped')
    writeAgent(dir, 'aaa', 'claude-opus-4-8', 'scoped prompt')
    fs.writeFileSync(path.join(dir, 'journal.jsonl'), jrec('started', 'aaa') + '\n')
    await vi.waitFor(() => expect(events.find((e) => e.kind === 'subagent-start')).toBeTruthy(), {
      timeout: 8000,
      interval: 100
    })
    const start = events.find((e) => e.kind === 'subagent-start')!
    expect(start.nodeId).toBe('nodeY')
    expect(start.sessionId).toBe('sessY')
    tail.release('nodeX')
    tail.release('nodeY')
  }, 15000)

  it('8. a sub-tick workflow still renders: end() scans late, grace window streams a late flush', async () => {
    const h = setup()
    cleanups.push(h.base)
    // The root does NOT exist at begin (first run ever) and the whole workflow finishes faster
    // than a poll tick: begin → dir + started → end, all before 500 ms. The dir is discovered by
    // end()'s late scan (its begin already left the map), stays OPEN through the grace window,
    // and a result that flushes AFTER the PostToolUse still streams with its text.
    const { tail, events } = makeTail()
    tail.begin('wf-tool-8', 'nodeH', 'sessH', h.transcriptPath)
    const dir = mkWfDir(h, 'wf_fast')
    writeAgent(dir, 'fff', 'claude-opus-4-8', 'fast prompt')
    fs.writeFileSync(path.join(dir, 'journal.jsonl'), jrec('started', 'fff') + '\n')
    tail.end('wf-tool-8')
    await wait(300) // inside the grace window
    fs.appendFileSync(path.join(dir, 'journal.jsonl'), jrec('result', 'fff', 'late flush') + '\n')

    await vi.waitFor(
      () =>
        expect(
          events.find((e) => e.kind === 'subagent-end' && e.toolUseId === 'wfagent:wf_fast:fff')
        ).toBeTruthy(),
      { timeout: 8000, interval: 100 }
    )
    const start = events.find((e) => e.kind === 'subagent-start')!
    expect(start.nodeId).toBe('nodeH')
    const end = events.find((e) => e.kind === 'subagent-end')!
    expect(end.result).toBe('late flush') // grace kept the dir open — not a bare force-close
  }, 15000)

  it('9. an ended run is never re-adopted: post-end journal appends emit nothing', async () => {
    // The finalizer KEEPS the closed dir in the map — deleting it would let a still-active begin
    // on the same root re-adopt the dir at offset 0 and replay the whole journal as fresh cards.
    const h = setup()
    cleanups.push(h.base)
    fs.mkdirSync(h.root, { recursive: true })
    const { tail, events } = makeTail()
    tail.begin('wf-tool-9a', 'nodeI', 'sessI', h.transcriptPath)
    await wait(200)
    const dir = mkWfDir(h, 'wf_ended')
    writeAgent(dir, 'aaa', 'claude-opus-4-8', 'first run')
    fs.writeFileSync(
      path.join(dir, 'journal.jsonl'),
      jrec('started', 'aaa') + '\n' + jrec('result', 'aaa', 'done') + '\n'
    )
    await vi.waitFor(() => expect(events.find((e) => e.kind === 'subagent-end')).toBeTruthy(), {
      timeout: 8000,
      interval: 100
    })
    tail.end('wf-tool-9a')
    // A SECOND workflow begins on the same root while the first run's dir sits on disk.
    tail.begin('wf-tool-9b', 'nodeI', 'sessI', h.transcriptPath)
    await wait(2200) // past the first end's grace; several ticks for 9b's scans
    const count = events.length
    fs.appendFileSync(path.join(dir, 'journal.jsonl'), jrec('started', 'bbb') + '\n')
    await wait(1400)
    expect(events.length).toBe(count) // the ended dir stayed closed — no replay, no new cards
    tail.release('nodeI')
  }, 20000)

  it('10. idle backstop: a run whose notification never arrives closes itself', async () => {
    const h = setup()
    cleanups.push(h.base)
    fs.mkdirSync(h.root, { recursive: true })
    const events: import('./workflow-agents-tail').WorkflowAgentEvent[] = []
    const tail = createWorkflowAgentsTail(
      { event: (ev) => events.push(ev), chunk: () => {} },
      { idleCloseMs: 800, beginOrphanMs: 60_000 }
    )
    tail.begin('wf-tool-10', 'nodeJ', 'sessJ', h.transcriptPath)
    await wait(200)
    const dir = mkWfDir(h, 'wf_lost')
    writeAgent(dir, 'aaa', 'claude-opus-4-8', 'lost notification')
    fs.writeFileSync(
      path.join(dir, 'journal.jsonl'),
      jrec('started', 'aaa') + '\n' + jrec('result', 'aaa', 'finished quietly') + '\n'
    )
    // NO tail.end() ever — the notification is lost. The agent ends via its journal result, and
    // once the dir has been quiet past idleCloseMs the tail closes the run on its own.
    await vi.waitFor(() => expect(events.find((e) => e.kind === 'subagent-end')).toBeTruthy(), {
      timeout: 8000,
      interval: 100
    })
    await wait(2500) // past the idle window + a few ticks
    const count = events.length
    fs.appendFileSync(path.join(dir, 'journal.jsonl'), jrec('started', 'ccc') + '\n')
    await wait(1400)
    expect(events.length).toBe(count) // closed by the backstop — late appends are a degrade, not cards
    tail.release('nodeJ')
  }, 20000)

  it('6. survives an agent transcript line torn across two reads (carry)', async () => {
    const h = setup()
    cleanups.push(h.base)
    fs.mkdirSync(h.root, { recursive: true })
    const { tail, events, chunks } = makeTail()
    tail.begin('wf-tool-6', 'nodeG', 'sessG', h.transcriptPath)
    await wait(700)

    const dir = mkWfDir(h, 'wf_torn')
    // Complete first (user) line so the label resolves and the start fires; then a torn assistant
    // line whose two halves land on different ticks.
    fs.writeFileSync(path.join(dir, 'agent-eee.meta.json'), JSON.stringify({ model: 'claude-opus-4-8' }))
    const torn = assistant('torn transcript survives')
    fs.writeFileSync(path.join(dir, 'agent-eee.jsonl'), userLine('prompt') + '\n' + torn.slice(0, 20))
    fs.writeFileSync(path.join(dir, 'journal.jsonl'), jrec('started', 'eee') + '\n')

    await vi.waitFor(() => expect(events.find((e) => e.kind === 'subagent-start')).toBeTruthy(), {
      timeout: 8000,
      interval: 100
    })
    // Complete the torn line on a later tick.
    fs.appendFileSync(path.join(dir, 'agent-eee.jsonl'), torn.slice(20) + '\n')
    await vi.waitFor(() => expect(chunkText(chunks)).toContain('torn transcript survives'), {
      timeout: 8000,
      interval: 100
    })
    tail.release('nodeG')
  }, 20000)
})
