import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sanitizeCheckForTest as sanitize } from './check'
import { fakePlatform } from './platform-fake'

describe('/v1/check sanitize — update notes', () => {
  it('carries notes only together with the version they describe', () => {
    expect(sanitize({ update: { mandatory: false, notes: '- a', latestVersion: '1.2.0' } }).update).toEqual({
      minSupported: null,
      mandatory: false,
      notes: '- a',
      latestVersion: '1.2.0'
    })
    expect(sanitize({ update: { notes: '- a' } }).update).toEqual({ minSupported: null, mandatory: false })
    expect(sanitize({ update: { notes: 3, latestVersion: '1.2.0' } }).update).toEqual({
      minSupported: null,
      mandatory: false
    })
  })

  it('keeps the policy shape when the feed sends nothing', () => {
    expect(sanitize(null).update).toEqual({ minSupported: null, mandatory: false })
    expect(sanitize({ update: { minSupported: '0.5.0', mandatory: true } }).update).toEqual({
      minSupported: '0.5.0',
      mandatory: true
    })
  })

  it('caps the notes', () => {
    expect(sanitize({ update: { notes: 'x'.repeat(50_000), latestVersion: '1' } }).update.notes!.length).toBe(16 * 1024)
  })
})

// The feed is anonymous, so the backend can aim a message at paid or free users only by the plan
// the client states. Read per request and part of the cache key: an "upgrade to Pro" message
// cached as a free user must not be served for five more minutes to the same user once they pay.
describe('fetchCheck — reports the plan', () => {
  const premium = { value: false }
  let fetchMock: ReturnType<typeof vi.fn>

  const feed = (title: string, minSupported: string | null = null) =>
    new Response(JSON.stringify({ messages: [{ id: title, title }], update: { minSupported, mandatory: false } }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  const planOf = (call: number) => new URL(String(fetchMock.mock.calls[call][0])).searchParams.get('plan')
  // A fresh module graph per load (the cache is module state), so the platform must be set on the
  // SAME instance check.ts will import.
  const loadCheck = async () => {
    vi.resetModules()
    ;(await import('./platform')).initPlatform(fakePlatform())
    return import('./check')
  }

  beforeEach(() => {
    vi.doMock('./license', () => ({ isPremium: () => premium.value }))
    vi.doMock('./device-id', () => ({ getDeviceId: () => '33333333-3333-3333-3333-333333333333' }))
    vi.stubEnv('NODETERM_API_BASE', 'http://api.test')
    vi.stubEnv('DO_NOT_TRACK', '')
    vi.stubEnv('NODETERM_TELEMETRY_DISABLED', '')
    premium.value = false
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.doUnmock('./license')
    vi.doUnmock('./device-id')
  })

  // TERMSCAPE FORK: upstream's three plan tests assert the plan rides each /v1/check request. The
  // fork never contacts that feed (`allowed()` is a dead switch, pinned by
  // no-upstream-feed.guard.test.ts), so the fork-shaped claim is that no plan, Pro or free, ever
  // makes a request and the answer is always the empty result.
  it('never requests the feed, for a Pro or a free install (fork: no upstream feed)', async () => {
    fetchMock.mockResolvedValue(feed('x', '9.9.9'))
    for (const pro of [true, false]) {
      premium.value = pro
      expect(await (await loadCheck()).fetchCheck()).toEqual({
        messages: [],
        update: { minSupported: null, mandatory: false }
      })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
