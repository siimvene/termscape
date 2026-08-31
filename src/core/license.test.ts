import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { promises as fsp } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { IPC } from '../shared/ipc'
import type { LicenseDetail, LicenseStatus } from '../shared/types'

// One temp userData dir per run; hoisted so the entitlement-key mock factory can see it.
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

/** Mint a token the same way the server does: base64url(payload).base64url(sig).
 * `seats` is included only when provided, so an old token (no seats field) can be simulated. */
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

const HOUR = 60 * 60 * 1000

/**
 * SELF-HOST UNGATE (fork) — the seat cap `statusFrom`/`licensedSeats` report unconditionally.
 * Mirrors the un-exported SELF_HOST_SEATS in license.ts; kept local so a future upstream merge
 * sees a test-side constant to delete rather than a bare magic number.
 */
const SELF_HOST_SEATS = 999

/**
 * Await the refresh initLicense() actually started (launch + anything the 6h interval fired),
 * via the handle license.ts parks it on. This used to be a bounded `flush()` of timed sleeps, and
 * a loaded CI runner beat it: the assertions saw zero broadcasts, and the continuation then landed
 * after afterEach's resetPlatformForTests() and threw with nobody awaiting. There is no timing
 * guess left here — the refresh is awaited, so it is also guaranteed done before teardown.
 * Resolves against the post-resetModules instance the test itself imported.
 */
async function refreshed(): Promise<void> {
  const { __licenseRefreshesForTests } = await import('./license')
  await __licenseRefreshesForTests()
}

/**
 * SELF-HOST UNGATE (fork) is the contract under test in this describe wherever a test names it.
 * `statusFrom()` returns Pro/active unconditionally here (commit "Ungate Pro features for
 * self-hosting"), so nothing the entitlement token says can turn premium off: expiry, a foreign
 * deviceId and a clock rollback are all inert, and `verify()` is unreachable from the public
 * surface. What is still honest — and what these tests therefore assert — is the CLIENT half:
 * the token is fetched, stored, dropped when the server revokes it, and the clock-rollback anchor
 * is still advanced monotonically. A future upstream merge that restores gating should expect the
 * named tests below to flip back to their upstream assertions (active:false), not to be deleted.
 */
describe('license entitlement refresh', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let fake: import('./platform-fake').FakePlatform

  // The licenseChanged statuses broadcast so far (fake.sent records {to, channel, args}).
  const sent = (): LicenseStatus[] =>
    fake.sent.filter((s) => s.channel === IPC.licenseChanged).map((s) => s.args[0] as LicenseStatus)

  beforeEach(async () => {
    // Only the refresh interval and the clock are faked: fetch/fs promises and the
    // 8s abort timers stay on the real event loop so awaits actually settle.
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] })
    h.userData = mkdtempSync(path.join(tmpdir(), 'nt-license-test-'))
    // Pin this "machine"'s device id so minted tokens match it (device-bound verification).
    writeFileSync(path.join(h.userData, 'device-id'), 'test-device')
    delete process.env.DO_NOT_TRACK
    delete process.env.NODETERM_TELEMETRY_DISABLED
    process.env.NODETERM_API_BASE = 'http://127.0.0.1:1'
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.resetModules()
    // device-id (imported transitively by license) reads userData through the core platform,
    // so point the fake at this run's temp dir. Init on the post-reset module graph the
    // dynamic `import('./license')` below will resolve against.
    const { initPlatform } = await import('./platform')
    const { fakePlatform } = await import('./platform-fake')
    fake = fakePlatform({ userDataDir: h.userData, isPackaged: false })
    initPlatform(fake)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    const { resetPlatformForTests } = await import('./platform')
    resetPlatformForTests()
    rmSync(h.userData, { recursive: true, force: true })
  })

  it('launch refresh (device-bound) stores the minted token and broadcasts Pro', async () => {
    const token = mint(7 * 24 * 60 * 60)
    fetchMock.mockResolvedValue(jsonResponse({ active: true, token }))
    const { initLicense } = await import('./license')
    initLicense()
    await refreshed()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sent().length).toBe(1)
    expect(sent()[0].active).toBe(true)
    expect(sent()[0].tier).toBe('pro')
  })

  it('keeps refreshing periodically so a mid-session token expiry re-mints instead of dropping Pro', async () => {
    // Server hands out short-lived tokens (7d in prod); simulate one that expires
    // within the session, then a re-mint on the next poll.
    fetchMock.mockImplementation(async () =>
      jsonResponse({ active: true, token: mint(7 * 24 * 60 * 60) })
    )
    const { initLicense } = await import('./license')
    initLicense()
    await refreshed()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // A day passes in-session: the app must have polled again on its own —
    // launch-only refresh means the token silently expires after 7 days.
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    await refreshed()
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    const last = sent().at(-1)!
    expect(last.active).toBe(true)
  })

  it('a periodic refresh that finds the device revoked still clears the cached token (SELF-HOST UNGATE: Pro stays on)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ active: true, token: mint(7 * 24 * 60 * 60) })
    )
    const { initLicense, getStoredEntitlement } = await import('./license')
    initLicense()
    await refreshed()
    expect(getStoredEntitlement()).not.toBeNull()

    // From now on the server says: not entitled (canceled subscription).
    fetchMock.mockResolvedValue(jsonResponse({ active: false }))
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    await refreshed()

    // The honest half is intact: a server that answers "not entitled" still drops the stored
    // token, so nothing later proves a revoked entitlement to the API.
    expect(getStoredEntitlement()).toBeNull()
    // SELF-HOST UNGATE: upstream broadcast active:false here. This fork's statusFrom() never
    // reads the token, so premium does NOT drop mid-session.
    expect(sent().at(-1)!.active).toBe(true)
    expect(sent().at(-1)!.tier).toBe('pro')
  })

  it('stores a token minted for a different device verbatim (SELF-HOST UNGATE: verify() no longer gates)', async () => {
    // Simulates copying license.json + a foreign token onto this machine.
    const foreign = mint(7 * 24 * 60 * 60, 'other-device')
    fetchMock.mockResolvedValue(jsonResponse({ active: true, token: foreign }))
    const { initLicense, getStoredEntitlement } = await import('./license')
    initLicense()
    await refreshed()

    // Upstream: verify() caught the deviceId mismatch, so a copied license.json broadcast
    // active:false. Here statusFrom() never consults verify() at all — the device binding is
    // inert and the token is kept exactly as the server sent it.
    expect(getStoredEntitlement()).toBe(foreign)
    expect(sent().length).toBeGreaterThan(0)
    expect(sent().at(-1)!.active).toBe(true)
  })

  it('broadcasts even when the refresh lands long after a bounded flush would have given up', async () => {
    // Regression for a CI flake that reddened unrelated PRs. initLicense() starts refresh()
    // UN-AWAITED; the assertions above used to race it with ~75 ms of timed sleeps, and a loaded
    // runner won: `sent()` was still empty (`expected 0 to be greater than 0`) and the
    // continuation then landed after afterEach had run resetPlatformForTests(), so broadcast() →
    // platform() threw with nobody awaiting — an unhandled rejection, which fails the whole file.
    // Here the response deliberately lands 300 ms in, i.e. past ANY flush budget, so the ordering
    // the flake needs is forced rather than hoped for. Passing means the assertion is awaiting the
    // real refresh, not a timeout.
    fetchMock.mockImplementation(
      async () =>
        await new Promise((r) =>
          setTimeout(() => r(jsonResponse({ active: true, token: mint(7 * 24 * 60 * 60) })), 300)
        )
    )
    const { initLicense } = await import('./license')
    initLicense()
    await refreshed()

    expect(sent().length).toBe(1)
    expect(sent()[0].active).toBe(true)
  })

  it('advances the clock-rollback anchor and never walks it back (SELF-HOST UNGATE: expiry is inert)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ active: true, token: mint(7 * 24 * 60 * 60) })
    )
    const { initLicense } = await import('./license')
    initLicense()
    await refreshed()
    expect(sent().at(-1)!.active).toBe(true)

    // Server unreachable from now on (offline grace path), and the token expires in-session.
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
    // expiry to `lastSeen`, so the expired token stayed dead. SELF-HOST UNGATE: statusFrom()
    // reports Pro whatever the clock says — the anchor is kept honest, it just gates nothing.
    vi.setSystemTime(Date.now() - 9 * 24 * HOUR)
    const status = (await fake.handlers[IPC.licenseStatus]()) as LicenseStatus
    expect(status.active).toBe(true)
    expect(anchor()).toBe(observed) // a status read never walks the anchor backwards
  })

  it('a slow early write cannot walk the clock anchor backwards past a later one', async () => {
    // Regression for the SECOND flake in this file (it made the rollback test above fail ~4 runs
    // in 15 on a loaded box). bumpLastSeen is a read-modify-write of license.json, and the refresh
    // runs used to be started independently, so a burst of them — which is what advancing days of
    // fake time produces — could have an OLDER lastSeen write complete LAST and walk the anchor
    // backwards. That is precisely what the anchor exists to prevent.
    //
    // Forced deterministically here: the first two writes of the periodic burst take 200 ms while
    // every later one is immediate. Runs that overlap therefore ALWAYS finish out of order (an
    // early, small lastSeen lands last); runs that are queued cannot overlap at all, so the delay
    // only slows the chain down and the newest value still lands last.
    let slowWrites = 0
    const realWrite = fsp.writeFile.bind(fsp)
    const writeSpy = vi
      .spyOn(fsp, 'writeFile')
      .mockImplementation(async (...args: Parameters<typeof fsp.writeFile>) => {
        if (slowWrites > 0) {
          slowWrites--
          await new Promise((r) => setTimeout(r, 200))
        }
        return realWrite(...args)
      })
    try {
      fetchMock.mockResolvedValueOnce(jsonResponse({ active: true, token: mint(7 * 24 * 60 * 60) }))
      const { initLicense } = await import('./license')
      initLicense()
      await refreshed()

      fetchMock.mockRejectedValue(new Error('offline'))
      slowWrites = 2 // …i.e. the first two of the burst below, nothing the launch refresh wrote
      await vi.advanceTimersByTimeAsync(7 * 24 * HOUR + 12 * HOUR)
      await refreshed()

      // The anchor must hold the LARGEST time observed, whatever order the writes completed in.
      const stored = JSON.parse(readFileSync(path.join(h.userData, 'license.json'), 'utf-8')) as {
        lastSeen?: number
      }
      expect(stored.lastSeen).toBe(Math.floor(Date.now() / 1000))

      // SELF-HOST UNGATE: the anchor above is the whole point of this regression — the status
      // read below only pins that the ungate reports Pro regardless (upstream: active false).
      vi.setSystemTime(Date.now() - 9 * 24 * HOUR)
      const status = (await fake.handlers[IPC.licenseStatus]()) as LicenseStatus
      expect(status.active).toBe(true)
    } finally {
      writeSpy.mockRestore()
    }
  })
})

/**
 * SELF-HOST UNGATE (fork) is the contract under test for every seat case below. Upstream resolved
 * the cap from the verified token (`seatsFrom`: premium → max(PRO_FREE_SEATS, its seats), else 0);
 * this fork's `statusFrom`/`licensedSeats` return SELF_HOST_SEATS unconditionally, so the token's
 * `seats` field, its expiry and its very presence are all inert. The cases are kept one-per-token-
 * shape on purpose: they are the inventory of exactly which upstream seat contracts diverge, so an
 * upstream merge that restores `seatsFrom` has a test per assertion to flip back. What each case
 * still asserts honestly is that the license CLIENT is intact — the token is stored verbatim and
 * the token-authorized routes still refuse without one.
 */
describe('license seats entitlement', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let fake: import('./platform-fake').FakePlatform

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] })
    h.userData = mkdtempSync(path.join(tmpdir(), 'nt-license-seats-'))
    writeFileSync(path.join(h.userData, 'device-id'), 'test-device')
    delete process.env.DO_NOT_TRACK
    delete process.env.NODETERM_TELEMETRY_DISABLED
    process.env.NODETERM_API_BASE = 'http://127.0.0.1:1'
    // Reject any refresh call → offline grace keeps the stored token intact for the assertions.
    fetchMock = vi.fn().mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)
    vi.resetModules()
    const { initPlatform } = await import('./platform')
    const { fakePlatform } = await import('./platform-fake')
    fake = fakePlatform({ userDataDir: h.userData, isPackaged: false })
    initPlatform(fake)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    const { resetPlatformForTests } = await import('./platform')
    resetPlatformForTests()
    rmSync(h.userData, { recursive: true, force: true })
  })

  function storeToken(token?: string): void {
    writeFileSync(path.join(h.userData, 'license.json'), JSON.stringify({ token }))
  }

  it('a token carrying seats:5 does not cap the self-host seat count (upstream: 5)', async () => {
    const token = mint(7 * 24 * 60 * 60, 'test-device', 5)
    storeToken(token)
    const { initLicense, licensedSeats, getStoredEntitlement } = await import('./license')
    initLicense()
    await refreshed()
    const status = (await fake.handlers[IPC.licenseStatus]()) as LicenseStatus
    expect(status.active).toBe(true)
    // SELF-HOST UNGATE: the token's bought-up cap is ignored — a self-hosted relay host is
    // never bound by it. The token itself is still stored, unread.
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
    // SELF-HOST UNGATE: upstream resolved a seats-less token to the 3 seats every Pro plan
    // includes. The baseline constant is deliberately left intact and exported, so restoring
    // `seatsFrom` upstream-side needs no seat math rewritten — it just stops being consulted.
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
    // SELF-HOST UNGATE: no flooring happens because no resolution happens — the misconfigured
    // low value is never read at all.
    expect(status.seats).toBe(SELF_HOST_SEATS)
    expect(licensedSeats()).toBe(SELF_HOST_SEATS)
  })

  it('an absent token still reports Pro, while the token-authorized routes refuse (upstream: 0 seats)', async () => {
    storeToken(undefined)
    const { initLicense, licensedSeats, getStoredEntitlement } = await import('./license')
    initLicense()
    await refreshed()
    const status = (await fake.handlers[IPC.licenseStatus]()) as LicenseStatus
    // SELF-HOST UNGATE: upstream reported active:false / 0 seats with nothing stored.
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
    // SELF-HOST UNGATE: expiry is inert. `verify()` — signature, device binding and the
    // lastSeen-anchored expiry check — is unreachable from the public surface in this fork.
    expect(status.active).toBe(true)
    expect(status.seats).toBe(SELF_HOST_SEATS)
    expect(licensedSeats()).toBe(SELF_HOST_SEATS)
    // Storage is untouched by the ungate: an expired token is kept, not silently discarded.
    expect(getStoredEntitlement()).toBe(token)
  })

  it('upgrade opens the base Pro link by default and the add-seats link for target "seats"', async () => {
    process.env.NODETERM_CHECKOUT_URL = 'https://pay.test/pro'
    process.env.NODETERM_SEATS_CHECKOUT_URL = 'https://pay.test/seats'
    try {
      const { initLicense } = await import('./license')
      initLicense()
      await refreshed() // the launch refresh (rejecting → offline grace) is awaited, never raced
      await fake.handlers[IPC.licenseUpgrade]() // default → base Pro
      await fake.handlers[IPC.licenseUpgrade]('seats') // add-seats link
      // Each carries this device's id for the device-bound webhook binding.
      expect(fake.opened).toEqual([
        'https://pay.test/pro?client_reference_id=test-device',
        'https://pay.test/seats?client_reference_id=test-device'
      ])
    } finally {
      delete process.env.NODETERM_CHECKOUT_URL
      delete process.env.NODETERM_SEATS_CHECKOUT_URL
    }
  })

  it('the add-seats link uses its own built-in URL when the env override is unset', async () => {
    process.env.NODETERM_CHECKOUT_URL = 'https://pay.test/pro'
    delete process.env.NODETERM_SEATS_CHECKOUT_URL
    try {
      const { initLicense } = await import('./license')
      initLicense()
      await refreshed() // the launch refresh (rejecting → offline grace) is awaited, never raced
      await fake.handlers[IPC.licenseUpgrade]('seats')
      // 'seats' opens the dedicated seats Payment Link — NOT the base Pro link — with the deviceId.
      const opened = fake.opened[0]
      expect(opened).not.toContain('pay.test/pro')
      expect(opened).toContain('buy.stripe.com/')
      expect(opened).toContain('client_reference_id=test-device')
    } finally {
      delete process.env.NODETERM_CHECKOUT_URL
    }
  })
})

describe('license detail + release', () => {
  let fake: import('./platform-fake').FakePlatform

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] })
    h.userData = mkdtempSync(path.join(tmpdir(), 'nt-license-detail-'))
    writeFileSync(path.join(h.userData, 'device-id'), 'test-device')
    delete process.env.DO_NOT_TRACK
    delete process.env.NODETERM_TELEMETRY_DISABLED
    process.env.NODETERM_API_BASE = 'http://127.0.0.1:1'
    // The launch refresh must not succeed here: rejecting it keeps the stored token intact
    // (offline grace) so every assertion below runs against the token the test wrote.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    vi.resetModules()
    const { initPlatform } = await import('./platform')
    const { fakePlatform } = await import('./platform-fake')
    fake = fakePlatform({ userDataDir: h.userData, isPackaged: false })
    initPlatform(fake)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    const { resetPlatformForTests } = await import('./platform')
    resetPlatformForTests()
    delete process.env.DO_NOT_TRACK
    rmSync(h.userData, { recursive: true, force: true })
  })

  const TOKEN = mint(HOUR / 1000)

  function storeToken(token = TOKEN): void {
    writeFileSync(path.join(h.userData, 'license.json'), JSON.stringify({ token }))
  }

  /** Non-2xx reply shaped like our API's error bodies. */
  function errorResponse(status: number, body: unknown): {
    ok: boolean
    status: number
    json: () => Promise<unknown>
  } {
    return { ok: false, status, json: async () => body }
  }

  /**
   * Boot the service, let its launch refresh SETTLE, and only then install the fetch mock the
   * assertions are about. initLicense() fires an un-awaited refresh; installing the mock first
   * would make `mock.calls[0]` that refresh — so a handler that never called fetch at all could
   * still satisfy a "the request carried X" assertion.
   */
  async function boot(fetchMock: ReturnType<typeof vi.fn>): Promise<void> {
    const { initLicense } = await import('./license')
    initLicense()
    await refreshed()
    vi.stubGlobal('fetch', fetchMock)
  }

  const detail = (): Promise<LicenseDetail> =>
    fake.handlers[IPC.licenseDetail]() as Promise<LicenseDetail>
  const release = (): Promise<LicenseDetail> =>
    fake.handlers[IPC.licenseRelease]() as Promise<LicenseDetail>

  it('sends the stored entitlement token, never a deviceId', async () => {
    storeToken()
    const fetchMock = vi.fn(async (_url: string, _init: { method: string; body: string }) =>
      jsonResponse({ key: 'KEY-ABC', used: 2, seats: 3, source: 'keygen' })
    )
    await boot(fetchMock)

    expect(await detail()).toEqual({
      key: 'KEY-ABC',
      used: 2,
      seats: 3,
      source: 'keygen',
      error: null
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/v1/license/detail')
    // A key works on ANY machine, so the request that reveals one is authorized by the signed
    // entitlement and by nothing else. deviceId rides query strings, telemetry and relay pairing.
    expect(String(url)).not.toContain(TOKEN)
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body) as Record<string, unknown>
    expect(body.entitlement).toBe(TOKEN) // the stored token itself, not merely "something truthy"
    expect(Object.keys(body)).toEqual(['entitlement']) // …and nothing else travels with it
  })

  it('release posts to its own route, not to detail', async () => {
    storeToken()
    const fetchMock = vi.fn(async (_url: string, _init: { body: string }) =>
      jsonResponse({ used: 1, seats: 3 })
    )
    await boot(fetchMock)

    const r = await release()
    expect(r.error).toBeNull()
    expect(r.used).toBe(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/v1/license/release')
    expect(String(url)).not.toContain('/v1/license/detail')
    expect((JSON.parse(init.body) as { entitlement: string }).entitlement).toBe(TOKEN)
  })

  it('carries the source, so a non-keygen entitlement is not read as a failed count', async () => {
    // An App Store purchase on a paired phone bridges Pro to the desktop as `apple:<txn>`. The
    // server makes zero keygen calls for it and answers 200 with no key and no machines — those
    // zeros mean "device counting does not apply here", NOT "the read failed". `source` is the
    // only thing that tells the two apart, and the UI hides the release action on it.
    //
    // This is also the fixture that stops the malformed-2xx guard below from OVER-firing: these
    // zeros are stated numbers, so they must still read as a success.
    storeToken()
    await boot(vi.fn(async () => jsonResponse({ key: null, used: 0, seats: 0, source: 'apple' })))

    expect(await detail()).toEqual({
      key: null,
      used: 0,
      seats: 0,
      source: 'apple',
      error: null
    })
  })

  it('a 200 with key null is a success, not the 402 inactive story', async () => {
    // A keygen policy may hide keys, and licenses predating the `key` column have none stored.
    // Reporting that as a failure would tell a paying subscriber their license is inactive.
    storeToken()
    await boot(vi.fn(async () => jsonResponse({ key: null, used: 2, seats: 3, source: 'keygen' })))

    expect(await detail()).toEqual({ key: null, used: 2, seats: 3, source: 'keygen', error: null })
  })

  it('402 inactive is an error with no source claimed', async () => {
    storeToken()
    await boot(vi.fn(async () => errorResponse(402, { error: 'inactive' })))

    expect(await detail()).toEqual({
      key: null,
      used: 0,
      seats: 0,
      source: null,
      error: 'inactive'
    })
  })

  it('401 unauthorized keeps the server-stated reason instead of a generic network error', async () => {
    storeToken()
    await boot(vi.fn(async () => errorResponse(401, { error: 'unauthorized' })))
    expect((await detail()).error).toBe('unauthorized')
  })

  it('times out a response whose BODY never arrives, instead of hanging the handler forever', async () => {
    // The 8s abort has to cover the body, not just the headers. A captive portal or a proxy that
    // holds the connection open answers 200 and then stalls; with the timer cleared as soon as the
    // headers land, this handler never settles — and the renderer's Release button sits on
    // "Releasing…" for the rest of the session, with no failure to report and no way back.
    storeToken()
    // Captured while setTimeout is still real (this describe fakes only setInterval + Date), so
    // the guard below can fail FAST if the handler hangs rather than idling until vitest's own
    // test timeout.
    const realSetTimeout = globalThis.setTimeout
    let aborted = false
    await boot(
      vi.fn(async (_url: string, init: { signal: AbortSignal }) => ({
        ok: true,
        status: 200,
        // A real fetch body rejects when the request is aborted; before that it just never settles.
        json: () =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              aborted = true
              reject(new Error('The operation was aborted'))
            })
          })
      }))
    )

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'Date'] })
    const pending = release()
    await vi.advanceTimersByTimeAsync(8000)
    const guard = new Promise<'hung'>((resolve) => realSetTimeout(() => resolve('hung'), 500))
    const outcome = await Promise.race([pending, guard])

    expect(outcome, 'the release handler never settled').not.toBe('hung')
    expect(aborted).toBe(true)
    // A read that could not run is an error — never a license with no devices.
    expect(outcome).toEqual({ key: null, used: 0, seats: 0, source: null, error: 'network' })
  })

  it('reports an error instead of zero devices when the read fails', async () => {
    storeToken()
    await boot(
      vi.fn(async () => {
        throw new Error('down')
      })
    )

    expect(await detail()).toEqual({
      key: null,
      used: 0,
      seats: 0,
      source: null,
      error: 'offline'
    })
  })

  it('surfaces the 30-day throttle with its retry window', async () => {
    storeToken()
    await boot(vi.fn(async () => errorResponse(429, { error: 'too_soon', retryAfterDays: 12 })))

    // toEqual, not toMatchObject: the retry window is the whole point of this reply, and the
    // server side asserts only the error code — so if `retryAfterDays` is dropped anywhere
    // between the wire and the renderer, this is what fails.
    expect(await release()).toEqual({
      key: null,
      used: 0,
      seats: 0,
      source: null,
      error: 'too_soon',
      retryAfterDays: 12
    })
  })

  it('keeps not_applicable distinguishable from a plain bad request', async () => {
    // 'not_applicable' = this entitlement is not keygen-backed, so releasing means nothing. The
    // UI hides the action on `source`; this is the server-side floor under that, not a failure.
    storeToken()
    await boot(vi.fn(async () => errorResponse(400, { error: 'not_applicable' })))
    expect((await release()).error).toBe('not_applicable')

    vi.stubGlobal('fetch', vi.fn(async () => errorResponse(400, { error: 'bad_request' })))
    expect((await release()).error).toBe('bad_request')
  })

  it('an error body with no reason code falls back to network, and never to success', async () => {
    storeToken()
    await boot(vi.fn(async () => errorResponse(500, {})))
    expect((await detail()).error).toBe('network')
  })

  it('reports used above seats verbatim — a cap can be lowered after activation', async () => {
    storeToken()
    await boot(vi.fn(async () => jsonResponse({ key: 'K', used: 5, seats: 3, source: 'keygen' })))

    const d = await detail()
    expect(d.used).toBe(5) // never clamped to the cap: over-cap is a real, reportable state
    expect(d.seats).toBe(3)
  })

  it('a 2xx whose counts are not numbers is a FAILED READ, not a license with no devices', async () => {
    // The scenario: a captive portal or corporate proxy answers the POST with a 200 HTML page, or
    // a bad deploy answers `200 {}` / `200 {"used":"3"}`. Coercing those to zeros with error null
    // renders "0 of 0 devices" and an empty key as fact — a subscriber told they have no license.
    storeToken()
    await boot(vi.fn(async () => jsonResponse({ key: 'K', used: '3', seats: null, source: 'keygen' })))

    expect(await detail()).toEqual({
      key: null,
      used: 0,
      seats: 0,
      source: null,
      error: 'network'
    })

    // The 200 HTML page: the body does not parse at all.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token <')
        }
      }))
    )
    expect((await detail()).error).toBe('network')
  })

  it('refuses to call the server with no stored entitlement', async () => {
    // No license.json at all.
    const fetchMock = vi.fn()
    await boot(fetchMock)

    expect(await detail()).toEqual({
      key: null,
      used: 0,
      seats: 0,
      source: null,
      error: 'unauthorized'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('honors the telemetry kill switch without inventing a device count', async () => {
    storeToken()
    const fetchMock = vi.fn(async () => jsonResponse({ key: 'K', used: 2, seats: 3, source: 'keygen' }))
    await boot(fetchMock)
    process.env.DO_NOT_TRACK = '1'

    expect(await detail()).toEqual({
      key: null,
      used: 0,
      seats: 0,
      source: null,
      error: 'disabled'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ignores a source it does not recognize rather than passing it through', async () => {
    // The value decides whether a destructive-ish action is offered, so an unknown word degrades
    // to "no source stated" (the action stays hidden) instead of reaching the UI as data.
    storeToken()
    await boot(
      vi.fn(async () => jsonResponse({ key: 'K', used: 1, seats: 3, source: 'paddle' }))
    )
    const d = await detail()
    expect(d.source).toBeNull()
    // …and it stays a SUCCESS. Stamping an error here would hide the whole panel over a reply that
    // carried a perfectly good key and device count.
    expect(d.error).toBeNull()
    expect(d.key).toBe('K')
  })
})
