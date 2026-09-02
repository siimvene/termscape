import { describe, expect, it } from 'vitest'
import { parseSafeAreaTop, probeSafeAreaTop } from './notch-safe-area'

describe('notch-safe-area', () => {
  it('parses the probe output as a non-negative finite number of points', () => {
    expect(parseSafeAreaTop('32\n')).toBe(32)
    expect(parseSafeAreaTop(' 0 ')).toBe(0)
    expect(parseSafeAreaTop('31.5')).toBe(31.5)
  })

  it('answers null for anything that is not a trustworthy number', () => {
    for (const bad of ['', 'nan', 'undefined', '-1', 'Infinity', 'error: ...', '32px']) {
      expect(parseSafeAreaTop(bad), bad).toBeNull()
    }
  })

  it('resolves null off macOS without spawning anything', async () => {
    expect(await probeSafeAreaTop('linux')).toBeNull()
    expect(await probeSafeAreaTop('win32')).toBeNull()
  })

  it.skipIf(process.platform !== 'darwin')('on a Mac, answers a real inset for the primary display, or null headless', async () => {
    // 0 on a notchless panel or with an external as primary; > 0 on a built-in notched panel; and
    // `null` when there is no NSScreen at all (a headless CI runner / SSH session without a window
    // server) — that is the documented fail-open, not a failure.
    const top = await probeSafeAreaTop()
    expect(top === null || (Number.isFinite(top) && top >= 0)).toBe(true)
  })
})
