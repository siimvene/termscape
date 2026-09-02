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
  /**
   * `NSScreen.safeAreaInsets.top` of the primary display in points (src/main/notch-safe-area.ts),
   * when the probe answered. THE decisive signal: > 0 is a notch, 0 is not, regardless of how tall
   * macOS draws the menu bar. `null`/absent ⇒ fall back to the strip-height heuristic below.
   */
  safeAreaTop?: number | null
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
 * FALLBACK notch heuristic, used only when the safe-area probe (`safeAreaTop`) did not answer:
 * the top strip (menu bar, in logical points) a built-in panel must reserve to count as notched.
 *
 * Why it is a fallback and not the rule — three heuristics have now shipped and each was wrong on
 * some real machine, which is the whole argument for asking AppKit instead (notch-safe-area.ts):
 * - absolute 32 pt: missed a notched 15" Air's scaled modes, whose strip is 31 and 28 pt (#508);
 * - ratio ≥ 0.03 of display height: assumed the notch is a fixed share of its panel — true per
 *   panel, false between panels; the 16" MBP's 33/1117 = 0.0295 read as notchless at its DEFAULT
 *   scaling and the HUD drew the floating pill under the menu bar [measured 2026-09-02 via
 *   NSScreen: frame 1728x1117, inset 33, safeAreaInsets.top 32];
 * - absolute 27 pt (this constant): separates pre-Tahoe notchless menu bars (24–25 pt) from
 *   notched strips (28–37 pt measured), but macOS Tahoe draws a TALLER notchless menu bar
 *   (31 pt reported on a notchless M1 Air — consort finding 2026-09-02), which lands inside the
 *   notched range. No height threshold can be right on both macOS 15 and 26.
 * When the probe fails (non-darwin, osascript missing) this is what remains; its misdetection now
 * costs a fused capsule on a notchless Tahoe menu bar, never a pill hidden behind a notch, and the
 * renderer no longer pads the notchless pill by the notch width, so the other direction costs a
 * floating pill in the wrong place.
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
  // The probe decides when it answered; the strip-height heuristic only fills its absence. An
  // internal panel is required either way — notches exist only on built-in displays, and a probe
  // of screens[0] while an external is primary describes that external (safe area 0 ⇒ notchless).
  const probed = typeof input.safeAreaTop === 'number' && Number.isFinite(input.safeAreaTop)
  const hasNotch =
    input.internal && (probed ? (input.safeAreaTop as number) > 0 : inset >= NOTCH_BAR_MIN_PT)
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
