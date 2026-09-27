import fs from 'fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseTranscriptLines,
  pickSessionName,
  readSessionName,
  setRemoteTranscriptReader
} from './transcript-reader'
import type { TranscriptLine } from '../shared/types'

describe('pickSessionName', () => {
  const ai = (t: string) => JSON.stringify({ type: 'ai-title', aiTitle: t, sessionId: 's' })
  const custom = (t: string) => JSON.stringify({ type: 'custom-title', customTitle: t, sessionId: 's' })

  it('returns the auto name when no /rename title is present', () => {
    expect(pickSessionName([ai('First topic'), ai('Refined topic')].join('\n'))).toBe('Refined topic')
  })

  it('prefers the user /rename name over the auto name', () => {
    const text = [ai('auto'), custom('My Work'), ai('auto changed')].join('\n')
    expect(pickSessionName(text)).toBe('My Work')
  })

  it('uses the latest custom-title and trims it', () => {
    const text = [custom('old'), custom('  new  ')].join('\n')
    expect(pickSessionName(text)).toBe('new')
  })

  it('returns null when there is no title record (and ignores junk lines)', () => {
    expect(pickSessionName('not json\n{"type":"assistant"}\n')).toBeNull()
  })
})

describe('parseTranscriptLines', () => {
  it('maps each JSONL line to TranscriptLine[] (role/text), mirroring the reader', () => {
    const text = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'hello' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/a/b/workspace.ts' } }
          ]
        }
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'text', text: 'do it' },
            { type: 'tool_result', content: 'line one\nline two\nline three\nline four' }
          ]
        }
      }),
      JSON.stringify({ type: 'user', message: { content: 'plain user' } }),
      '',
      'garbled'
    ].join('\n')
    const expected: TranscriptLine[] = [
      { role: 'assistant', text: 'hello' },
      { role: 'tool', text: '$ Read /a/b/workspace.ts' },
      { role: 'user', text: 'do it' },
      { role: 'tool', text: 'line one line two line three' },
      { role: 'user', text: 'plain user' }
    ]
    expect(parseTranscriptLines(text)).toEqual(expected)
  })
})

// An SSH project's Claude runs on the remote host, so its transcript .jsonl lives on the remote
// filesystem — the local scan can never find it. A registered remote reader (wired in main from
// the hook-fed transcript path) is consulted FIRST, so `/rename` on a remote node reaches the
// node title exactly like it does locally.
describe('readSessionName — remote (SSH project) sessions', () => {
  const sid = '11111111-2222-3333-4444-555555555555'
  const custom = (t: string) => JSON.stringify({ type: 'custom-title', customTitle: t, sessionId: sid })

  afterEach(() => setRemoteTranscriptReader(null))

  it('reads the name from the remote transcript when the session is remote', async () => {
    setRemoteTranscriptReader(async (id) =>
      id === sid ? { text: [custom('Ship the relay fix')].join('\n') } : null
    )
    expect(await readSessionName(sid)).toBe('Ship the relay fix')
  })

  // A remote session is never in the local ~/.claude/projects, so scanning it is pure waste —
  // and today's poll does exactly that every 4s, forever, for every SSH agent node.
  it('does not scan the local transcript root for a known remote session', async () => {
    const readdir = vi.spyOn(fs.promises, 'readdir')
    setRemoteTranscriptReader(async () => ({ text: '' }))
    expect(await readSessionName(sid)).toBeNull()
    expect(readdir).not.toHaveBeenCalled()
    readdir.mockRestore()
  })

  it('falls through to the local reader when the session is not remote', async () => {
    setRemoteTranscriptReader(async () => null)
    // No local transcript for this id either — the point is that it did not throw and the
    // remote branch declined, leaving today's local behavior intact.
    expect(await readSessionName(sid)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Paged chat reads (the ⌘M panel's progressive loading). A window is `[start, end)` in BYTES of the
// transcript file; `parseChatWindow` is the pure half, `readChatWindow` the fs half.
// ─────────────────────────────────────────────────────────────────────────────────────────────
import os from 'os'
import path from 'path'
import { parseChatMessages, parseChatWindow, readChatWindow } from './transcript-reader'

const jl = (o: object): string => JSON.stringify(o) + '\n'
const said = (role: 'user' | 'assistant', text: string): string =>
  role === 'user'
    ? jl({ type: 'user', message: { content: text } })
    : jl({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const toolUse = (id: string, command: string): string =>
  jl({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] }
  })
const toolResult = (id: string, out: string): string =>
  jl({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: out }] } })

const textOfMsg = (m: { parts: Array<{ kind: string; text?: string }> }): string =>
  m.parts.map((p) => p.text ?? '').join('')

describe('parseChatWindow — pure window parsing', () => {
  it('a window starting at 0 parses every line and reports it reached the start', () => {
    const file = Buffer.from(said('user', 'a') + said('assistant', 'b'))
    const r = parseChatWindow(file, 0)
    expect(r.olderCursor).toBeNull()
    expect(r.messages.map(textOfMsg)).toEqual(['a', 'b'])
  })

  it('keys each message by the ABSOLUTE byte offset of its source line', () => {
    const l1 = said('user', 'first')
    const l2 = said('assistant', 'ğüşé multibyte') // byte length != string length
    const l3 = said('user', 'third')
    const file = Buffer.from(l1 + l2 + l3)
    const r = parseChatWindow(file, 0)
    const b1 = Buffer.byteLength(l1)
    const b2 = Buffer.byteLength(l2)
    expect(r.messages.map((m) => m.key)).toEqual([0, b1, b1 + b2])
    // The same line read through a later window keeps its key — a prepend never re-keys.
    const tail = parseChatWindow(file.subarray(b1 - 1), b1 - 1)
    expect(tail.messages.map((m) => m.key)).toEqual([b1, b1 + b2])
  })

  it('drops the partial leading line and points olderCursor at the first COMPLETE line', () => {
    const l1 = said('user', 'x'.repeat(50))
    const l2 = said('assistant', 'kept')
    const file = Buffer.from(l1 + l2)
    const start = 10 // mid-l1
    const r = parseChatWindow(file.subarray(start), start)
    expect(r.messages.map(textOfMsg)).toEqual(['kept'])
    expect(r.olderCursor).toBe(Buffer.byteLength(l1))
  })

  it('keeps a line that begins exactly on the window edge when the caller passes the one-byte lookbehind', () => {
    // The byte BEFORE the window is the only way to know a line starts exactly on its edge, which
    // is why readChatWindow reads one byte of lookbehind. Without it that line would be dropped as
    // "partial" — and, being the window's only line, skipped for good.
    const l1 = said('user', 'one')
    const l2 = said('assistant', 'two')
    const file = Buffer.from(l1 + l2)
    const edge = Buffer.byteLength(l1)
    const r = parseChatWindow(file.subarray(edge - 1), edge - 1)
    expect(r.messages.map(textOfMsg)).toEqual(['two'])
    expect(r.olderCursor).toBe(edge)
  })

  it('never returns an olderCursor equal to the window end (a line larger than the window is skipped, not looped on)', () => {
    const huge = said('user', 'h'.repeat(300))
    const file = Buffer.from(huge)
    const start = 100
    const r = parseChatWindow(file.subarray(start), start)
    expect(r.messages).toEqual([])
    expect(r.olderCursor).toBe(start) // strictly older than the window end → paging progresses
    // …and SAYS so, explicitly: the reader grows the window on this flag instead of skipping the
    // line (a pasted screenshot's user record is routinely bigger than a whole page).
    expect(r.noCompleteLine).toBe(true)
  })

  it('noCompleteLine is false whenever the window holds a complete line, or starts at 0', () => {
    const l1 = said('user', 'x'.repeat(50))
    const l2 = said('assistant', 'kept')
    const file = Buffer.from(l1 + l2)
    expect(parseChatWindow(file.subarray(10), 10).noCompleteLine).toBe(false)
    expect(parseChatWindow(file, 0).noCompleteLine).toBe(false)
    // A window that is ONE line from the very start of the file is complete, not oversized.
    expect(parseChatWindow(Buffer.from(l1), 0).noCompleteLine).toBe(false)
  })

  it('pages stitched together equal the unpaged parse, with no line lost or duplicated', () => {
    let body = ''
    for (let i = 0; i < 40; i++) body += said(i % 2 ? 'assistant' : 'user', `msg ${i} ç`)
    const file = Buffer.from(body)
    const whole = parseChatWindow(file, 0).messages
    const pages: (typeof whole)[] = []
    let end = file.length
    for (;;) {
      const winStart = Math.max(0, end - 200)
      const start = winStart > 0 ? winStart - 1 : 0 // one byte of lookbehind, as the reader does
      const r = parseChatWindow(file.subarray(start, end), start)
      pages.unshift(r.messages)
      if (r.olderCursor === null) break
      expect(r.olderCursor).toBeLessThan(end)
      end = r.olderCursor
    }
    expect(pages.flat()).toEqual(whole)
    expect(whole.map(textOfMsg)).toEqual(Array.from({ length: 40 }, (_, i) => `msg ${i} ç`))
  })

  it('gives tool parts their tool_use id and matches results inside one window', () => {
    const r = parseChatWindow(Buffer.from(toolUse('t1', 'ls') + toolResult('t1', 'a.txt')), 0)
    expect(r.messages[0].parts[0]).toMatchObject({ kind: 'tool', id: 't1', arg: 'ls', result: 'a.txt' })
    expect(r.unmatchedResults).toEqual([])
  })

  it('carries a result whose tool_use lives in an OLDER window (the page boundary case)', () => {
    const older = toolUse('t9', 'make build')
    const newer = toolResult('t9', 'build ok') + said('assistant', 'done')
    const file = Buffer.from(older + newer)
    const split = Buffer.byteLength(older)
    // Newest page first — its result has no tool to land on.
    const newest = parseChatWindow(file.subarray(split - 1), split - 1)
    expect(newest.messages.map(textOfMsg)).toEqual(['done'])
    expect(newest.unmatchedResults).toEqual([{ id: 't9', result: 'build ok' }])
    expect(newest.olderCursor).toBe(split)
    // The older page carries the tool with the id the carried result names, and no result of its own.
    const olderPage = parseChatWindow(file.subarray(0, newest.olderCursor!), 0)
    const tool = olderPage.messages[0].parts[0]
    expect(tool).toMatchObject({ kind: 'tool', id: 't9' })
    expect((tool as { result?: string }).result).toBeUndefined()
  })

  it('the legacy parser is untouched: no keys, no tool ids', () => {
    const msgs = parseChatMessages((toolUse('t1', 'ls') + toolResult('t1', 'x') + said('user', 'u')).split('\n'))
    expect(msgs).toEqual([
      { role: 'assistant', parts: [{ kind: 'tool', name: 'Bash', arg: 'ls', result: 'x' }] },
      { role: 'user', parts: [{ kind: 'text', text: 'u' }] }
    ])
  })
})

describe('message time (`at`, from the line\'s ISO `timestamp`)', () => {
  const stamped = (role: 'user' | 'assistant', text: string, timestamp: unknown): string =>
    role === 'user'
      ? jl({ type: 'user', timestamp, message: { content: text } })
      : jl({ type: 'assistant', timestamp, message: { content: [{ type: 'text', text }] } })
  const iso = '2026-09-25T19:37:29.097Z'
  const ms = Date.parse(iso)

  it('the paged path carries it on user and assistant messages', () => {
    const r = parseChatWindow(Buffer.from(stamped('user', 'q', iso) + stamped('assistant', 'a', iso)), 0)
    expect(r.messages.map((m) => m.at)).toEqual([ms, ms])
  })

  it('the legacy path carries it too (additive: nothing else changes)', () => {
    const msgs = parseChatMessages((stamped('user', 'q', iso) + stamped('assistant', 'a', iso)).split('\n'))
    expect(msgs).toEqual([
      { role: 'user', parts: [{ kind: 'text', text: 'q' }], at: ms },
      { role: 'assistant', parts: [{ kind: 'text', text: 'a' }], at: ms }
    ])
  })

  it('omits it when the line has none, or one that is not a date (never a made-up time)', () => {
    const msgs = parseChatMessages(
      (said('user', 'none') + stamped('user', 'bad', 'yesterday') + stamped('user', 'num', 12345)).split('\n')
    )
    expect(msgs.map((m) => 'at' in m)).toEqual([false, false, false])
  })
})

describe('readChatWindow — byte windows read from a real file', () => {
  let dir: string
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })
  const write = (body: string | Buffer): string => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-chat-window-'))
    const p = path.join(dir, 't.jsonl')
    fs.writeFileSync(p, body)
    return p
  }

  it('reads the newest window ending at EOF when `before` is null', async () => {
    const l1 = said('user', 'old')
    const l2 = said('assistant', 'new')
    const p = write(l1 + l2)
    const w = await readChatWindow(p, { before: null, maxBytes: Buffer.byteLength(l2) + 3 })
    expect(w).toBeDefined()
    expect(w!.start).toBe(Buffer.byteLength(l1) - 3 - 1) // window start minus the lookbehind byte
    const r = parseChatWindow(w!.data, w!.start)
    expect(r.messages.map(textOfMsg)).toEqual(['new'])
  })

  it('clamps a `before` past EOF to the file size and reads the whole of a small file', async () => {
    const p = write(said('user', 'only'))
    const w = await readChatWindow(p, { before: 10_000_000, maxBytes: 65536 })
    expect(w!.start).toBe(0)
    expect(w!.end).toBe(fs.statSync(p).size)
    expect(parseChatWindow(w!.data, 0).messages.map(textOfMsg)).toEqual(['only'])
  })

  it('a multi-byte UTF-8 character straddling the window edge never corrupts a returned message', async () => {
    const l1 = said('user', 'ğğğğğğğğ') // every char is 2 bytes
    const l2 = said('assistant', 'çok güzel — ✓')
    const file = Buffer.from(l1 + l2)
    const p = write(file)
    // Start the window one byte INTO a 2-byte char of l1.
    const firstG = file.indexOf(Buffer.from('ğ'))
    const start = firstG + 1
    const w = await readChatWindow(p, { before: null, maxBytes: file.length - start })
    expect(w!.start).toBe(start - 1) // the lookbehind byte is the FIRST byte of that ğ
    const r = parseChatWindow(w!.data, w!.start)
    expect(r.messages.map(textOfMsg)).toEqual(['çok güzel — ✓'])
    expect(JSON.stringify(r.messages)).not.toContain('�')
    expect(r.olderCursor).toBe(Buffer.byteLength(l1))
    // …and the older page re-reads l1 whole, straddling char included.
    const w2 = await readChatWindow(p, { before: r.olderCursor, maxBytes: 65536 })
    expect(parseChatWindow(w2!.data, w2!.start).messages.map(textOfMsg)).toEqual(['ğğğğğğğğ'])
  })

  it('a window whose edge falls exactly on a line start keeps that line (one byte of lookbehind)', async () => {
    const l1 = said('user', 'a'.repeat(100))
    const l2 = said('assistant', 'exactly-fits')
    const l3 = said('user', 'newer')
    const p = write(l1 + l2 + l3)
    const before = Buffer.byteLength(l1 + l2)
    const w = await readChatWindow(p, { before, maxBytes: Buffer.byteLength(l2) })
    expect(w!.end).toBe(before)
    const r = parseChatWindow(w!.data, w!.start)
    expect(r.messages.map(textOfMsg)).toEqual(['exactly-fits'])
    expect(r.olderCursor).toBe(Buffer.byteLength(l1))
  })

  it('returns undefined for an unreadable file', async () => {
    expect(await readChatWindow('/nonexistent/nt/x.jsonl', { before: null, maxBytes: 65536 })).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tool bodies: a plan (ExitPlanMode) or a question (AskUserQuestion) is the content the user needs
// to read, not a chip. Must ride BOTH the legacy and the paged parse, keys/carried results unchanged.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const PLAN = '# Plan\n\n1. Read the plan\n2. Render it'
const planUse = (id: string): string =>
  jl({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'ExitPlanMode', input: { plan: PLAN } }] }
  })

describe('tool bodies in the chat parse', () => {
  it('the legacy parser attaches the plan as the tool body (and nothing else changes)', () => {
    const msgs = parseChatMessages((planUse('p1') + toolResult('p1', 'User approved')).split('\n'))
    expect(msgs).toEqual([
      { role: 'assistant', parts: [{ kind: 'tool', name: 'ExitPlanMode', arg: '', body: PLAN, result: 'User approved' }] }
    ])
  })

  it('the paged parser attaches the same body, keeps the id and the key', () => {
    const r = parseChatWindow(Buffer.from(planUse('p1') + toolResult('p1', 'User approved')), 0)
    expect(r.messages).toEqual([
      {
        role: 'assistant',
        key: 0,
        parts: [{ kind: 'tool', name: 'ExitPlanMode', arg: '', body: PLAN, id: 'p1', result: 'User approved' }]
      }
    ])
  })

  it('a plan whose answer lands in a newer page still carries its result by id', () => {
    const older = planUse('p2')
    const file = Buffer.from(older + toolResult('p2', 'User rejected'))
    const split = Buffer.byteLength(older)
    const newest = parseChatWindow(file.subarray(split - 1), split - 1)
    expect(newest.unmatchedResults).toEqual([{ id: 'p2', result: 'User rejected' }])
    const olderPage = parseChatWindow(file.subarray(0, split), 0)
    expect(olderPage.messages[0].parts[0]).toMatchObject({ kind: 'tool', id: 'p2', body: PLAN })
  })

  it('a question carries its structured questions beside the markdown body (the answer controls)', () => {
    const input = {
      questions: [
        { question: 'Pick one?', header: 'H', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B' }] }
      ]
    }
    const line = jl({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input }] } })
    const legacy = parseChatMessages(line.split('\n'))[0].parts[0]
    const paged = parseChatWindow(Buffer.from(line), 0).messages[0].parts[0]
    for (const part of [legacy, paged]) {
      expect(part).toMatchObject({
        kind: 'tool',
        name: 'AskUserQuestion',
        questions: [
          { question: 'Pick one?', header: 'H', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B' }] }
        ]
      })
      expect(part.kind === 'tool' && part.body).toContain('Pick one?')
    }
    // A plan carries no questions.
    const plan = parseChatMessages(planUse('p1').split('\n'))[0].parts[0]
    expect(plan.kind === 'tool' && 'questions' in plan).toBe(false)
  })

  it('a tool with no body keeps today\'s shape exactly (no body key)', () => {
    const msgs = parseChatMessages(toolUse('t1', 'ls').split('\n'))
    expect(msgs[0].parts[0]).toEqual({ kind: 'tool', name: 'Bash', arg: 'ls' })
  })

  it('the search index includes the plan text so the find bar can find it', () => {
    const lines = parseTranscriptLines(planUse('p1'))
    expect(lines).toEqual([
      { role: 'tool', text: '$ ExitPlanMode' },
      { role: 'tool', text: PLAN }
    ])
  })
})

// The title poll runs every 4–15 s per agent node, and each poll used to read + parse a 128 KB
// tail. The name can only change when the transcript does, so an unchanged (size, mtime) must
// answer from the cache without touching the file's bytes — while a /rename (the file grows)
// must still be picked up on the next poll.
describe('readSessionName — unchanged transcripts are not re-read', () => {
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const custom = (t: string) => JSON.stringify({ type: 'custom-title', customTitle: t, sessionId: sid })
  let home: string
  let file: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-title-cache-'))
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    const dir = path.join(home, '.claude', 'projects', '-proj')
    fs.mkdirSync(dir, { recursive: true })
    file = path.join(dir, `${sid}.jsonl`)
    fs.writeFileSync(file, custom('First') + '\n')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(home, { recursive: true, force: true })
  })

  // readSmallTail reads a small file with readFile and a large one with open+read — spy on both,
  // so "no tail read" holds whichever branch the fixture size lands on.
  it('does not re-read an unchanged transcript', async () => {
    const readFile = vi.spyOn(fs.promises, 'readFile')
    const open = vi.spyOn(fs.promises, 'open')
    expect(await readSessionName(sid)).toBe('First')
    const reads = readFile.mock.calls.length + open.mock.calls.length
    expect(reads).toBeGreaterThan(0)
    expect(await readSessionName(sid)).toBe('First')
    expect(readFile.mock.calls.length + open.mock.calls.length).toBe(reads)
  })

  it('re-reads after the transcript changes (e.g. /rename)', async () => {
    expect(await readSessionName(sid)).toBe('First')
    fs.appendFileSync(file, custom('Second') + '\n')
    expect(await readSessionName(sid)).toBe('Second')
  })
})
