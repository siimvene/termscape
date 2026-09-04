/**
 * The Add-account version probe's TIMEOUT branch (consort finding, 2026-08-28).
 *
 * `claude:accounts-add` races `claude --version` against a 1.5s budget so a slow login shell can
 * never make the Add button look hung. The branch that matters is what it answers when the budget
 * wins: it must be `versionSupported: false`, because the renderer shows the keychain-collision
 * warning only on `!versionSupported`, and Claude Code < 2.1 shares ONE unscoped Keychain service
 * across config dirs — so a suppressed warning means account B's login silently overwrites
 * account A's credential. It previously answered `true` (assumed supported), which suppressed the
 * warning on exactly the slow machines the budget exists for.
 *
 * MUTATIONS (checked):
 *  - restore `resolve(true)` on timeout ⇒ the slow-probe test reddens.
 *  - drop the `clearTimeout` in `finally` ⇒ the timer-cleanup test reddens.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import { mkdtempSync, rmSync } from 'fs'

const h: { handlers: Record<string, (...a: any[]) => unknown> } = { handlers: {} }
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: any[]) => unknown) => (h.handlers[ch] = fn) }
}))

// The probe's only I/O seam: resolving `claude` on the login PATH. Each test drives its timing.
const findInLoginPath = vi.fn<(n: string) => Promise<string | null>>()
vi.mock('../core/pty-manager', () => ({ findInLoginPath: (n: string) => findInLoginPath(n) }))

// Side effects of Add that are irrelevant here (and would touch the real user's dirs).
vi.mock('../core/agents/hooks/claude', () => ({
  installClaudeHooksInto: vi.fn(),
  ensureClaudeFullscreenTuiInto: vi.fn()
}))
vi.mock('./canvas-control', () => ({ installCanvasSkillInto: vi.fn() }))

let tmp = ''
vi.mock('../core/claude-config-dir', () => ({
  claudeConfigDirFor: (id: string) => path.join(tmp, id)
}))

const ADD = 'claude-accounts:add'

describe('Add-account version probe budget', () => {
  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'nt-acct-'))
    h.handlers = {}
    findInLoginPath.mockReset()
    vi.resetModules()
    const mod = await import('./claude-accounts')
    // The row store: the verb registers its row through `mutate` before it probes, so a store is
    // required — an in-memory one keeps this file about the probe.
    let rows: { id: string }[] = []
    const settings = {
      get: () => ({ claudeAccounts: rows }) as never,
      readAccountsFromDisk: async () => ({ claudeAccounts: rows }) as never,
      mutate: async (fn: (s: never) => { claudeAccounts: { id: string }[] }) => {
        rows = fn({ claudeAccounts: rows } as never).claudeAccounts
        return { claudeAccounts: rows } as never
      }
    }
    mod.initClaudeAccounts?.(settings, () => undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  })

  it('reports UNSUPPORTED when the probe outruns the budget, so the collision warning still shows', async () => {
    // The race only exists on darwin — every other platform short-circuits checkClaudeVersion to
    // `true` before the probe starts (no shared Keychain, nothing to warn about), so on the Linux
    // CI runner this test read `true` and reddened. Pin the platform the branch belongs to.
    const platform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      // Never resolves within the budget — the hung-login-shell case the budget exists for.
      findInLoginPath.mockImplementation(() => new Promise(() => {}))
      const res = (await h.handlers[ADD]?.({})) as { versionSupported: boolean }
      expect(res.versionSupported).toBe(false)
    } finally {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    }
  }, 10_000)

  it('does not leave the budget timer armed once the probe answers first', async () => {
    // A non-darwin platform short-circuits checkClaudeVersion to an immediate `true`, so the probe
    // always wins the race — the branch where the loser timer used to stay scheduled.
    const platform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const clearSpy = vi.spyOn(global, 'clearTimeout')
    try {
      const res = (await h.handlers[ADD]?.({})) as { versionSupported: boolean }
      expect(res.versionSupported).toBe(true)
      expect(clearSpy).toHaveBeenCalled()
    } finally {
      clearSpy.mockRestore()
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    }
  })
})
