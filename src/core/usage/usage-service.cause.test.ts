// The usage failure taxonomy. Before it, `fetchUsage` answered with two words for six different
// facts: 429, 500, a DNS failure and an unreadable body were all 'error', and "no credential on
// disk" was the same 'unavailable' as "Anthropic refused the credential". A real account whose
// OAuth token had expired therefore read, in the UI, exactly like one that was never signed in —
// which is why its failure could not be diagnosed from the app at all.
//
// Both edges are injected. Reading the real credentials here is not an option: on darwin
// `resolveCreds` reaches the developer's own login keychain, so a "no token" case would find a
// real token and a "401" case would put it on the wire.
import { describe, it, expect } from 'vitest'
import {
  classifyUsageResponseStatus,
  classifyUsageThrow,
  fetchUsage,
  type UsageFetchDeps
} from './usage-service'

const creds = (accessToken: string | null): UsageFetchDeps['resolveCreds'] =>
  async () => ({ accessToken, email: 'someone@example.test' })

/** A minimal Response stand-in — `fetchUsage` reads `ok`, `status` and `json()` and nothing else. */
const respond = (status: number, body?: unknown): UsageFetchDeps['fetchImpl'] =>
  (() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (body === undefined) throw new SyntaxError('Unexpected token < in JSON')
        return body
      }
    } as unknown as Response)) as unknown as UsageFetchDeps['fetchImpl']

const rejectWith = (err: unknown): UsageFetchDeps['fetchImpl'] =>
  (() => Promise.reject(err)) as unknown as UsageFetchDeps['fetchImpl']

const named = (name: string): Error => Object.assign(new Error(name), { name })

describe('fetchUsage failure causes', () => {
  it('no credential at all → unavailable / no-credentials, and no HTTP status invented', async () => {
    const u = await fetchUsage(undefined, { resolveCreds: creds(null), fetchImpl: respond(200, {}) })
    expect(u.status).toBe('unavailable')
    expect(u.cause).toBe('no-credentials')
    expect(u.httpStatus).toBeUndefined()
  })

  // The pair the PLG account turned on: same `status`, different cause. Without this the UI
  // cannot say "sign in again" rather than "you have never signed in".
  it('401 → unavailable / unauthorized, distinguishable from no-credentials', async () => {
    const u = await fetchUsage(undefined, { resolveCreds: creds('t'), fetchImpl: respond(401) })
    expect(u.status).toBe('unavailable')
    expect(u.cause).toBe('unauthorized')
    expect(u.httpStatus).toBe(401)
  })

  it('403 → unavailable / unauthorized', async () => {
    const u = await fetchUsage(undefined, { resolveCreds: creds('t'), fetchImpl: respond(403) })
    expect(u.status).toBe('unavailable')
    expect(u.cause).toBe('unauthorized')
  })

  it('429 → error / rate-limited, not collapsed with a server fault', async () => {
    const u = await fetchUsage(undefined, { resolveCreds: creds('t'), fetchImpl: respond(429) })
    expect(u.status).toBe('error')
    expect(u.cause).toBe('rate-limited')
    expect(u.httpStatus).toBe(429)
  })

  it('500 → error / server-error', async () => {
    const u = await fetchUsage(undefined, { resolveCreds: creds('t'), fetchImpl: respond(500) })
    expect(u.status).toBe('error')
    expect(u.cause).toBe('server-error')
    expect(u.httpStatus).toBe(500)
  })

  // An unclassifiable non-ok code must report the number it saw, never a class nobody observed.
  it('an unclassified non-ok code → error / http, carrying the code itself', async () => {
    const u = await fetchUsage(undefined, { resolveCreds: creds('t'), fetchImpl: respond(418) })
    expect(u.status).toBe('error')
    expect(u.cause).toBe('http')
    expect(u.httpStatus).toBe(418)
  })

  it('a thrown request → error / network', async () => {
    const u = await fetchUsage(undefined, {
      resolveCreds: creds('t'),
      fetchImpl: rejectWith(new TypeError('fetch failed'))
    })
    expect(u.status).toBe('error')
    expect(u.cause).toBe('network')
    expect(u.httpStatus).toBeUndefined()
  })

  // Our own 8 s abort is the one throw we can attribute, and it is not evidence of being offline.
  it('our abort → error / timeout, kept apart from network', async () => {
    const u = await fetchUsage(undefined, {
      resolveCreds: creds('t'),
      fetchImpl: rejectWith(named('AbortError'))
    })
    expect(u.cause).toBe('timeout')
  })

  // An ok response with an unreadable body: the endpoint answered, so this is not 'network'.
  it('an ok response with an unreadable body → error / parse, carrying the ok status', async () => {
    const u = await fetchUsage(undefined, { resolveCreds: creds('t'), fetchImpl: respond(200) })
    expect(u.status).toBe('error')
    expect(u.cause).toBe('parse')
    expect(u.httpStatus).toBe(200)
  })

  it('a good response still maps to ok with no cause attached', async () => {
    const u = await fetchUsage(undefined, {
      resolveCreds: creds('t'),
      fetchImpl: respond(200, { limits: [{ kind: 'session', percent: 12 }] })
    })
    expect(u.status).toBe('ok')
    expect(u.cause).toBeUndefined()
    expect(u.limits).toHaveLength(1)
  })
})

describe('classify helpers', () => {
  it('keeps every existing status value meaning what it meant', () => {
    // The mirror and the pill's hide rule read `status`; widening it was rejected, so these four
    // mappings are the contract this change must not move.
    expect(classifyUsageResponseStatus(401).status).toBe('unavailable')
    expect(classifyUsageResponseStatus(403).status).toBe('unavailable')
    expect(classifyUsageResponseStatus(429).status).toBe('error')
    expect(classifyUsageResponseStatus(503).status).toBe('error')
    expect(classifyUsageResponseStatus(404).status).toBe('error')
  })

  it('names 5xx server-error and anything else http', () => {
    expect(classifyUsageResponseStatus(502).cause).toBe('server-error')
    expect(classifyUsageResponseStatus(400).cause).toBe('http')
  })

  it('only an abort counts as a timeout', () => {
    expect(classifyUsageThrow(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('timeout')
    expect(classifyUsageThrow(new TypeError('fetch failed'))).toBe('network')
    expect(classifyUsageThrow(null)).toBe('network')
  })
})
