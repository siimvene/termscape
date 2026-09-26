import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { locatePi } from './locate'

const root = mkdtempSync(path.join(tmpdir(), 'locate-pi-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const prevAgentDir = process.env.PI_CODING_AGENT_DIR
afterEach(() => {
  if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir
})

describe('locatePi', () => {
  it('finds the file ending with `_<sessionId>.jsonl`, walking encoded-cwd subdirectories', async () => {
    const agentDir = path.join(root, 'agent1')
    process.env.PI_CODING_AGENT_DIR = agentDir
    const dir = path.join(agentDir, 'sessions', '--Users-siim-git-consort--')
    mkdirSync(dir, { recursive: true })
    const target = path.join(dir, '2026-09-26T11-25-19-445Z_01a0dd76-66d4-7dde-b8ee-3fd4dd0a917e.jsonl')
    writeFileSync(target, '{}')
    // A sibling with a DIFFERENT session id must never match.
    writeFileSync(path.join(dir, '2026-09-26T11-25-19-445Z_00000000-0000-0000-0000-000000000000.jsonl'), '{}')
    expect(await locatePi('01a0dd76-66d4-7dde-b8ee-3fd4dd0a917e')).toBe(target)
  })

  it('is strict by suffix: a session id that is a SUBSTRING of another file never matches', async () => {
    const agentDir = path.join(root, 'agent2')
    process.env.PI_CODING_AGENT_DIR = agentDir
    const dir = path.join(agentDir, 'sessions', '--proj--')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'x_prefix-abc123.jsonl'), '{}')
    expect(await locatePi('abc123')).toBeUndefined()
  })

  it('is undefined when no session dir exists yet (never throws)', async () => {
    process.env.PI_CODING_AGENT_DIR = path.join(root, 'does-not-exist')
    expect(await locatePi('01a0dd76-66d4-7dde-b8ee-3fd4dd0a917e')).toBeUndefined()
  })

  it('is undefined for an empty session id without touching the filesystem', async () => {
    expect(await locatePi('')).toBeUndefined()
  })
})
