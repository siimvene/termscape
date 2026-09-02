import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { IPC } from '../shared/ipc'
import type { LicenseDetail, LicenseStatus } from '../shared/types'

/**
 * SELF-HOST UNGATE (fork) — the build-time opt-in in `license.ts` that neutralizes the Pro gate.
 *
 * `license.test.ts` is upstream's file, verbatim: it asserts the GATED default (no entitlement →
 * not premium, 0 seats; foreign device / expiry / clock rollback all refuse). This file is the
 * fork's half. The first describe pins that the flag really is off by default; the rest opts in
 * with `TERMSCAPE_UNGATE=1` and is the inventory of exactly which upstream contracts the ungate
 * inverts — one case per token shape, so an upstream change to `seatsFrom`/`verify` has a test per
 * assertion to reconcile. What each case still asserts honestly is that the license CLIENT is
 * intact: the token is fetched, stored verbatim, dropped when the server revokes it, the
 * clock-rollback anchor still advances, and the token-authorized routes still refuse without one.
 *
 * Why the flag reads the live env here: vitest does not bundle, so the `define` in
 * electron.vite.config.ts / scripts/build-server.mjs never runs and `process.env.TERMSCAPE_UNGATE` is
 * evaluated at module load. Hence `vi.resetModules()` + dynamic import after setting the env.
 */

const h = vi.hoisted(() => ({
  userData: '',
  publicKeyPem: ''
}))

vi.mock('./entitlement-key', () => ({
  get ENTITLEMENT_PUBLIC_KEY() {
    return h.publicKeyPem
  }
}))

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
h.publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

/** Mirrors the un-exported SELF_HOST_SEATS in license.ts. */
const SELF_HOST_SEATS = 999
const HOUR = 60 * 60 * 1000

function mint(ttlSeconds: number, deviceId = 'test-device', seats?: number): string {
  const payload = Buffer.from(
    JSON.stringify({
      deviceId,
      tier: 'pro',
      licenseId: 'lic_test',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
      ...(seats !== undefined ? { seats } : {})
    })
  ).toString('base64url')
  const sig = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64url')
  return `${payload}.${sig}`
}

function jsonResponse(body: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => body }
}

async function refreshed(): Promise<void> {
  const { __licenseRefreshesForTests } = await import('./license')
  await __licenseRefreshesForTests()
}

let fetchMock: ReturnType<typeof vi.fn>
let fake: import('./platform-fake').FakePlatform
const savedFlag = process.env.TERMSCAPE_UNGATE

async function setUp(flag: '1' | undefined, fetchImpl: ReturnType<typeof vi.fn>): Promise<void> {
  vi.useFakeTimers({ toFake: ['setInterval', 'Date'] })
  h.userData = mkdtempSync(path.join(tmpdir(), 'nt-license-ungate-'))
  writeFileSync(path.join(h.userData, 'device-id'), 'test-device')
  delete process.env.DO_NOT_TRACK
  delete process.env.NODETERM_TELEMETRY_DISABLED
  process.env.NODETERM_API_BASE = 'http://127.0.0.1:1'
  if (flag === undefined) delete process.env.TERMSCAPE_UNGATE
  else process.env.TERMSCAPE_UNGATE = flag
  fetchMock = fetchImpl
  vi.stubGlobal('fetch', fetchMock)
  vi.resetModules()
  const { initPlatform } = await import('./platform')
  const { fakePlatform } = await import('./platform-fake')
  fake = fakePlatform({ userDataDir: h.userData, isPackaged: false })
  initPlatform(fake)
}

async function tearDown(): Promise<void> {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  if (savedFlag === undefined) delete process.env.TERMSCAPE_UNGATE
  else process.env.TERMSCAPE_UNGATE = savedFlag
  const { resetPlatformForTests } = await import('./platform')
  resetPlatformForTests()
  rmSync(h.userData, { recursive: true, force: true })
}

const sent = (): LicenseStatus[] =>
  fake.sent.filter((s) => s.channel === IPC.licenseChanged).map((s) => s.args[0] as LicenseStatus)

function storeToken(token?: string): void {
  writeFileSync(path.join(h.userData, 'license.json'), JSON.stringify({ token }))
}

describe('SELF-HOST UNGATE is off by default', () => {
  beforeEach(() => setUp(undefined, vi.fn().mockRejectedValue(new Error('offline'))))
  afterEach(tearDown)

  it('an unset flag builds the upstream gate: no token → not premium, 0 seats, inactive status', async () => {
    storeToken(undefined)
    const { SELF_HOST_UNGATE, initLicense, isPremium, licensedSeats } = await import('./license')
    expect(SELF_HOST_UNGATE).toBe(false)
    initLicense()
    await refreshed()
    expect(isPremium()).toBe(false)
    expect(licensedSeats()).toBe(0)
    const status = (await fake.handlers[IPC.licenseStatus]()) as LicenseStatus
    expect(status.active).toBe(false)
    expect(status.seats).toBe(0)
  })

  it('only the exact value "1" opts in — "true", "yes" and "0" all stay gated', async () => {
    for (const v of ['true', 'yes', '0', '']) {
      process.env.TERMSCAPE_UNGATE = v
      vi.resetModules()
      const { SELF_HOST_UNGATE } = await import('./license')
      expect(SELF_HOST_UNGATE, `TERMSCAPE_UNGATE=${JSON.stringify(v)}`).toBe(false)
    }
  })
})

describe('SELF-HOST UNGATE=1: entitlement refresh keeps the client honest while Pro stays on', () => {
  beforeEach(() => setUp('1', vi.fn()))
  afterEach(tearDown)

  it('exports the flag as on', async () => {
    const { SELF_HOST_UNGATE, isPremium } = await import('./license')
    expect(SELF_HOST_UNGATE).toBe(true)
    expect(isPremium()).toBe(true)
  })

  it('a periodic refresh that finds the device revoked still clears the cached token (Pro stays on)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ active: true, token: mint(7 * 24 * 60 * 60) }))
    const { initLicense, getStoredEntitlement } = await import('./license')
    initLicense()
    await refreshed()
    expect(getStoredEntitlement()).not.toBeNull()

    fetchMock.mockResolvedValue(jsonResponse({ active: false }))
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    await refreshed()

    // The honest half is intact: a server that answers "not entitled" still drops the stored
    // token, so nothing later proves a revoked entitlement to the API.
    expect(getStoredEntitlement()).toBeNull()
    // Upstream broadcast active:false here. statusFrom() never reads the token under the flag.
    expect(sent().at(-1)!.active).toBe(true)
    expect(sent().at(-1)!.tier).toBe('pro')
  })

  it('stores a token minted for a different device verbatim (verify() no longer gates)', async () => {
    const foreign = mint(7 * 24 * 60 * 60, 'other-device')
    fetchMock.mockResolvedValue(jsonResponse({ active: true, token: foreign }))
    const { initLicense, getStoredEntitlement } = await import('./license')
    initLicense()
    await refreshed()

    // Upstream: verify() caught the deviceId mismatch → active:false. Under the flag the device
    // binding is inert and the token is kept exactly as the server sent it.
    expect(getStoredEntitlement()).toBe(foreign)
    expect(sent().length).toBeGreaterThan(0)
    expect(sent().at(-1)!.active).toBe(true)
  })

  it('advances the clock-rollback anchor and never walks it back (expiry is inert)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ active: true, token: mint(7 * 24 * 60 * 60) }))
    const { initLicense } = await import('./license')
    initLicense()
    await refreshed()

    // Later refreshes fail (offline) so the stored token is what the status reads.
    fetchMock.mockRejectedValue(new Error('offline'))
    await vi.advanceTimersByTimeAsync(7 * 24 * HOUR + 12 * HOUR)
    await refreshed()

    const anchor = (): number | undefined =>
      (
        JSON.parse(readFileSync(path.join(h.userData, 'license.json'), 'utf-8')) as {
          lastSeen?: number
        }
      ).lastSeen
    // bumpLastSeen is untouched by the ungate and still records the largest time observed.
    expect(anchor()).toBe(Math.floor(Date.now() / 1000))
    const observed = anchor()

    // Attacker rolls the clock back before the expiry. Upstream this mattered: verify() anchored
    // expiry to `lastSeen`, so the expired token stayed dead. Under the flag statusFrom() reports
    // Pro whatever the clock says — the anchor is kept honest, it just gates nothing.
    vi.setSystemTime(Date.now() - 9 * 24 * HOUR)
    const status = (await fake.handlers[IPC.licenseStatus]()) as LicenseStatus
    expect(status.active).toBe(true)
    expect(anchor()).toBe(observed) // a status read never walks the anchor backwards
  })
})

describe('SELF-HOST UNGATE=1: seats — the token is stored, never resolved', () => {
  // Reject any refresh call → offline grace keeps the stored token intact for the assertions.
  beforeEach(() => setUp('1', vi.fn().mockRejectedValue(new Error('offline'))))
  afterEach(tearDown)

  it('a token carrying seats:5 does not cap the self-host seat count (upstream: 5)', async () => {
    const token = mint(7 * 24 * 60 * 60, 'test-device', 5)
    storeToken(token)
    const { initLicense, licensedSeats, getStoredEntitlement } = await import('./license')
    initLicense()
    await refreshed()
    const status = (await fake.handlers[IPC.licenseStatus]()) as LicenseStatus
    expect(status.active).toBe(true)
    expect(status.seats).toBe(SELF_HOST_SEATS)
    expect(licensedSeats()).toBe(SELF_HOST_SEATS)
    expect(getStoredEntitlement()).toBe(token)
  })

  it('a token with no seats field is not resolved to the free baseline (upstream: 3)', async () => {
    storeToken(mint(7 * 24 * 60 * 60))
    const { initLicense, licensedSeats, PRO_FREE_SEATS } = await import('./license')
    initLicense()
    await refreshed()
    const status = (await fake.handlers[IPC.licenseStatus]()) as LicenseStatus
    expect(status.active).toBe(true)
    // The baseline constant is left intact and exported: with the flag off, `seatsFrom` uses it.
    expect(PRO_FREE_SEATS).toBe(3)
    expect(status.seats).toBe(SELF_HOST_SEATS)
    expect(licensedSeats()).toBe(SELF_HOST_SEATS)
  })

  it('a token below the free baseline is not floored to 3 either (upstream: 3)', async () => {
    storeToken(mint(7 * 24 * 60 * 60, 'test-device', 2))
    const { initLicense, licensedSeats } = await import('./license')
    initLicense()
    await refreshed()
    const status = (await fake.handlers[IPC.licenseStatus]()) as LicenseStatus
    expect(status.seats).toBe(SELF_HOST_SEATS)
    expect(licensedSeats()).toBe(SELF_HOST_SEATS)
  })

  it('an absent token still reports Pro, while the token-authorized routes refuse (upstream: 0 seats)', async () => {
    storeToken(undefined)
    const { initLicense, licensedSeats, getStoredEntitlement } = await import('./license')
    initLicense()
    await refreshed()
    const status = (await fake.handlers[IPC.licenseStatus]()) as LicenseStatus
    expect(status.active).toBe(true)
    expect(status.seats).toBe(SELF_HOST_SEATS)
    expect(licensedSeats()).toBe(SELF_HOST_SEATS)
    // The client half is unchanged and still honest about having no credential: nothing is
    // stored, and the routes the entitlement authorizes refuse rather than inventing a license.
    expect(getStoredEntitlement()).toBeNull()
    expect(((await fake.handlers[IPC.licenseDetail]()) as LicenseDetail).error).toBe('unauthorized')
  })

  it('an expired token still reports Pro (upstream: not premium, 0 seats)', async () => {
    const token = mint(-60, 'test-device', 5)
    storeToken(token)
    const { initLicense, licensedSeats, getStoredEntitlement } = await import('./license')
    initLicense()
    await refreshed()
    const status = (await fake.handlers[IPC.licenseStatus]()) as LicenseStatus
    expect(status.active).toBe(true)
    expect(status.seats).toBe(SELF_HOST_SEATS)
    expect(licensedSeats()).toBe(SELF_HOST_SEATS)
    // Storage is untouched by the ungate: an expired token is kept, not silently discarded.
    expect(getStoredEntitlement()).toBe(token)
  })
})
