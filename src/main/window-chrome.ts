import type { BrowserWindowConstructorOptions } from 'electron'
import { TABBAR_HEIGHT_PX, TRAFFIC_LIGHT_X, trafficLightY } from '@shared/window-chrome-metrics'

/**
 * The window-frame options that only mean something on macOS.
 *
 * `titleBarStyle: 'hiddenInset'` + `trafficLightPosition` hide the title bar and draw the traffic
 * lights inside the web contents — that is what our tab bar's left padding is reserved for. Both
 * are macOS-only Electron options; on Windows and Linux the window keeps its native frame either
 * way, so this changes nothing there and simply stops claiming a shape those platforms don't have
 * (issue #564, where the renderer reserved the traffic-light space on Windows regardless).
 *
 * The lights' `y` is DERIVED from the bar height (`@shared/window-chrome-metrics`), not typed
 * here: it was a literal 15 for a 44px bar, and shrinking the bar to Chrome's proportions would
 * have left them hanging below its centre. `barHeight` is the user's resolved
 * `settings.tabBarHeight`; the same function answers the live re-centre when the setting changes
 * (`BrowserWindow.setWindowButtonPosition`, macOS only).
 */
export function trafficLightPositionFor(barHeight: number = TABBAR_HEIGHT_PX): { x: number; y: number } {
  return { x: TRAFFIC_LIGHT_X, y: trafficLightY(barHeight) }
}

export function macTitleBarOptions(
  platform: NodeJS.Platform,
  barHeight: number = TABBAR_HEIGHT_PX
): Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'trafficLightPosition'> {
  if (platform !== 'darwin') return {}
  return {
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: trafficLightPositionFor(barHeight)
  }
}
