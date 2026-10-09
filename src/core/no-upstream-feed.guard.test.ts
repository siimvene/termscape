import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { CorePlatform } from './platform'

/**
 * TERMSCAPE FORK — nothing upstream's backend says reaches this fork's screen, and nothing this
 * fork's builds do is reported there.
 *
 * Upstream's `/v1/check` feed (core/check.ts) delivers announcement banners and a mandatory-update
 * policy judged against UPSTREAM's version line; on 2026-10-09 it pinned a non-dismissible "Update
 * required (minimum 0.4.2)" card on v0.3.16-selfhost.3 that the fork's updater could never clear.
 * Upstream's telemetry ping (main/telemetry.ts) posts version/OS/deviceId to the same backend. Both
 * are dead switches in the fork. This pins them as a PACKAGED build with the user's telemetry toggle
 * on and no kill-switch env set, the exact state in which upstream's code phones home — so an
 * upstream merge that rewrites either function turns this red instead of quietly re-enabling it.
 */

const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: 'x', title: 'banner' }], update: { minSupported: '99.0.0', mandatory: true } })))

// Without this, upstream's getDeviceId() throws on the stub platform, fetchCheck's catch returns
// EMPTY, and the first case passes even with the feed re-enabled (measured: it did).
vi.mock('./device-id', () => ({ getDeviceId: () => 'guard-device-id' }))

vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => '/nonexistent-termscape-guard', getVersion: () => '0.4.2' }
}))

let savedEnv: Record<string, string | undefined>
beforeEach(async () => {
  savedEnv = { DO_NOT_TRACK: process.env.DO_NOT_TRACK, NODETERM_TELEMETRY_DISABLED: process.env.NODETERM_TELEMETRY_DISABLED, NODETERM_API_BASE: process.env.NODETERM_API_BASE }
  delete process.env.DO_NOT_TRACK
  delete process.env.NODETERM_TELEMETRY_DISABLED
  process.env.NODETERM_API_BASE = 'https://api.example.invalid'
  fetchSpy.mockClear()
  vi.stubGlobal('fetch', fetchSpy)
  vi.resetModules()
  // After resetModules: check.ts must see THIS platform instance, or platform() throws inside its
  // try and the case passes blind.
  const { initPlatform } = await import('./platform')
  initPlatform({ isPackaged: true, appVersion: '0.4.2' } as unknown as CorePlatform)
})
afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  vi.unstubAllGlobals()
  vi.useRealTimers()
  ;(await import('./platform')).resetPlatformForTests()
})

describe('no upstream feed (fork)', () => {
  it('fetchCheck never calls the network and reports no banners and no mandatory update', async () => {
    const { fetchCheck } = await import('./check')
    const r = await fetchCheck()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(r).toEqual({ messages: [], update: { minSupported: null, mandatory: false } })
  })

  it('telemetry never pings, even packaged with the toggle on', async () => {
    vi.useFakeTimers()
    vi.doMock('fs', async (orig) => {
      const real = (await orig()) as typeof import('fs')
      return { ...real, readFileSync: () => 'guard-device-id', promises: { ...real.promises, writeFile: async () => {} } }
    })
    const { initTelemetry } = await import('../main/telemetry')
    initTelemetry(() => ({ telemetryEnabled: true }) as never)
    await vi.advanceTimersByTimeAsync(3 * 24 * 60 * 60 * 1000)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
