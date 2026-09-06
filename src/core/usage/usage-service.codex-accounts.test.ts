// Per-account Codex usage aggregation (S6 §4.3, Property 9): each managed account's usage is
// fetched against its OWN home and stamped with its OWN accountId, and the rows are NEVER merged
// or de-duplicated in the service — so one account's numbers can never collapse into, or be
// attributed to, another. Ambiguity / a read error fails closed to an EMPTY row for that account,
// never a fabricated account and never another account's numbers.
//
// fetchCodexUsage is mocked so these tests exercise the SERVICE's fan-out, keying and cache
// fingerprint — not the HTTP/app-server transports (those are covered in codex-usage.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { IPC } from '../../shared/ipc'
import type { ProviderUsage } from '../../shared/types'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform, type FakePlatform } from '../platform-fake'

function unavailableRow(provider: string): ProviderUsage {
  return { provider, account: null, limits: [], updatedAt: 0, status: 'unavailable' }
}

/** The default Codex fetcher: one 'ok' row stamped with the identity it was asked about. Reinstalled
 *  in beforeEach — a test that swaps the implementation must not leak it into its neighbours. */
const defaultCodexFetch = async (
  home?: string,
  identity?: { id?: string; label?: string | null; email?: string | null }
): Promise<ProviderUsage> => ({
  provider: 'codex',
  accountId: identity?.id,
  account: identity?.email ?? identity?.label ?? null,
  limits: [],
  updatedAt: Date.now(),
  status: 'ok'
})

const { fetchCodexUsage, otherFetchers } = vi.hoisted(() => {
  const row = (provider: string): ProviderUsage => ({
    provider,
    account: null,
    limits: [],
    updatedAt: 0,
    status: 'unavailable'
  })
  return {
    fetchCodexUsage: vi.fn<
      (
        home?: string,
        identity?: { id?: string; label?: string | null; email?: string | null }
      ) => Promise<ProviderUsage>
    >(),
    // Every billing provider is a SPY so a test can assert it was NOT called: the mirror's
    // Codex-only refresh must leave these untouched.
    otherFetchers: {
      gemini: vi.fn(async () => row('gemini')),
      grok: vi.fn(async () => row('grok')),
      kimi: vi.fn(async () => row('kimi')),
      minimax: vi.fn(async () => row('minimax')),
      opencode: vi.fn(async () => row('opencode'))
    }
  }
})

vi.mock('./codex-usage', () => ({ fetchCodexUsage }))
vi.mock('./gemini-usage', () => ({ fetchGeminiUsage: otherFetchers.gemini }))
vi.mock('./grok-usage', () => ({ fetchGrokUsage: otherFetchers.grok }))
vi.mock('./kimi-usage', () => ({ fetchKimiUsage: otherFetchers.kimi }))
vi.mock('./minimax-usage', () => ({ fetchMinimaxUsage: otherFetchers.minimax }))
vi.mock('./opencode-usage', () => ({ fetchOpencodeUsage: otherFetchers.opencode }))
// Opening the poll gate (`mirrorMayBeRead`) also fires the CLAUDE poll, whose credential
// resolution reaches the developer's login keychain on darwin and then the real usage endpoint.
// Neither may happen in a unit test: the keychain leg is stubbed to "no such item" (exit 44) and
// `fetch` is stubbed below, so a token found in a credentials FILE never leaves the process.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>()
  return {
    ...real,
    execFile: (_cmd: string, _args: unknown, cb: (err: Error) => void) =>
      cb(Object.assign(new Error('keychain stubbed out in tests'), { code: 44 }))
  }
})

import { startUsageService, type UsageService } from './usage-service'
import {
  _resetForTest as resetMirrorForTest,
  buildMirrorUsage,
  flush as flushMirror,
  initAgentStatusMirror,
  onMirrorFlush,
  setMirrorUsageProvider,
  type MirrorFile
} from '../agent-status-mirror'

const ALL_OTHER = Object.values(otherFetchers)

function codexRows(rows: ProviderUsage[]): ProviderUsage[] {
  return rows.filter((row) => row.provider === 'codex')
}

let platform: FakePlatform
let service: UsageService | undefined

beforeEach(() => {
  resetPlatformForTests()
  platform = fakePlatform()
  initPlatform(platform)
  // mockReset (not mockClear) — a test that installed its own implementation must not leak it into
  // the next one; the default is reinstalled here every time.
  fetchCodexUsage.mockReset()
  fetchCodexUsage.mockImplementation(defaultCodexFetch)
  for (const f of ALL_OTHER) f.mockClear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }))
  )
})

afterEach(() => {
  service?.dispose()
  service = undefined
  resetPlatformForTests()
  vi.unstubAllGlobals()
})

describe('Codex multi-account usage', () => {
  it('returns the system identity and two managed account rows independently', async () => {
    const accounts = [
      { id: 'a', home: '/isolated/a', label: 'Work', email: 'work@example.com' },
      { id: 'b', home: '/isolated/b', label: 'Personal', email: 'me@example.com' }
    ]
    service = startUsageService({ shouldPoll: () => false, codexAccounts: () => accounts })

    const rows = (await platform.handlers[IPC.usageProviders]()) as ProviderUsage[]
    // System row first (un-owned ⇒ accountId undefined), then one row per account keyed by its
    // own id — three DISTINCT rows, never merged into one.
    expect(codexRows(rows).map((row) => row.accountId)).toEqual([undefined, 'a', 'b'])
    // Each managed account is read against its OWN home + identity — never the system home.
    expect(fetchCodexUsage).toHaveBeenNthCalledWith(1)
    expect(fetchCodexUsage).toHaveBeenNthCalledWith(2, '/isolated/a', accounts[0])
    expect(fetchCodexUsage).toHaveBeenNthCalledWith(3, '/isolated/b', accounts[1])
  })

  it('invalidates the provider cache when an account is added', async () => {
    let accounts = [{ id: 'a', home: '/isolated/a', label: 'Work' }]
    service = startUsageService({ shouldPoll: () => false, codexAccounts: () => accounts })

    await platform.handlers[IPC.usageProviders]()
    // First sweep: system + account a.
    expect(fetchCodexUsage).toHaveBeenCalledTimes(2)

    // Adding an account changes the fingerprint, which must bust the debounce cache — otherwise
    // the popover would keep serving the two-row snapshot and the new account would never appear.
    accounts = [...accounts, { id: 'b', home: '/isolated/b', label: 'Personal' }]
    const rows = (await platform.handlers[IPC.usageProviders]()) as ProviderUsage[]
    expect(codexRows(rows).map((row) => row.accountId)).toEqual([undefined, 'a', 'b'])
    // 2 (first sweep) + 3 (second sweep after the bust) = 5. A stale cache would leave this at 2.
    expect(fetchCodexUsage).toHaveBeenCalledTimes(5)
  })

  it('serves the cache within the debounce while the account set is unchanged', async () => {
    const accounts = [{ id: 'a', home: '/isolated/a', label: 'Work' }]
    service = startUsageService({ shouldPoll: () => false, codexAccounts: () => accounts })

    await platform.handlers[IPC.usageProviders]()
    await platform.handlers[IPC.usageProviders]()
    // Same fingerprint ⇒ the second call is served from cache, not a re-fetch (2 + 2 would mean
    // the fingerprint check wrongly busts an unchanged set).
    expect(fetchCodexUsage).toHaveBeenCalledTimes(2)
  })

  it('a throwing codexAccounts() yields system-only, never a fabricated account', async () => {
    service = startUsageService({
      shouldPoll: () => false,
      codexAccounts: () => {
        throw new Error('settings read blew up')
      }
    })

    const rows = (await platform.handlers[IPC.usageProviders]()) as ProviderUsage[]
    // Fail closed: only the un-owned system row, no guessed / invented account.
    expect(codexRows(rows).map((row) => row.accountId)).toEqual([undefined])
    expect(fetchCodexUsage).toHaveBeenCalledTimes(1)
    expect(fetchCodexUsage).toHaveBeenNthCalledWith(1)
  })

  it('a read error for one account stays empty for THAT account — never another account’s numbers', async () => {
    const accounts = [
      { id: 'a', home: '/isolated/a', label: 'Work' },
      { id: 'b', home: '/isolated/b', label: 'Personal' }
    ]
    // Account a's read throws; account b returns real limits. The failure must fail closed to an
    // EMPTY row keyed to a — never adopt b's numbers and never drop a's id (which would fold it
    // into the un-owned system row).
    fetchCodexUsage.mockImplementation(async (home?: string, identity?: { id?: string }) => {
      if (identity?.id === 'a') throw new Error('auth.json unreadable')
      if (identity?.id === 'b') {
        return {
          provider: 'codex',
          accountId: 'b',
          account: null,
          limits: [
            {
              kind: 'session',
              group: 'session',
              usedPercent: 42,
              severity: null,
              resetsAt: null,
              windowMinutes: 300,
              scopeLabel: null,
              isActive: false
            }
          ],
          updatedAt: Date.now(),
          status: 'ok' as const
        }
      }
      return unavailableRow('codex')
    })
    service = startUsageService({ shouldPoll: () => false, codexAccounts: () => accounts })

    const rows = codexRows((await platform.handlers[IPC.usageProviders]()) as ProviderUsage[])
    const rowA = rows.find((r) => r.accountId === 'a')
    const rowB = rows.find((r) => r.accountId === 'b')

    expect(rowA).toBeDefined()
    expect(rowA?.status).toBe('error')
    expect(rowA?.limits).toEqual([]) // empty, NOT b's [42%] window
    expect(rowB?.status).toBe('ok')
    expect(rowB?.limits).toHaveLength(1)
    // The failing account never collapsed into the un-owned system row.
    expect(rows.filter((r) => r.accountId === undefined)).toHaveLength(1)
  })
})

describe('providersSnapshot / refreshProvidersIfStale (mirror feed)', () => {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await tick()
  }
  const codexCalls = (): number => fetchCodexUsage.mock.calls.length
  const otherCalls = (): number => ALL_OTHER.reduce((n, f) => n + f.mock.calls.length, 0)

  it('providersSnapshot is empty before any fetch, populated after', async () => {
    service = startUsageService({ shouldPoll: () => false })
    // Never fetches — the mirror's flush reads it, it must not trigger a network round-trip.
    expect(service.providersSnapshot()).toEqual([])
    expect(fetchCodexUsage).not.toHaveBeenCalled()

    await platform.handlers[IPC.usageProviders]()
    const rows = service.providersSnapshot()
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((r) => r.provider === 'codex')).toBe(true)
  })

  it('gate SHUT (unfocused, no phone) ⇒ refreshProvidersIfStale fetches nothing at all', async () => {
    service = startUsageService({
      shouldPoll: () => false,
      mirrorMayBeRead: () => false,
      codexAccounts: () => [{ id: 'a', home: '/isolated/a', label: 'Work' }]
    })
    service.refreshProvidersIfStale()
    await settle()
    // The mirror flushes on every agent event; with nobody reading, that must not become a poll.
    expect(codexCalls()).toBe(0)
    expect(otherCalls()).toBe(0)
    expect(service.providersSnapshot()).toEqual([])
  })

  it('gate open via mirrorMayBeRead + stale ⇒ the Codex fetchers run, the billing providers do NOT', async () => {
    const accounts = [{ id: 'a', home: '/isolated/a', label: 'Work' }]
    service = startUsageService({
      shouldPoll: () => false,
      mirrorMayBeRead: () => true,
      codexAccounts: () => accounts
    })
    service.refreshProvidersIfStale()
    await settle()
    // System row + account a — and only those.
    expect(codexCalls()).toBe(2)
    expect(fetchCodexUsage).toHaveBeenNthCalledWith(1)
    expect(fetchCodexUsage).toHaveBeenNthCalledWith(2, '/isolated/a', accounts[0])
    for (const f of ALL_OTHER) expect(f).not.toHaveBeenCalled()
    expect(service.providersSnapshot().map((r) => [r.provider, r.accountId])).toEqual([
      ['codex', undefined],
      ['codex', 'a']
    ])

    // Cache is fresh + the account set is unchanged ⇒ a second call kicks nothing.
    service.refreshProvidersIfStale()
    await settle()
    expect(codexCalls()).toBe(2)
    expect(otherCalls()).toBe(0)
  })

  it('gate open via shouldPoll alone also opens the Codex refresh (same gate as pollAll)', async () => {
    service = startUsageService({ shouldPoll: () => true, mirrorMayBeRead: () => false })
    service.refreshProvidersIfStale()
    await settle()
    expect(codexCalls()).toBe(1)
    expect(otherCalls()).toBe(0)
  })

  it("the popover's full usage:providers path still fetches EVERY provider", async () => {
    service = startUsageService({ shouldPoll: () => false })
    const rows = (await platform.handlers[IPC.usageProviders]()) as ProviderUsage[]
    expect(codexCalls()).toBe(1)
    for (const f of ALL_OTHER) expect(f).toHaveBeenCalledTimes(1)
    expect(rows.map((r) => r.provider)).toEqual([
      'codex',
      'gemini',
      'grok',
      'kimi',
      'minimax',
      'opencode'
    ])
  })

  it('a Codex-only refresh MERGES into the cache — the other providers’ rows survive, Codex stays first', async () => {
    let accounts = [{ id: 'a', home: '/isolated/a', label: 'Work' }]
    service = startUsageService({
      shouldPoll: () => false,
      mirrorMayBeRead: () => true,
      codexAccounts: () => accounts
    })
    // A full popover run seeds every provider's row.
    await platform.handlers[IPC.usageProviders]()
    expect(service.providersSnapshot()).toHaveLength(2 + ALL_OTHER.length)
    const otherBefore = otherCalls()

    // The Codex account set changes ⇒ the Codex rows are stale ⇒ the mirror's refresh re-fetches
    // Codex ONLY and merges: two new Codex rows + the old billing rows, untouched.
    accounts = [...accounts, { id: 'b', home: '/isolated/b', label: 'Personal' }]
    service.refreshProvidersIfStale()
    await settle()
    expect(otherCalls()).toBe(otherBefore)
    const snap = service.providersSnapshot()
    expect(snap.map((r) => [r.provider, r.accountId])).toEqual([
      ['codex', undefined],
      ['codex', 'a'],
      ['codex', 'b'],
      ['gemini', undefined],
      ['grok', undefined],
      ['kimi', undefined],
      ['minimax', undefined],
      ['opencode', undefined]
    ])
  })

  it("a Codex-only refresh does NOT satisfy the popover's debounce — the next usage:providers still runs the billing providers", async () => {
    service = startUsageService({ shouldPoll: () => false, mirrorMayBeRead: () => true })
    // Only the mirror has asked so far: the cache holds Codex rows and nothing else.
    service.refreshProvidersIfStale()
    await settle()
    expect(service.providersSnapshot().map((r) => r.provider)).toEqual(['codex'])
    expect(otherCalls()).toBe(0)

    // Were the Codex refresh to stamp the full-run debounce, this would be served the Codex-only
    // cache and the pill would show no billing provider at all.
    const rows = (await platform.handlers[IPC.usageProviders]()) as ProviderUsage[]
    for (const f of ALL_OTHER) expect(f).toHaveBeenCalledTimes(1)
    expect(rows).toHaveLength(1 + ALL_OTHER.length)
  })

  it('refreshProvidersIfStale is a no-op while a run is already in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    fetchCodexUsage.mockImplementation(async () => {
      await gate
      return { provider: 'codex', account: null, limits: [], updatedAt: Date.now(), status: 'ok' as const }
    })
    service = startUsageService({ shouldPoll: () => false, mirrorMayBeRead: () => true })

    service.refreshProvidersIfStale() // kicks a run; the fetch is gated, so it stays in flight
    service.refreshProvidersIfStale() // must NOT start a second run
    // Only the single system-row fetch of the one in-flight run.
    expect(fetchCodexUsage).toHaveBeenCalledTimes(1)

    release()
    await settle()
  })

  it('a full run reuses a Codex leg already in flight rather than fetching the same account twice', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    fetchCodexUsage.mockImplementation(async () => {
      await gate
      return { provider: 'codex', account: null, limits: [], updatedAt: Date.now(), status: 'ok' as const }
    })
    service = startUsageService({ shouldPoll: () => false, mirrorMayBeRead: () => true })
    service.refreshProvidersIfStale() // Codex leg in flight
    const full = platform.handlers[IPC.usageProviders]() as Promise<ProviderUsage[]>
    release()
    const rows = await full
    await settle()
    expect(fetchCodexUsage).toHaveBeenCalledTimes(1)
    expect(rows.filter((r) => r.provider === 'codex')).toHaveLength(1)
    expect(service.providersSnapshot()).toHaveLength(1 + ALL_OTHER.length)
  })

  it('a mirror flush while a FULL run still waits on the billing providers does not re-fetch Codex', async () => {
    // The Codex leg of a full run settles seconds before gemini/grok/… do; codexAt is stamped and
    // codexInFlight cleared, but the account-set fingerprint lands only with the WHOLE run. A flush
    // in that window (first popover open after boot with a managed account: fingerprint '' vs the
    // managed set) must not read "changed set" and fetch every Codex account a second time.
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    for (const f of ALL_OTHER) {
      f.mockImplementationOnce(async () => {
        await gate
        return unavailableRow('slow')
      })
    }
    const accounts = [{ id: 'a', home: '/isolated/a', label: 'Work' }]
    service = startUsageService({
      shouldPoll: () => false,
      mirrorMayBeRead: () => true,
      codexAccounts: () => accounts
    })
    const full = platform.handlers[IPC.usageProviders]() as Promise<ProviderUsage[]>
    await settle() // the Codex leg (system + a) has landed; the billing providers are still gated
    expect(codexCalls()).toBe(2)
    service.refreshProvidersIfStale() // a mirror flush lands in the window
    await settle()
    expect(codexCalls()).toBe(2)
    release()
    await full
    await settle()
    expect(codexCalls()).toBe(2)
    // And once the run has landed, the flush that its landing triggers kicks nothing either.
    service.refreshProvidersIfStale()
    await settle()
    expect(codexCalls()).toBe(2)
  })

  it('a popover open DURING an in-flight Codex leg for a CHANGED account set is never served the previous set', async () => {
    let accounts = [{ id: 'a', home: '/isolated/a', label: 'Work' }]
    service = startUsageService({
      shouldPoll: () => false,
      mirrorMayBeRead: () => true,
      codexAccounts: () => accounts
    })
    // Seed a full run: system + a (+ the billing rows).
    await platform.handlers[IPC.usageProviders]()
    expect(codexCalls()).toBe(2)

    // The account set changes and the mirror kicks a Codex leg whose fetches stay in flight.
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    fetchCodexUsage.mockImplementation(async (home, identity) => {
      await gate
      return defaultCodexFetch(home, identity)
    })
    accounts = [...accounts, { id: 'b', home: '/isolated/b', label: 'Personal' }]
    service.refreshProvidersIfStale()
    expect(codexCalls()).toBe(5) // system + a + b, in flight

    // The popover opens mid-leg. Were the fingerprint stamped at leg START, the handler would see
    // it matching, keep its debounce and hand back the cache built from the OLD set synchronously.
    const result = platform.handlers[IPC.usageProviders]()
    let resolved = false
    void Promise.resolve(result).then(() => {
      resolved = true
    })
    await settle()
    expect(resolved).toBe(false)

    release()
    const rows = (await result) as ProviderUsage[]
    expect(codexRows(rows).map((r) => r.accountId)).toEqual([undefined, 'a', 'b'])
    // It joined the in-flight leg rather than fetching the same accounts a second time.
    expect(codexCalls()).toBe(5)
    expect(service.providersSnapshot().filter((r) => r.provider === 'codex')).toHaveLength(3)
  })

  it('the mirror refresh re-fetches on the Claude poll cadence (15 min), not the 5-min popover debounce', async () => {
    let offset = 0
    const realNow = Date.now
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset)
    try {
      service = startUsageService({ shouldPoll: () => false, mirrorMayBeRead: () => true })
      service.refreshProvidersIfStale()
      await settle()
      expect(codexCalls()).toBe(1)

      // 6 min later: past the popover debounce, inside the poll cadence ⇒ still fresh for the mirror.
      offset = 6 * 60_000
      service.refreshProvidersIfStale()
      await settle()
      expect(codexCalls()).toBe(1)

      // 15 min later: the Claude rows beside these would be re-polled now, so Codex is too.
      offset = 15 * 60_000
      service.refreshProvidersIfStale()
      await settle()
      expect(codexCalls()).toBe(2)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('a popover open right after a background Codex refresh REUSES those rows; force or age re-fetches', async () => {
    let offset = 0
    const realNow = Date.now
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset)
    try {
      const accounts = [{ id: 'a', home: '/isolated/a', label: 'Work' }]
      service = startUsageService({
        shouldPoll: () => false,
        mirrorMayBeRead: () => true,
        codexAccounts: () => accounts
      })
      service.refreshProvidersIfStale()
      await settle()
      expect(codexCalls()).toBe(2)

      // The popover opens: the billing providers run, the fresh Codex rows are reused, not re-fetched.
      const rows = (await platform.handlers[IPC.usageProviders]()) as ProviderUsage[]
      expect(codexCalls()).toBe(2)
      for (const f of ALL_OTHER) expect(f).toHaveBeenCalledTimes(1)
      expect(rows.map((r) => [r.provider, r.accountId])).toEqual([
        ['codex', undefined],
        ['codex', 'a'],
        ['gemini', undefined],
        ['grok', undefined],
        ['kimi', undefined],
        ['minimax', undefined],
        ['opencode', undefined]
      ])

      // The refresh button bypasses the reuse.
      await platform.handlers[IPC.usageProviders](true)
      expect(codexCalls()).toBe(4)

      // Codex rows older than the popover's own debounce are not reused either.
      offset = 6 * 60_000
      await platform.handlers[IPC.usageProviders]()
      expect(codexCalls()).toBe(6)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('onCacheUpdate fires after a completed providers run', async () => {
    const onCacheUpdate = vi.fn()
    service = startUsageService({ shouldPoll: () => false, onCacheUpdate })
    // Boot with the poll gated off ⇒ no Claude poll fired onCacheUpdate; only the providers run does.
    expect(onCacheUpdate).not.toHaveBeenCalled()

    await platform.handlers[IPC.usageProviders]()
    expect(onCacheUpdate).toHaveBeenCalled()
  })
})

describe('mirror ⇄ usage service integration (flush → refresh → onCacheUpdate → flush)', () => {
  let tmpDir: string
  let file: string

  beforeEach(() => {
    resetMirrorForTest()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-mirror-feed-'))
    file = path.join(tmpDir, 'status.json')
    initAgentStatusMirror(file)
  })
  afterEach(() => {
    setMirrorUsageProvider(null)
    resetMirrorForTest()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('wired like the shells: one flush ⇒ exactly one Codex run, the chain terminates, the file carries the Codex rows', async () => {
    const codexAccounts = [{ id: 'cx1', home: '/isolated/cx1', label: 'Codex Work', email: 'work@codex' }]
    let flushes = 0
    service = startUsageService({
      shouldPoll: () => false,
      mirrorMayBeRead: () => true, // a phone is paired: the gate is open
      codexAccounts: () => codexAccounts,
      onCacheUpdate: () => {
        flushes++
        void flushMirror()
      }
    })
    const svc = service
    // Exactly the provider both shells install (main/index.ts, server/handlers/index.ts).
    setMirrorUsageProvider(() => {
      svc.refreshProvidersIfStale()
      return buildMirrorUsage([], [], Date.now(), svc.providersSnapshot(), codexAccounts)
    })

    // Await the OBSERVABLE, not a tick count: the first flushed doc carrying a Codex row. It is the
    // Codex run landing → onCacheUpdate → re-flush chain, bounded by a real timeout.
    const firstCodexDoc = new Promise<MirrorFile>((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new Error('no flushed doc carried a Codex row within 5 s'))
      }, 5000)
      const off = onMirrorFlush((doc) => {
        if (doc.usage?.accounts.some((a) => a.agentId === 'codex')) {
          clearTimeout(timer)
          off()
          resolve(doc)
        }
      })
    })
    await flushMirror()
    const doc = await firstCodexDoc

    // System row + cx1, each fetched once — the re-flush saw fresh rows and kicked nothing more.
    expect(fetchCodexUsage).toHaveBeenCalledTimes(2)
    expect(fetchCodexUsage).toHaveBeenNthCalledWith(1)
    expect(fetchCodexUsage).toHaveBeenNthCalledWith(2, '/isolated/cx1', codexAccounts[0])
    for (const f of ALL_OTHER) expect(f).not.toHaveBeenCalled()
    // Bounded: the Codex run's own re-flush plus whatever the (stubbed, failing) Claude poll pushed —
    // never a runaway chain. Two Claude pushes at most (system + none managed) ⇒ ≤ 3 in total.
    expect(flushes).toBeGreaterThanOrEqual(1)
    expect(flushes).toBeLessThanOrEqual(3)

    const docCodex = doc.usage!.accounts.filter((a) => a.agentId === 'codex')
    expect(docCodex.map((a) => a.accountId)).toEqual([null, 'cx1'])
    expect(docCodex[1]).toMatchObject({ label: 'Codex Work', email: 'work@codex', status: 'ok' })

    // The FILE carries the same rows: one more flush's write is chained behind every earlier one
    // (the mirror serializes its disk writes per path), and its own refresh is a no-op on fresh rows.
    await flushMirror()
    expect(fetchCodexUsage).toHaveBeenCalledTimes(2)
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'))
    const fileCodex = onDisk.usage.accounts.filter((a: { agentId: string }) => a.agentId === 'codex')
    expect(fileCodex.map((a: { accountId: string | null }) => a.accountId)).toEqual([null, 'cx1'])
    expect(fileCodex[1]).toMatchObject({ label: 'Codex Work', email: 'work@codex', status: 'ok' })
  })
})
