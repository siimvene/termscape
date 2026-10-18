// Fork (Termscape): `mkdirBelow` and the anchored `writeOwnedFile` — writes into a managed account dir
// must never recreate the account dir itself (see `mkdirBelow` in integration-files.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { ReceiptStore, isAnchorGone, mkdirBelow, writeOwnedFile } from './integration-files'
import { installPiExtensionInto, piExtensionPath, PI_EXTENSION_MARKER } from './agents/hooks/pi'

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
