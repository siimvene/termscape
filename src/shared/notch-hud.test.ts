import { describe, it, expect } from 'vitest'
import {
  NOTCH_OFFSET_MAX,
  NOTCH_OFFSET_MIN,
  NOTCH_WIDTH_DEFAULT,
  NOTCH_WIDTH_MAX,
  NOTCH_WIDTH_MIN,
  sanitizeNotchAlign,
  sanitizeNotchOffsetY,
  sanitizeNotchWidth
} from './notch-hud'

// settings.json is hand-editable: every one of these is a value a user (or a future build) can put
// there, and none may reach the window as anything but a value the layout can draw.

describe('sanitizeNotchAlign', () => {
  it('passes the three known sides through', () => {
    expect(sanitizeNotchAlign('left')).toBe('left')
    expect(sanitizeNotchAlign('center')).toBe('center')
    expect(sanitizeNotchAlign('right')).toBe('right')
  })

  it.each([
    ['a typo', 'centre'],
    ['a case mismatch', 'Left'],
    ['a future value', 'top'],
    ['a number', 1],
    ['null', null],
    ['undefined', undefined],
    ['an object with a matching key', { left: true }]
  ])('falls back to center for %s', (_label, v) => {
    expect(sanitizeNotchAlign(v)).toBe('center')
  })
})

describe('sanitizeNotchOffsetY', () => {
  it('keeps an in-range integer, and rounds a fractional one', () => {
    expect(sanitizeNotchOffsetY(12)).toBe(12)
    expect(sanitizeNotchOffsetY(-12)).toBe(-12)
    expect(sanitizeNotchOffsetY(7.6)).toBe(8)
    expect(sanitizeNotchOffsetY(0)).toBe(0)
  })

  it('clamps an out-of-range value to the nearest bound, keeping its direction', () => {
    expect(sanitizeNotchOffsetY(10_000)).toBe(NOTCH_OFFSET_MAX)
    expect(sanitizeNotchOffsetY(-10_000)).toBe(NOTCH_OFFSET_MIN)
  })

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['a numeric string', '20'],
    ['null', null],
    ['undefined', undefined],
    ['a boolean', true]
  ])('falls back to 0 for %s', (_label, v) => {
    expect(sanitizeNotchOffsetY(v)).toBe(0)
  })
})

describe('sanitizeNotchWidth (moved here from notch-hud.ts, behaviour pinned)', () => {
  it('clamps to the slider bounds and rounds', () => {
    expect(sanitizeNotchWidth(50)).toBe(NOTCH_WIDTH_MIN)
    expect(sanitizeNotchWidth(900)).toBe(NOTCH_WIDTH_MAX)
    expect(sanitizeNotchWidth(180.4)).toBe(180)
  })
  it('falls back to the field-tuned default for a non-number', () => {
    expect(sanitizeNotchWidth(NaN)).toBe(NOTCH_WIDTH_DEFAULT)
    expect(sanitizeNotchWidth('168')).toBe(NOTCH_WIDTH_DEFAULT)
    expect(sanitizeNotchWidth(undefined)).toBe(NOTCH_WIDTH_DEFAULT)
  })
})
