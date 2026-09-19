import { describe, it, expect } from 'vitest'
import {
  hudGeometry,
  hudPlacement,
  HUD_EDGE_MARGIN,
  HUD_PANEL_WIDTH,
  NOTCH_BAR_FLOOR,
  HUD_WINDOW_HEIGHT,
  PILL_TOP_GAP,
  type HudGeometryInput,
  type HudPlacementInput
} from './notch-hud-geometry'
import type { NotchAlign } from '../shared/notch-hud'

/** A display, described the way Electron reports one: full bounds plus a menu-bar-shortened workArea. */
function display(width: number, height: number, menuBar: number, internal: boolean): HudGeometryInput {
  return {
    bounds: { x: 0, y: 0, width, height },
    workArea: { x: 0, y: menuBar, width, height: height - menuBar },
    internal,
    notchWidth: 168,
    offsetY: 0
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

  it('grows the window by a DOWNWARD offset so a lowered panel is not clipped, and by nothing else', () => {
    const base = hudGeometry(display(1710, 1112, 37, true)).height
    expect(hudGeometry({ ...display(1710, 1112, 37, true), offsetY: 120 }).height).toBe(base + 120)
    // Raising needs no extra room; the historical height is kept bit-for-bit.
    expect(hudGeometry({ ...display(1710, 1112, 37, true), offsetY: -30 }).height).toBe(base)
    // The display edge still wins.
    expect(hudGeometry({ ...display(1024, 300, 24, false), offsetY: 240 }).height).toBe(300)
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
  it('a hidden menu bar (fullscreen app) keeps the strip as tall as the probed notch', () => {
    const g = hudGeometry({ ...display(1728, 1117, 0, true), safeAreaTop: 32 })
    expect(g.hasNotch).toBe(true)
    expect(g.bar).toBe(32)
    // …while a notchless probe leaves the bar at its floor.
    expect(hudGeometry({ ...display(1440, 900, 0, true), safeAreaTop: 0 }).bar).toBe(NOTCH_BAR_FLOOR)
  })
  it('null / undefined / NaN probe ⇒ the strip-height heuristic', () => {
    expect(hudGeometry({ ...display(1728, 1117, 33, true), safeAreaTop: null }).hasNotch).toBe(true)
    expect(hudGeometry({ ...display(1440, 900, 24, true), safeAreaTop: undefined }).hasNotch).toBe(false)
    expect(hudGeometry({ ...display(1728, 1117, 33, true), safeAreaTop: Number.NaN }).hasNotch).toBe(true)
  })
})

// ---- Capsule + panel placement ------------------------------------------------------------

/** A placement query over a 1710-wide notched display with a 37 px strip (15" Air default). */
function place(over: Partial<HudPlacementInput> = {}): HudPlacementInput {
  return {
    width: 1710,
    bar: 37,
    notchWidth: 168,
    notchCenterX: 855,
    hasNotch: true,
    align: 'center',
    offsetY: 0,
    ...over
  }
}

describe('hudPlacement — the shape (fused vs pill) per display × side × offset', () => {
  it('center on a notched display at offset 0 is the historical fused layout, bit-for-bit', () => {
    const p = hudPlacement(place())
    expect(p.fused).toBe(true)
    expect(p.capsuleTop).toBe(0)
    // Right edge pinned to the notch's right edge, as the old CSS computed it.
    expect(p.anchor).toBe('right')
    expect(p.capsuleX).toBe(855 + 84)
    // Expanded: centered under the notch.
    expect(p.panelLeft).toBe(855 - HUD_PANEL_WIDTH / 2)
    expect(p.panelWidth).toBe(HUD_PANEL_WIDTH)
  })

  it('a negative offset cannot raise the fused capsule above the top edge — it stays fused at 0', () => {
    const p = hudPlacement(place({ offsetY: -48 }))
    expect(p.fused).toBe(true)
    expect(p.capsuleTop).toBe(0)
  })

  it('a positive offset detaches the centered capsule into a pill hanging below the notch', () => {
    // A detached surface with square top corners is the "black box below the menu bar" field bug.
    const p = hudPlacement(place({ offsetY: 20 }))
    expect(p.fused).toBe(false)
    expect(p.anchor).toBe('center')
    expect(p.capsuleX).toBe(855)
    expect(p.capsuleTop).toBe(37 + PILL_TOP_GAP + 20)
  })

  it.each<NotchAlign>(['left', 'right'])('%s on a notched display is a pill at that edge, never fused', (align) => {
    const p = hudPlacement(place({ align }))
    expect(p.fused).toBe(false)
    expect(p.anchor).toBe(align)
    expect(p.capsuleX).toBe(align === 'left' ? HUD_EDGE_MARGIN : 1710 - HUD_EDGE_MARGIN)
    expect(p.capsuleTop).toBe(37 + PILL_TOP_GAP)
  })

  it('on a notchless display every side is a pill below the strip, and center is a centered pill', () => {
    const p = hudPlacement(place({ hasNotch: false, bar: 24 }))
    expect(p.fused).toBe(false)
    expect(p.anchor).toBe('center')
    expect(p.capsuleX).toBe(855)
    expect(p.capsuleTop).toBe(24 + PILL_TOP_GAP)
    expect(hudPlacement(place({ hasNotch: false, bar: 24, align: 'left' })).anchor).toBe('left')
    expect(hudPlacement(place({ hasNotch: false, bar: 24, align: 'right' })).anchor).toBe('right')
  })
})

describe('hudPlacement — vertical offset', () => {
  it('moves a pill down by the offset and up by a negative one', () => {
    expect(hudPlacement(place({ align: 'left', offsetY: 100 })).capsuleTop).toBe(37 + PILL_TOP_GAP + 100)
    expect(hudPlacement(place({ align: 'left', offsetY: -20 })).capsuleTop).toBe(37 + PILL_TOP_GAP - 20)
  })

  it('never raises a pill above the display top edge (there is nothing above it)', () => {
    expect(hudPlacement(place({ align: 'left', offsetY: -48 })).capsuleTop).toBe(0)
    expect(hudPlacement(place({ hasNotch: false, bar: 24, offsetY: -48 })).capsuleTop).toBe(0)
  })

  it('does not change the horizontal anchor', () => {
    const a = hudPlacement(place({ align: 'right' }))
    const b = hudPlacement(place({ align: 'right', offsetY: 150 }))
    expect([b.anchor, b.capsuleX, b.panelLeft]).toEqual([a.anchor, a.capsuleX, a.panelLeft])
  })
})

describe('hudPlacement — the expanded panel stays on screen', () => {
  const inside = (p: { panelLeft: number; panelWidth: number }, width: number): boolean =>
    p.panelLeft >= 0 && p.panelLeft + p.panelWidth <= width

  it('opens flush with the margin on the left, and ends at the margin on the right', () => {
    expect(hudPlacement(place({ align: 'left' })).panelLeft).toBe(HUD_EDGE_MARGIN)
    expect(hudPlacement(place({ align: 'right' })).panelLeft).toBe(1710 - HUD_EDGE_MARGIN - HUD_PANEL_WIDTH)
  })

  it.each<NotchAlign>(['left', 'center', 'right'])('is fully visible at %s on every display width we ship to', (align) => {
    for (const width of [1024, 1280, 1440, 1512, 1710, 1728, 2560, 3008]) {
      const p = hudPlacement(place({ align, width, notchCenterX: Math.round(width / 2) }))
      expect(inside(p, width), `${align} @ ${width}`).toBe(true)
      expect(inside(hudPlacement(place({ align, width, notchCenterX: Math.round(width / 2), hasNotch: false })), width)).toBe(true)
    }
  })

  it('on a display narrower than the panel plus its margin, hugs the CHOSEN edge rather than running off it', () => {
    const width = HUD_PANEL_WIDTH + 10
    // A bare clamp would have dropped the margin on the far side (left panel flush RIGHT).
    expect(hudPlacement(place({ align: 'left', width, notchCenterX: 205 })).panelLeft).toBe(0)
    expect(hudPlacement(place({ align: 'right', width, notchCenterX: 205 })).panelLeft).toBe(10)
    // Narrower than the panel itself: still on screen at 0, never negative.
    expect(hudPlacement(place({ align: 'right', width: 300, notchCenterX: 150 })).panelLeft).toBe(0)
    expect(hudPlacement(place({ align: 'center', width: 300, notchCenterX: 150 })).panelLeft).toBe(0)
  })
})
