import { describe, expect, it } from 'vitest'
import { capsuleOverhangPx } from './indicator'

// The regression this pins: a misdetected notch used to turn the notchless fallback pill into a
// ~170 px black bar, because the notch-covering right padding was applied regardless of layout.
describe('capsuleOverhangPx — the collapsed capsule pads right by the notch width ONLY to cover a notch', () => {
  const base = { expanded: false, notchless: false, indicatorWidth: 64, notchWidthPx: 168 }

  it('notched + collapsed + something to show ⇒ exactly the notch width', () => {
    expect(capsuleOverhangPx(base)).toBe(168)
  })
  it('notchless pill ⇒ no padding, whatever the indicator width', () => {
    expect(capsuleOverhangPx({ ...base, notchless: true })).toBe(0)
    expect(capsuleOverhangPx({ ...base, notchless: true, indicatorWidth: 400 })).toBe(0)
  })
  it('expanded ⇒ no padding (the panel has its own layout)', () => {
    expect(capsuleOverhangPx({ ...base, expanded: true })).toBe(0)
  })
  it('nothing to show ⇒ no padding', () => {
    expect(capsuleOverhangPx({ ...base, indicatorWidth: 0 })).toBe(0)
  })
  it('a later geometry push that flips the layout flips the padding', () => {
    expect(capsuleOverhangPx({ ...base, notchless: true })).toBe(0)
    expect(capsuleOverhangPx({ ...base, notchless: false })).toBe(168)
  })
})
