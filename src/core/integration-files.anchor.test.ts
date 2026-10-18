// Fork (Termscape): `mkdirBelow` and the anchored `writeOwnedFile` — writes into a managed account dir
// must never recreate the account dir itself (see `mkdirBelow` in integration-files.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { ReceiptStore, isAnchorGone, mkdirBelow, writeOwnedFile } from './integration-files'
import { installPiExtensionInto, piExtensionPath, PI_EXTENSION_MARKER } from './agents/hooks/pi'
import { isAnyManagedPiAccountDir, isManagedPiAccountDir } from './pi-config-dir'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { installPiHooks } from './agents/hooks/pi'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'nt-anchor-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('mkdirBelow', () => {
  it('creates every level below an existing anchor', () => {
    const anchor = path.join(tmp, 'acct')
    mkdirSync(anchor)
    mkdirBelow(anchor, path.join(anchor, 'skills', 'a', 'b'))
    expect(existsSync(path.join(anchor, 'skills', 'a', 'b'))).toBe(true)
    mkdirBelow(anchor, path.join(anchor, 'skills', 'a', 'b')) // idempotent
    mkdirBelow(anchor, anchor) // the anchor itself: nothing to create
  })

  it('never creates a missing anchor: throws ENOENT and leaves nothing behind', () => {
    const anchor = path.join(tmp, 'gone')
    let err: unknown
    try {
      mkdirBelow(anchor, path.join(anchor, 'skills', 'x'))
    } catch (e) {
      err = e
    }
    expect(isAnchorGone(err)).toBe(true)
    expect(existsSync(anchor)).toBe(false)
  })

  it('treats an anchor replaced by a file as gone', () => {
    const anchor = path.join(tmp, 'file')
    writeFileSync(anchor, '')
    expect(() => mkdirBelow(anchor, path.join(anchor, 'x'))).toThrow()
  })

  it('refuses a dir outside the anchor', () => {
    const anchor = path.join(tmp, 'acct')
    mkdirSync(anchor)
    expect(() => mkdirBelow(anchor, path.join(tmp, 'elsewhere'))).toThrow(/not under/)
    expect(() => mkdirBelow(anchor, tmp)).toThrow(/not under/)
    expect(existsSync(path.join(tmp, 'elsewhere'))).toBe(false)
  })
})

describe('writeOwnedFile with an anchor', () => {
  it('writes below a live anchor', () => {
    const anchor = path.join(tmp, 'acct')
    mkdirSync(anchor)
    const file = path.join(anchor, 'skills', 's', 'SKILL.md')
    expect(writeOwnedFile(new ReceiptStore(() => path.join(tmp, 'receipts')), file, 'body\n', anchor)).toBe('written')
    expect(readFileSync(file, 'utf8')).toBe('body\n')
  })

  it("answers 'gone' for a vanished anchor, quietly, without recreating it", () => {
    const anchor = path.join(tmp, 'acct')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const out = writeOwnedFile(new ReceiptStore(() => path.join(tmp, 'receipts')), path.join(anchor, 'skills', 's', 'SKILL.md'), 'b', anchor)
      expect(out).toBe('gone')
      expect(existsSync(anchor)).toBe(false)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('without an anchor keeps mkdir -p (system dirs: an absent one is first use)', () => {
    const file = path.join(tmp, 'fresh', 'skills', 's', 'SKILL.md')
    expect(writeOwnedFile(new ReceiptStore(() => path.join(tmp, 'receipts')), file, 'b')).toBe('written')
  })
})

describe('installPiExtensionInto anchored', () => {
  it('does not recreate a vanished account dir', () => {
    const dir = path.join(tmp, 'pi-accounts', 'gone')
    expect(() => installPiExtensionInto(dir, { anchored: true })).toThrow()
    expect(existsSync(dir)).toBe(false)
  })

  it('installs into a live account dir', () => {
    const dir = path.join(tmp, 'pi-accounts', 'live')
    mkdirSync(dir, { recursive: true })
    installPiExtensionInto(dir, { anchored: true })
    expect(readFileSync(piExtensionPath(dir), 'utf8').startsWith(PI_EXTENSION_MARKER)).toBe(true)
  })
})

describe('isManagedPiAccountDir', () => {
  it('is exactly one level below <userData>/pi-accounts', () => {
    const ud = path.join(tmp, 'ud')
    expect(isManagedPiAccountDir(path.join(ud, 'pi-accounts', 'a1'), ud)).toBe(true)
    expect(isManagedPiAccountDir(path.join(ud, 'pi-accounts'), ud)).toBe(false)
    expect(isManagedPiAccountDir(path.join(ud, 'pi-accounts', 'a1', 'skills'), ud)).toBe(false)
    expect(isManagedPiAccountDir(path.join(ud, 'pi-accounts', '..', 'x'), ud)).toBe(false)
    expect(isManagedPiAccountDir(path.join(os.homedir(), '.pi', 'agent'), ud)).toBe(false)
  })
})

describe('a managed pi dir of the co-located PEER is anchored too', () => {
  afterEach(() => resetPlatformForTests())

  it('isAnyManagedPiAccountDir sees own and peer roots', () => {
    const own = path.join(tmp, 'own')
    const peer = path.join(tmp, 'peer')
    initPlatform(fakePlatform({ userDataDir: own, peerUserDataDir: peer } as any))
    expect(isAnyManagedPiAccountDir(path.join(peer, 'pi-accounts', 'a'), own)).toBe(true)
    expect(isAnyManagedPiAccountDir(path.join(own, 'pi-accounts', 'a'), own)).toBe(true)
    expect(isAnyManagedPiAccountDir(path.join(tmp, 'other', 'pi-accounts', 'a'), own)).toBe(false)
  })

  it('installPiHooks never recreates an inherited (peer) account dir, and is quiet about it', () => {
    const own = path.join(tmp, 'own')
    const peer = path.join(tmp, 'peer')
    initPlatform(fakePlatform({ userDataDir: own, peerUserDataDir: peer } as any))
    const gone = path.join(peer, 'pi-accounts', 'deleted')
    const prev = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = gone
    try {
      expect(() => installPiHooks()).not.toThrow()
      expect(existsSync(gone)).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = prev
    }
  })
})
