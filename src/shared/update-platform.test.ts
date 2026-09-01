import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  isManualUpdatePlatform,
  shouldEnableUpdater,
  toUpdateAvailablePayload
} from './update-platform'

describe('isManualUpdatePlatform', () => {
  it('linux with APPIMAGE set → auto (self-installs)', () => {
    expect(isManualUpdatePlatform('linux', true)).toBe(false)
  })

  it('linux without APPIMAGE → manual (.deb/.rpm)', () => {
    expect(isManualUpdatePlatform('linux', false)).toBe(true)
  })

  it('darwin → auto regardless of APPIMAGE', () => {
    expect(isManualUpdatePlatform('darwin', false)).toBe(false)
    expect(isManualUpdatePlatform('darwin', true)).toBe(false)
  })

  it('win32 → auto', () => {
    expect(isManualUpdatePlatform('win32', false)).toBe(false)
  })
})

describe('shouldEnableUpdater', () => {
  it('disables checks in development and in explicitly local packaged builds', () => {
    expect(shouldEnableUpdater(false, undefined)).toBe(false)
    expect(shouldEnableUpdater(true, 'disabled')).toBe(false)
  })

  it('keeps updater behavior unchanged for normal packaged releases', () => {
    expect(shouldEnableUpdater(true, undefined)).toBe(true)
    expect(shouldEnableUpdater(true, 'enabled')).toBe(true)
  })
})

/**
 * `shouldEnableUpdater` is only half the fix — it reads a marker the BUILD has to set. A `dist*`
 * script that forgets it produces a package indistinguishable from a release (`app.isPackaged` is
 * true for both), which then polls the production feed for a version nobody published and logs a
 * 404 on `latest*.yml` every six hours. That is a build-config mistake no unit test of the pure
 * function can catch, so assert it against the real package.json — the same guard-test shape as
 * `src/core/no-electron.test.ts`.
 */
describe('local dist scripts opt out of the production update feed', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')
  ) as { scripts: Record<string, string> }
  const MARKER = '-c.extraMetadata.nodeTermUpdates=disabled'

  it('every dist script carries the marker — not just the one whose 404 was noticed', () => {
    const dist = Object.keys(pkg.scripts).filter((s) => s === 'dist' || s.startsWith('dist:'))
    expect(dist.length).toBeGreaterThanOrEqual(2) // dist, dist:linux
    expect(dist.filter((s) => !pkg.scripts[s].includes(MARKER))).toEqual([])
  })

  // Fork contract (Termscape): upstream asserts the INVERSE here — its promoted `release` build
  // must keep updating itself from nodeterm.dev/updates. This fork has no update feed of its own
  // and must never poll upstream's (a promoted Termscape would otherwise offer to "update" itself
  // into vanilla nodeterm), so every packaged build carries the marker, `release` included, and
  // package.json sets `publish` to an explicit null (see the next test for why null, not absent).
  // If an upstream merge flips this back, the fork is wrong.
  it('release carries it too — this fork has no update feed, upstream or its own', () => {
    expect(pkg.scripts.release).toContain(MARKER)
  })

  it('package.json points at no update feed at all — an EXPLICIT null, not an absent key', () => {
    // Absent is not enough: with no `publish` electron-builder infers a GitHub provider from the git
    // remote and still writes app-update.yml (measured 2026-09-02: owner/repo of this fork). `null`
    // is the documented way to tell it not to. The updater is stamped off regardless, so this is
    // about shipping no feed pointer at all, not about behaviour.
    const build = (pkg as { build?: { publish?: unknown } }).build
    expect(build).toBeDefined()
    expect('publish' in (build as object)).toBe(true)
    expect(build?.publish).toBeNull()
  })
})

describe('toUpdateAvailablePayload', () => {
  it('carries version + string release notes + manual flag', () => {
    expect(toUpdateAvailablePayload({ version: '1.2.0', releaseNotes: 'fixes' }, true)).toEqual({
      version: '1.2.0',
      notes: 'fixes',
      manual: true
    })
  })

  it('coerces non-string / missing release notes to empty string', () => {
    expect(toUpdateAvailablePayload({ version: '1.2.0' }, false)).toEqual({
      version: '1.2.0',
      notes: '',
      manual: false
    })
    expect(
      toUpdateAvailablePayload({ version: '1.2.0', releaseNotes: [{ note: 'x' }] }, false).notes
    ).toBe('')
  })
})
