import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copySessionTranscript, type AccountTranscriptRoots } from './account-transcript-copy'
import { transcriptRootFor } from './claude-accounts-core'
import { encodeTranscriptDir } from './transcript-reader'

// A UUID-shaped session id (SESSION_ID_RE = /^[0-9a-fA-F-]{8,64}$/).
const SID = '11111111-2222-3333-4444-555555555555'
const CWD = '/home/me/proj'

describe('copySessionTranscript', () => {
  let tmp: string
  let roots: AccountTranscriptRoots

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-copy-'))
    // homeDir holds the system `~/.claude`; userDataDir holds managed accounts' config dirs.
    roots = { homeDir: path.join(tmp, 'home'), userDataDir: path.join(tmp, 'userData') }
    fs.mkdirSync(roots.homeDir, { recursive: true })
    fs.mkdirSync(roots.userDataDir, { recursive: true })
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  // Write `<root>/<encodedCwd>/<sid>.jsonl` under the given account's projects root.
  const seed = (accountId: string | undefined, contents: string): string => {
    const root = transcriptRootFor(roots.homeDir, roots.userDataDir, accountId)
    const dir = path.join(root, encodeTranscriptDir(CWD))
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${SID}.jsonl`)
    fs.writeFileSync(file, contents)
    return file
  }
  const targetFile = (accountId: string | undefined): string =>
    path.join(
      transcriptRootFor(roots.homeDir, roots.userDataDir, accountId),
      encodeTranscriptDir(CWD),
      `${SID}.jsonl`
    )

  it('copies system → account', async () => {
    seed(undefined, 'line1\nline2\n')
    const res = await copySessionTranscript(SID, undefined, 'acctA', CWD, roots)
    expect(res).toEqual({ ok: true, copied: 1 })
    expect(fs.readFileSync(targetFile('acctA'), 'utf8')).toBe('line1\nline2\n')
  })

  it('copies account → account', async () => {
    seed('acctA', 'hello\n')
    const res = await copySessionTranscript(SID, 'acctA', 'acctB', CWD, roots)
    expect(res).toEqual({ ok: true, copied: 1 })
    expect(fs.readFileSync(targetFile('acctB'), 'utf8')).toBe('hello\n')
  })

  it('copies account → system', async () => {
    seed('acctA', 'world\n')
    const res = await copySessionTranscript(SID, 'acctA', undefined, CWD, roots)
    expect(res).toEqual({ ok: true, copied: 1 })
    expect(fs.readFileSync(targetFile(undefined), 'utf8')).toBe('world\n')
  })

  it('also copies the session subagents sibling tree when present', async () => {
    seed('acctA', 'transcript\n')
    // The sibling tree subagent tails read: `<projectDir>/<sid>/subagents/agent-*.jsonl`.
    const srcSessionDir = path.join(
      transcriptRootFor(roots.homeDir, roots.userDataDir, 'acctA'),
      encodeTranscriptDir(CWD),
      SID,
      'subagents'
    )
    fs.mkdirSync(srcSessionDir, { recursive: true })
    fs.writeFileSync(path.join(srcSessionDir, 'agent-1.jsonl'), 'sub1\n')
    fs.writeFileSync(path.join(srcSessionDir, 'agent-1.meta.json'), '{"toolUseId":"t"}\n')

    const res = await copySessionTranscript(SID, 'acctA', 'acctB', CWD, roots)
    expect(res).toEqual({ ok: true, copied: 3 }) // transcript + 2 subagent files

    const dstSubagents = path.join(
      transcriptRootFor(roots.homeDir, roots.userDataDir, 'acctB'),
      encodeTranscriptDir(CWD),
      SID,
      'subagents'
    )
    expect(fs.readFileSync(path.join(dstSubagents, 'agent-1.jsonl'), 'utf8')).toBe('sub1\n')
    expect(fs.readFileSync(path.join(dstSubagents, 'agent-1.meta.json'), 'utf8')).toBe(
      '{"toolUseId":"t"}\n'
    )
  })

  it('refuses an invalid source account id (never builds a path)', async () => {
    seed(undefined, 'x\n')
    const res = await copySessionTranscript(SID, '../evil', 'acctB', CWD, roots)
    expect(res).toEqual({ ok: false, reason: 'invalid' })
  })

  it('refuses an invalid target account id', async () => {
    seed('acctA', 'x\n')
    const res = await copySessionTranscript(SID, 'acctA', 'bad/id', CWD, roots)
    expect(res).toEqual({ ok: false, reason: 'invalid' })
  })

  it('refuses an invalid session id', async () => {
    const res = await copySessionTranscript('../../etc/passwd', undefined, 'acctB', CWD, roots)
    expect(res).toEqual({ ok: false, reason: 'invalid' })
  })

  it('reports not-found when the source transcript is missing', async () => {
    const res = await copySessionTranscript(SID, 'acctA', 'acctB', CWD, roots)
    expect(res).toEqual({ ok: false, reason: 'not-found' })
  })

  it('resolves the source by sessionId when the cwd-encoded dir differs', async () => {
    // Seed under a DIFFERENT project dir than encodeTranscriptDir(CWD) — the scan fallback should
    // still find it strictly by the session filename.
    const root = transcriptRootFor(roots.homeDir, roots.userDataDir, 'acctA')
    const dir = path.join(root, '-some-other-proj')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${SID}.jsonl`), 'scanned\n')

    const res = await copySessionTranscript(SID, 'acctA', 'acctB', CWD, roots)
    expect(res).toEqual({ ok: true, copied: 1 })
    const dst = path.join(
      transcriptRootFor(roots.homeDir, roots.userDataDir, 'acctB'),
      '-some-other-proj',
      `${SID}.jsonl`
    )
    expect(fs.readFileSync(dst, 'utf8')).toBe('scanned\n')
  })
})
