// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { maximizeNodeToRect, restoreMaximizedNode, type CanvasNode } from '../state/workspace'
import { measureMaximizeInsets } from './maximizeInsets'
import { maximizeTargetRect } from './nodeMaximize'
import { nodeFitRect, viewportForNodeFocus } from './nodeFocus'

const box = { left: 100, right: 1300, top: 36, bottom: 836, width: 1200, height: 800 }
function addChrome() {
  for (const [className, left, top, right, bottom] of [
    ['sessions-sidebar--pinned', 114, 90, 422, 780],
    ['controls-cluster', 950, 50, 1286, 84],
    ['dock', 500, 770, 900, 822]
  ] as const) {
    const el = document.createElement('div')
    el.className = className
    el.getBoundingClientRect = () =>
      ({ left, top, right, bottom, width: right - left, height: bottom - top }) as DOMRect
    document.body.append(el)
  }
}
const ordinary = (): CanvasNode => ({
  id: 'term', type: 'terminal', position: { x: 40, y: 60 }, width: 660, height: 400,
  data: { title: 'Terminal', color: '#fff', group: null }
}) as CanvasNode

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('Canvas focus policy (#743, #711)', () => {
  it.each([undefined, 0.7345, 2])('reserves chrome only while maximized (keepZoom=%s)', (zoom) => {
    addChrome()
    const node = ordinary()
    const originalRect = nodeFitRect(node, [node])!
    const camera = { x: -123, y: 87, zoom: zoom ?? 1 }
    const target = maximizeTargetRect(camera, box.width, box.height, 24, measureMaximizeInsets(box))!
    const maximized = maximizeNodeToRect([node], node.id, target)
    const restored = restoreMaximizedNode(maximized, node.id)[0]
    // Fork contract (.claude/rules/canvas.md, "insets is measurePinnedInsets(box) for EVERY node";
    // a0c86e92 / 1d7a7da3): normal and restored nodes centre in the band the PINNED side panels
    // leave free, never in the whole pane (upstream's shape, which parks them half under a pinned
    // sessions sidebar). Pinned insets are horizontal only: left=322 → x centre 322 + 878/2 = 761;
    // the controls cluster and dock are NOT reserved here, so y stays at the pane centre, 400.
    for (const candidate of [node, restored]) {
      const rect = nodeFitRect(candidate, [candidate])!
      expect(rect).toEqual(originalRect)
      const focus = viewportForNodeFocus(candidate, rect, box, zoom)!
      expect((rect.x + rect.width / 2) * focus.zoom + focus.x).toBeCloseTo(761)
      expect((rect.y + rect.height / 2) * focus.zoom + focus.y).toBeCloseTo(400)
      // Clear of the pinned sidebar (right edge 422 on screen, box.left = 100) whenever the node
      // fits the free band at all; at keepZoom=2 it is 1320px wide and cannot clear an 878 band.
      if (rect.width * focus.zoom <= box.width - 322) {
        expect(rect.x * focus.zoom + focus.x + box.left).toBeGreaterThanOrEqual(422 - 1e-8)
      }
      if (zoom !== undefined) expect(focus.zoom).toBe(zoom)
    }
    // Only PINNED panels count: unpin the sidebar and the ordinary node centres in the whole pane
    // again (upstream's ultrawide concern), while the unpinned chrome is still in the DOM.
    document.querySelector('.sessions-sidebar--pinned')!.className = 'sessions-sidebar'
    {
      const rect = nodeFitRect(node, [node])!
      const focus = viewportForNodeFocus(node, rect, box, zoom)!
      expect((rect.x + rect.width / 2) * focus.zoom + focus.x).toBeCloseTo(600)
      expect((rect.y + rect.height / 2) * focus.zoom + focus.y).toBeCloseTo(400)
    }
    document.querySelector('.sessions-sidebar')!.className = 'sessions-sidebar--pinned'

    const rect = nodeFitRect(maximized[0], maximized)!
    const focus = viewportForNodeFocus(maximized[0], rect, box, zoom)!
    // Measured reservations: left=322, top=32, bottom=50. Test actual screen placement.
    expect((rect.x + rect.width / 2) * focus.zoom + focus.x).toBeCloseTo(761)
    expect((rect.y + rect.height / 2) * focus.zoom + focus.y).toBeCloseTo(391)
    expect(rect.y * focus.zoom + focus.y + box.top).toBeGreaterThanOrEqual(92 - 1e-8)
    expect((rect.y + rect.height) * focus.zoom + focus.y + box.top).toBeLessThanOrEqual(762 + 1e-8)
    if (zoom !== undefined) {
      expect(focus.zoom).toBe(zoom)
      expect(focus.x).toBeCloseTo(camera.x)
      expect(focus.y).toBeCloseTo(camera.y)
    }
  })
})

describe('ordinary focus without a pinned panel (#854)', () => {
  it.each([undefined, 0.7345, 2])('centres in the whole pane (keepZoom=%s)', (zoom) => {
    // Only the controls cluster and the dock: nothing pinned at the sides.
    for (const [className, left, top, right, bottom] of [
      ['controls-cluster', 950, 50, 1286, 84],
      ['dock', 500, 770, 900, 822]
    ] as const) {
      const el = document.createElement('div')
      el.className = className
      el.getBoundingClientRect = () =>
        ({ left, top, right, bottom, width: right - left, height: bottom - top }) as DOMRect
      document.body.append(el)
    }
    const node = ordinary()
    const rect = nodeFitRect(node, [node])!
    const focus = viewportForNodeFocus(node, rect, box, zoom)!
    expect((rect.x + rect.width / 2) * focus.zoom + focus.x).toBeCloseTo(600)
    expect((rect.y + rect.height / 2) * focus.zoom + focus.y).toBeCloseTo(400)
  })
})
