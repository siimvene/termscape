// Pure, Electron-free geometry for the macOS Notch HUD (docs/notch-hud.md).
//
// Split out of notch-hud.ts so vitest can cover notch DETECTION without an Electron runtime: the
// controller reads `screen.getPrimaryDisplay()` and hands the plain numbers here. Everything the
// HUD window and its renderer position themselves by is decided in this one function.

/** A rectangle in Electron's logical (point) coordinate space. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface HudGeometryInput {
  /** display.bounds — the full display, menu bar included. */
  bounds: Rect
  /** display.workArea — excludes the menu bar / notch strip. */
  workArea: Rect
  /** display.internal — a notch only ever exists on a built-in panel. */
  internal: boolean
  /** Already-sanitized settings.notchWidth. */
  notchWidth: number
}

export interface HudGeometry {
  x: number
  y: number
  width: number
  height: number
  /** Height of the fused top strip (menu bar / notch), floored so the mascots always fit. */
  bar: number
  notchWidth: number
  notchCenterX: number
  hasNotch: boolean
}

/** Minimum strip height when there is no physical notch (menu-bar height floor). */
export const NOTCH_BAR_FLOOR = 24

/**
 * Notch detection threshold: the top strip (menu bar, in logical points) a built-in panel must
 * reserve to count as notched.
 *
 * The two populations do not overlap, which is what makes an absolute threshold safe here:
 * - NOTCHLESS panels reserve a fixed menu bar of 24 pt (25 on a few older/larger fonts), at every
 *   scaling mode — the menu bar is defined in points, not pixels.
 * - NOTCHED panels reserve a strip as tall as the notch, which SHRINKS in points as the scaled
 *   resolution grows but never gets near 24: measured 37 (15" Air / 14" MBP at default),
 *   33 (16" MBP at its default 1728x1117), 31 (15" Air at 1440x932), 28 (15" Air at 1280x829).
 * So anything ≥ 27 pt on an internal panel is a notch; anything ≤ 25 is a plain menu bar.
 *
 * History, because both earlier shapes shipped broken: the first cut was an absolute 32, which
 * the 31/28 scaled modes fell under (issue #508). The second cut was a RATIO of display height
 * (≥ 0.03) on the theory that the notch is a fixed SHARE of its panel — true per panel, but the
 * share differs BETWEEN panels: the 16" MBP's is 33/1117 = 0.0295, so at its default scaling it
 * read as notchless and the HUD drew its floating fallback pill under the menu bar [measured
 * 2026-09-02 via NSScreen: frame 1728x1117, visibleFrame inset 33, safeAreaInsets.top 32]. The
 * real signal is `NSScreen.safeAreaInsets.top`, which Electron does not expose; the strip height
 * is the closest proxy, and 27 sits in the gap between the two populations.
 */
export const NOTCH_BAR_MIN_PT = 27

/** Total window height ABOVE the top strip — sized to the EXPANDED box (we never resize the frame;
 *  the renderer scales a CSS transform). The strip itself is added on top, because both layouts
 *  start below it: the fused capsule reserves it as padding, the floating pill clears it. */
export const HUD_WINDOW_HEIGHT = 460

/**
 * Decide where the HUD window sits and which of the two layouts its renderer should draw.
 *
 * The window always spans the display's full width at its very top edge (`bounds`, not `workArea`
 * — painting OVER the menu bar is the point, see `enableLargerThanScreen` in notch-hud.ts).
 */
export function hudGeometry(input: HudGeometryInput): HudGeometry {
  const b = input.bounds
  const inset = input.workArea.y - b.y
  const bar = Math.max(NOTCH_BAR_FLOOR, inset)
  // A physical notch requires a built-in panel whose reserved strip is a notch-sized SHARE of it.
  const hasNotch = input.internal && inset >= NOTCH_BAR_MIN_PT
  return {
    x: b.x,
    y: b.y,
    width: b.width,
    height: Math.min(bar + HUD_WINDOW_HEIGHT, b.height),
    bar,
    notchWidth: input.notchWidth,
    notchCenterX: Math.round(b.width / 2),
    hasNotch
  }
}
