import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { claudeConfigDirFor, claudeConfigDirForSpawn } from './claude-config-dir'
import fs from 'fs'
import os from 'os'
import path from 'path'

beforeEach(() => initPlatform(fakePlatform({ userDataDir: '/tmp/ud' })))
afterEach(() => resetPlatformForTests())

describe('claudeConfigDirFor', () => {
  // NOTE: the actual current signature in claude-accounts.ts is
  // `claudeConfigDirFor(accountId: string): string` — accountId is REQUIRED and the
  // return is always a string. Every caller guards (`accountId ? claudeConfigDirFor(id) : …`)
  // so undefined never reaches it. This test documents that ACTUAL behavior; the refactor
  // must not change it.
  it('an account id resolves under userData/claude-accounts', () => {
    expect(claudeConfigDirFor('abc')).toContain('/tmp/ud')
    expect(claudeConfigDirFor('abc')).toContain('abc')
    expect(claudeConfigDirFor('abc')).toBe('/tmp/ud/claude-accounts/abc')
  })

  it('reads userDataDir lazily from the platform seam', () => {
    resetPlatformForTests()
    initPlatform(fakePlatform({ userDataDir: '/other/ud' }))
    expect(claudeConfigDirFor('xyz')).toBe('/other/ud/claude-accounts/xyz')
  })

  it('rejects a traversal-shaped account id (id validation preserved)', () => {
    expect(() => claudeConfigDirFor('../escape')).toThrow(/invalid account id/)
  })

  // Passing undefined is a type error at call sites; at runtime it throws (path.join on
  // undefined) rather than returning undefined — documenting that callers must guard.
  it('throws when accountId is missing (callers must guard)', () => {
    expect(() => claudeConfigDirFor(undefined as unknown as string)).toThrow()
  })
})

describe('claudeConfigDirForSpawn — a co-located peer\'s account dir is a spawn-time fallback only', () => {
  let own: string
  let peer: string
  beforeEach(() => {
    own = fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-own-'))
    peer = fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-peer-'))
  })
  afterEach(() => {
    for (const d of [own, peer]) fs.rmSync(d, { recursive: true, force: true })
  })

  it('no peer configured → the own path, whether or not it exists', () => {
    resetPlatformForTests()
    initPlatform(fakePlatform({ userDataDir: own }))
    expect(claudeConfigDirForSpawn('abc')).toBe(path.join(own, 'claude-accounts', 'abc'))
  })

  it('peer configured, own dir absent, peer dir present → the peer path', () => {
    resetPlatformForTests()
    initPlatform(fakePlatform({ userDataDir: own, peerUserDataDir: peer }))
    fs.mkdirSync(path.join(peer, 'claude-accounts', 'abc'), { recursive: true })
    expect(claudeConfigDirForSpawn('abc')).toBe(path.join(peer, 'claude-accounts', 'abc'))
  })

  it('own dir present → the own path even when the peer has the id too', () => {
    resetPlatformForTests()
    initPlatform(fakePlatform({ userDataDir: own, peerUserDataDir: peer }))
    fs.mkdirSync(path.join(own, 'claude-accounts', 'abc'), { recursive: true })
    fs.mkdirSync(path.join(peer, 'claude-accounts', 'abc'), { recursive: true })
    expect(claudeConfigDirForSpawn('abc')).toBe(path.join(own, 'claude-accounts', 'abc'))
  })

  it('neither exists → the own (absent) path, so the caller reports the fallback honestly', () => {
    resetPlatformForTests()
    initPlatform(fakePlatform({ userDataDir: own, peerUserDataDir: peer }))
    expect(claudeConfigDirForSpawn('abc')).toBe(path.join(own, 'claude-accounts', 'abc'))
  })

  it('validates the id before touching the peer tree', () => {
    resetPlatformForTests()
    initPlatform(fakePlatform({ userDataDir: own, peerUserDataDir: peer }))
    expect(() => claudeConfigDirForSpawn('../escape')).toThrow(/invalid account id/)
  })
})
