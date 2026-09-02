import { describe, it, expect } from 'vitest'
import { hudGeometry, NOTCH_BAR_FLOOR, HUD_WINDOW_HEIGHT, type HudGeometryInput } from './notch-hud-geometry'

/** A display, described the way Electron reports one: full bounds plus a menu-bar-shortened workArea. */
function display(width: number, height: number, menuBar: number, internal: boolean): HudGeometryInput {
  return {
    bounds: { x: 0, y: 0, width, height },
    workArea: { x: 0, y: menuBar, width, height: height - menuBar },
    internal,
    notchWidth: 168
  }
}

describe('hudGeometry — notch detection across panels and scaling modes (issue #508, 16" regression)', () => {
  // Every one of these is a notched panel. The absolute-32px first cut answered true only for the
  // 37s (issue #508, reporter at 1440x932); the ratio second cut (≥ 0.03 of height) answered false
  // for the 16" MBP at its DEFAULT scaling, whose strip is 33/1117 = 0.0295 — measured on the owner's
  // machine 2026-09-02 (NSScreen frame 1728x1117, top inset 33, safeAreaInsets.top 32).
  it.each([
    ['15" Air, default 1710x1112', 1710, 1112, 37],
    ['15" Air, scaled 1440x932', 1440, 932, 31],
    ['15" Air, scaled 1280x829', 1280, 829, 28],
    ['14" MBP, default 1512x982', 1512, 982, 37],
    ['16" MBP, default 1728x1117 (measured 33, below the old 0.03 ratio)', 1728, 1117, 33],
    ['16" MBP, scaled 2056x1329', 2056, 1329, 28]
  ])('detects the notch on %s', (_label, w, h, bar) => {
    expect(hudGeometry(display(w, h, bar, true)).hasNotch).toBe(true)
  })

  it.each([
    ['1080p external', 1920, 1080, 24, false],
    ['1440p external', 2560, 1440, 24, false],
    ['scaled 4K external', 3008, 1692, 24, false],
    ['pre-notch 13" MacBook internal', 1440, 900, 24, true],
    ['pre-notch MacBook, scaled up', 1680, 1050, 24, true],
    ['pre-notch MacBook with the taller 25 pt menu bar', 1440, 900, 25, true]
  ])('reports notchless on %s', (_label, w, h, bar, internal) => {
    expect(hudGeometry(display(w, h, bar, internal)).hasNotch).toBe(false)
  })

  it('a notchless BUILT-IN panel at a low scaled resolution stays notchless (the ratio cut got this wrong)', () => {
    // 24/640 = 0.0375 cleared the old ratio; the strip is still a plain 24 pt menu bar.
    expect(hudGeometry(display(1024, 640, 24, true)).hasNotch).toBe(false)
  })

  it('never reports a notch on an external display, whatever its menu bar measures', () => {
    // Notches do not exist on external panels; `internal` is the second lock.
    expect(hudGeometry(display(1710, 1112, 37, false)).hasNotch).toBe(false)
  })

  it('reports notchless when the menu bar is hidden entirely', () => {
    expect(hudGeometry(display(1710, 1112, 0, true)).hasNotch).toBe(false)
  })
})

describe('hudGeometry — window placement', () => {
  it('spans the display full width from its very top edge, not the work area', () => {
    const g = hudGeometry({ ...display(1710, 1112, 37, true), bounds: { x: -1710, y: -100, width: 1710, height: 1112 } })
    expect({ x: g.x, y: g.y, width: g.width }).toEqual({ x: -1710, y: -100, width: 1710 })
  })

  it('reserves the top strip ON TOP of the expanded box, so neither layout clips', () => {
    // Both layouts start below the strip: the fused capsule pads it, the pill clears it.
    expect(hudGeometry(display(1710, 1112, 37, true)).height).toBe(37 + HUD_WINDOW_HEIGHT)
  })

  it('never exceeds the display height', () => {
    expect(hudGeometry(display(1024, 300, 24, false)).height).toBe(300)
  })

  it('floors a short menu bar so the mascots always have room', () => {
    expect(hudGeometry(display(1920, 1080, 12, false)).bar).toBe(NOTCH_BAR_FLOOR)
  })

  it('centres the notch anchor on the display', () => {
    expect(hudGeometry(display(1711, 1112, 37, true)).notchCenterX).toBe(856)
  })

  it('passes the sanitized notch width through untouched', () => {
    expect(hudGeometry({ ...display(1710, 1112, 37, true), notchWidth: 220 }).notchWidth).toBe(220)
  })
})

describe('hudGeometry — the safe-area probe decides when it answered (heuristic only as fallback)', () => {
  it('a notchless Tahoe menu bar (31 pt, above the heuristic) with safe area 0 is NOT a notch', () => {
    // The consort finding: macOS 26 draws a taller notchless menu bar, inside the notched range.
    expect(hudGeometry({ ...display(1440, 900, 31, true), safeAreaTop: 0 }).hasNotch).toBe(false)
  })
  it('a probed notch wins even when the strip is below the heuristic', () => {
    expect(hudGeometry({ ...display(1728, 1117, 26, true), safeAreaTop: 32 }).hasNotch).toBe(true)
  })
  it('the probe never makes an external display notched', () => {
    expect(hudGeometry({ ...display(1728, 1117, 33, false), safeAreaTop: 32 }).hasNotch).toBe(false)
  })
  it('null / undefined / NaN probe ⇒ the strip-height heuristic', () => {
    expect(hudGeometry({ ...display(1728, 1117, 33, true), safeAreaTop: null }).hasNotch).toBe(true)
    expect(hudGeometry({ ...display(1440, 900, 24, true), safeAreaTop: undefined }).hasNotch).toBe(false)
    expect(hudGeometry({ ...display(1728, 1117, 33, true), safeAreaTop: Number.NaN }).hasNotch).toBe(true)
  })
})
