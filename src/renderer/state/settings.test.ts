// @vitest-environment jsdom
// The settings store's persistence has two speeds and one contract for each. Ordinary edits are
// COALESCED (300 ms, one write per window, latest snapshot) — the inputs fire per keystroke and a
// save is a temp-file write + rename. `flush()` is the barrier for the one caller that is about to
// start server-side work which READS settings (the Codex login node's pty looks the account id up
// in the shell's copy): it sends the pending snapshot now and resolves only when the shell has
// acknowledged it. The debounce must not loosen because the barrier exists, and the barrier must
// not resolve early because the debounce exists.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettings } from './settings'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'

let saved: Settings[]
let acknowledged: number
let save: ReturnType<typeof vi.fn>

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

beforeEach(async () => {
  // Drain whatever a previous test left coalesced, so its timer cannot land in this one.
  await useSettings.getState().flush?.()
  saved = []
  acknowledged = 0
  save = vi.fn(async (s: Settings) => {
    saved.push(s)
    await tick(5) // the shell's own write + rename, as seen from the renderer
    acknowledged += 1
  })
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    settings: { save, load: async () => DEFAULT_SETTINGS }
  }
  useSettings.setState({ settings: DEFAULT_SETTINGS, hydrated: true })
})

describe('useSettings persistence', () => {
  it('coalesces ordinary edits: nothing is written inside the window, one write after it', async () => {
    useSettings.getState().update({ systemAccountLabel: 'a' })
    useSettings.getState().update({ systemAccountLabel: 'ab' })
    await tick(100)
    expect(save).not.toHaveBeenCalled()
    await tick(300)
    expect(save).toHaveBeenCalledTimes(1)
    expect(saved[0].systemAccountLabel).toBe('ab')
  })

  // The barrier. Resolving when the save was merely SENT would re-open the race it exists to
  // close; it must resolve once the shell has answered.
  it('flush() writes the pending snapshot now and resolves only after the shell acknowledged it', async () => {
    useSettings.getState().update({ systemAccountLabel: 'now' })
    expect(save).not.toHaveBeenCalled()
    const flushed = useSettings.getState().flush()
    expect(save).toHaveBeenCalledTimes(1) // sent synchronously, not after the coalesce window
    expect(saved[0].systemAccountLabel).toBe('now')
    expect(acknowledged).toBe(0)
    await flushed
    expect(acknowledged).toBe(1)
    // The coalesce timer was cancelled: no second write of the same snapshot follows.
    await tick(350)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('flush() with nothing pending resolves without writing', async () => {
    await useSettings.getState().flush()
    expect(save).not.toHaveBeenCalled()
  })

  // A save whose timer already fired is still in flight; a flush must wait for THAT, since the
  // shell's cache is only updated once it lands.
  it('flush() waits for a save that the timer has already sent', async () => {
    // The shell holds this save until the test releases it, so "sent" and "acknowledged" are
    // observably different moments rather than 5 ms apart.
    let release!: () => void
    save.mockImplementationOnce(async (s: Settings) => {
      saved.push(s)
      await new Promise<void>((r) => (release = r))
      acknowledged += 1
    })
    useSettings.getState().update({ systemAccountLabel: 'timer' })
    await tick(310)
    expect(save).toHaveBeenCalledTimes(1)
    expect(acknowledged).toBe(0)
    let flushed = false
    const flush = useSettings.getState().flush().then(() => (flushed = true))
    await tick(10)
    expect(flushed).toBe(false) // still waiting on the shell, not resolved on "sent"
    release()
    await flush
    expect(acknowledged).toBe(1)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('flush() rejects when the shell rejects the save, so the caller cannot mistake it for registered', async () => {
    save.mockImplementationOnce(async () => {
      throw new Error('disk full')
    })
    useSettings.getState().update({ systemAccountLabel: 'boom' })
    await expect(useSettings.getState().flush()).rejects.toThrow('disk full')
  })
})

describe('coalesced settings save', () => {
  const g = globalThis as { window?: unknown }
  // This file runs under jsdom (the flush() barrier tests above need a window), so these cases
  // replace and delete the jsdom `window` and must put it back: the file-level beforeEach of the
  // next test writes `window.nodeTerminal` and would throw a ReferenceError on a deleted global.
  let originalWindow: PropertyDescriptor | undefined

  beforeEach(() => {
    originalWindow = Object.getOwnPropertyDescriptor(g, 'window')
  })

  afterEach(() => {
    delete g.window
    if (originalWindow) Object.defineProperty(g, 'window', originalWindow)
    vi.useRealTimers()
  })

  // A jsdom test file can end inside the coalesce window: vitest then deletes `window` from the
  // globals while the Node timer is still pending, and a callback that dereferences `window`
  // throws an unhandled ReferenceError that fails the whole run.
  it('drops the pending save when window is gone by the time the timer fires', () => {
    vi.useFakeTimers()
    const save = vi.fn(async (_s: unknown) => undefined)
    g.window = { nodeTerminal: { settings: { save } } }
    useSettings.getState().update({ panHoverDelay: 123 })
    delete g.window

    expect(() => vi.runAllTimers()).not.toThrow()
    expect(save).not.toHaveBeenCalled()
  })

  it('still writes the latest snapshot once when window is present', () => {
    vi.useFakeTimers()
    const save = vi.fn(async (_s: unknown) => undefined)
    g.window = { nodeTerminal: { settings: { save } } }
    useSettings.getState().update({ panHoverDelay: 1 })
    useSettings.getState().update({ panHoverDelay: 2 })
    vi.runAllTimers()

    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0]).toMatchObject({ panHoverDelay: 2 })
  })
})

describe('agent launch mode settings mirror', () => {
  beforeEach(() => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS }, hydrated: false })
  })

  it('keeps the legacy boolean synchronized with every launch mode update', () => {
    useSettings.getState().update({ agentLaunchMode: 'subscription' })
    expect(useSettings.getState().settings.vanillaLaunchDefault).toBe(true)

    useSettings.getState().update({ agentLaunchMode: 'gateway' })
    expect(useSettings.getState().settings.vanillaLaunchDefault).toBe(false)

    useSettings.getState().update({ agentLaunchMode: 'gateway-model' })
    expect(useSettings.getState().settings.vanillaLaunchDefault).toBe(false)
  })
})
