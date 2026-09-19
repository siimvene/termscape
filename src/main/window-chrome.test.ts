import { describe, expect, it } from 'vitest'
import { macTitleBarOptions, trafficLightPositionFor } from './window-chrome'
import {
  TABBAR_HEIGHT_MAX_PX,
  TABBAR_HEIGHT_MIN_PX,
  TABBAR_HEIGHT_PX,
  TRAFFIC_LIGHT_DIAMETER_PX,
  resolveTabBarHeight,
  trafficLightY
} from '@shared/window-chrome-metrics'

describe('macTitleBarOptions', () => {
  it('hides the title bar and centres the traffic lights in the tab bar on macOS', () => {
    expect(macTitleBarOptions('darwin')).toEqual({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: trafficLightY() }
    })
  })

  it('puts the lights on the bar\'s vertical centre, whatever the bar height is', () => {
    // Electron takes the light's TOP edge, so centre = y + radius must equal half the bar.
    const y = trafficLightY()
    const centre = y + TRAFFIC_LIGHT_DIAMETER_PX / 2
    expect(Math.abs(centre - TABBAR_HEIGHT_PX / 2)).toBeLessThanOrEqual(0.5)
    // The literal it replaced: 15 was right for 44px and only for 44px.
    expect(trafficLightY(44)).toBe(16)
    expect(trafficLightY(36)).toBe(12)
  })

  it("follows the user's bar height, at creation and for the live re-centre", () => {
    expect(macTitleBarOptions('darwin', 44).trafficLightPosition).toEqual({ x: 16, y: 16 })
    expect(macTitleBarOptions('darwin', 28).trafficLightPosition).toEqual({ x: 16, y: 8 })
    // The live path (`setWindowButtonPosition`) and the constructor path are one function.
    expect(trafficLightPositionFor(44)).toEqual(macTitleBarOptions('darwin', 44).trafficLightPosition)
  })

  // Issue #564: both options are macOS-only. Claiming them elsewhere is what made the renderer's
  // 86px traffic-light reservation look justified on a window that has a native frame.
  it('claims neither on Windows or Linux', () => {
    expect(macTitleBarOptions('win32')).toEqual({})
    expect(macTitleBarOptions('linux')).toEqual({})
  })
})

describe('resolveTabBarHeight', () => {
  it('answers the default for anything that is not a finite number (every pre-feature settings.json)', () => {
    for (const v of [undefined, null, '', '40', Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      expect(resolveTabBarHeight(v)).toBe(TABBAR_HEIGHT_PX)
    }
  })

  it('clamps and rounds a number, so a hand-edited value can never hide the bar or strand the lights', () => {
    expect(resolveTabBarHeight(44)).toBe(44)
    expect(resolveTabBarHeight(43.6)).toBe(44)
    expect(resolveTabBarHeight(4)).toBe(TABBAR_HEIGHT_MIN_PX)
    expect(resolveTabBarHeight(400)).toBe(TABBAR_HEIGHT_MAX_PX)
    // The floor keeps the 12px lights an 8px margin; the lights are never placed above the bar.
    expect(trafficLightY(TABBAR_HEIGHT_MIN_PX)).toBeGreaterThanOrEqual(8)
  })
})
