/**
 * The one place the tab bar's height is a NUMBER.
 *
 * Two things depend on it from opposite sides of the process boundary and cannot read each other:
 * the stylesheet (`--tabbar-h` in `renderer/styles.css`, which every top-anchored panel, the
 * kanban overlay and the usage popover position against) and the main process, which has to put
 * the macOS traffic lights on the bar's vertical centre (`trafficLightPosition` — a bar that gets
 * shorter while the lights stay put looks broken at once). CSS cannot import a constant and main
 * cannot read a stylesheet, so the number lives here and `renderer/styles.tabbar.test.ts` pins the
 * stylesheet's token to it.
 */

/** DEFAULT height of `.tabbar`, in CSS px. Chrome's own strip is ~40, and so is this: 36 was a
 *  touch tighter than the reference and read as cramped once the tabs carried full names. The
 *  user may change it (`settings.tabBarHeight`, Settings → Appearance); every reader goes through
 *  `resolveTabBarHeight`, and this constant is what the stylesheet's `--tabbar-h` token carries so
 *  a renderer that has not applied the setting yet draws the default. */
export const TABBAR_HEIGHT_PX = 40

/** Clamp bounds for the hand-editable setting. 28 leaves the 12px traffic lights an 8px margin;
 *  above 64 the bar stops reading as a tab strip and starts eating the canvas. */
export const TABBAR_HEIGHT_MIN_PX = 28
export const TABBAR_HEIGHT_MAX_PX = 64

/**
 * Resolve a hand-editable settings value to a bar height. Anything non-numeric — absent (every
 * pre-feature settings.json), NaN, Infinity, a string — is the default; numbers are rounded to a
 * whole pixel (a fractional bar height blurs every 1px divider under it) and clamped, so a wild
 * value can never hide the bar or push the traffic lights off it.
 */
export function resolveTabBarHeight(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return TABBAR_HEIGHT_PX
  return Math.min(TABBAR_HEIGHT_MAX_PX, Math.max(TABBAR_HEIGHT_MIN_PX, Math.round(value)))
}

/** The macOS traffic lights are 12px discs (measured on a 2x capture: 24 device px). */
export const TRAFFIC_LIGHT_DIAMETER_PX = 12

/** Distance from the window's left edge to the first light. Unchanged from the 44px bar. */
export const TRAFFIC_LIGHT_X = 16

/**
 * The `y` that centres the lights inside a bar of the given height. Electron takes the top edge
 * of the light, not its centre, hence the diameter subtraction. Rounded down, never up: a light
 * one pixel high in a bar reads as sitting in the bar; one pixel low reads as hanging off it.
 */
export function trafficLightY(barHeight: number = TABBAR_HEIGHT_PX): number {
  return Math.floor((barHeight - TRAFFIC_LIGHT_DIAMETER_PX) / 2)
}
