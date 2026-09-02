import { describe, it, expect } from 'vitest'
import { getViewportForBounds } from '@xyflow/system'
import {
  FIT_NODE_OPTIONS,
  absolutePosition,
  isMeasured,
  measuredFitRect,
  nodeFitRect,
  viewportForRect,
  viewportForRectPadded
} from './nodeFocus'
import type { FocusableNode } from './nodeFocus'

const term = (over: Partial<FocusableNode> = {}): FocusableNode => ({
  id: 'n1',
  position: { x: 4000, y: 3000 },
  width: 600,
  height: 400,
  ...over
})

describe('absolutePosition', () => {
  it('returns the position of a top-level node unchanged', () => {
    expect(absolutePosition(term(), [term()])).toEqual({ x: 4000, y: 3000 })
  })

  it('adds the group origin for a child (what node PLACEMENT needs)', () => {
    // The regression this guards: Duplicate / Branch / Transfer positioned the new node from the
    // source's raw `position`, which for a grouped node is relative to its frame — so a copy made
    // top-level landed the group's own x/y away from the node it came from.
    const group: FocusableNode = { id: 'g', position: { x: 5000, y: 200 } }
    const child = term({ id: 'c', position: { x: 50, y: 60 }, parentId: 'g' })
    expect(absolutePosition(child, [group, child])).toEqual({ x: 5050, y: 260 })
  })

  it('answers even when the node has no size at all', () => {
    const n: FocusableNode = { id: 'x', position: { x: 12, y: 34 } }
    expect(absolutePosition(n, [n])).toEqual({ x: 12, y: 34 })
    expect(nodeFitRect(n, [n])).toBeNull()
  })

  it('stops on a parent cycle instead of looping', () => {
    const a: FocusableNode = { id: 'a', position: { x: 10, y: 10 }, parentId: 'b' }
    const b: FocusableNode = { id: 'b', position: { x: 20, y: 20 }, parentId: 'a' }
    expect(absolutePosition(a, [a, b])).toEqual({ x: 30, y: 30 })
  })
})

describe('nodeFitRect', () => {
  it('reads the persisted size of a node React Flow has not measured yet', () => {
    // The regression this guards: a node loaded a tick ago has NO `measured` — and React
    // Flow's own fitView drops such nodes, collapsing its bounds to the canvas origin.
    expect(nodeFitRect(term(), [term()])).toEqual({ x: 4000, y: 3000, width: 600, height: 400 })
  })

  it('prefers the measured size once React Flow has one (a live-resized terminal)', () => {
    const n = term({ measured: { width: 640, height: 512 } })
    expect(nodeFitRect(n, [n])).toEqual({ x: 4000, y: 3000, width: 640, height: 512 })
  })

  it('resolves a grouped node to its ABSOLUTE position', () => {
    const group: FocusableNode = {
      id: 'g',
      position: { x: 5000, y: 200 },
      width: 1400,
      height: 900
    }
    const child = term({ id: 'c', position: { x: 50, y: 60 }, parentId: 'g' })
    expect(nodeFitRect(child, [group, child])).toEqual({
      x: 5050,
      y: 260,
      width: 600,
      height: 400
    })
  })

  it('resolves a nested group chain', () => {
    const outer: FocusableNode = { id: 'o', position: { x: 1000, y: 1000 }, width: 100, height: 100 }
    const inner: FocusableNode = {
      id: 'i',
      position: { x: 100, y: 200 },
      width: 100,
      height: 100,
      parentId: 'o'
    }
    const child = term({ id: 'c', position: { x: 10, y: 20 }, parentId: 'i' })
    expect(nodeFitRect(child, [outer, inner, child])).toMatchObject({ x: 1110, y: 1220 })
  })

  it('survives a broken parent chain (missing parent, self-parent, cycle)', () => {
    const orphan = term({ parentId: 'gone' })
    expect(nodeFitRect(orphan, [orphan])).toMatchObject({ x: 4000, y: 3000 })

    const selfish = term({ id: 's', parentId: 's' })
    expect(nodeFitRect(selfish, [selfish])).toMatchObject({ x: 4000, y: 3000 })

    const a: FocusableNode = { id: 'a', position: { x: 1, y: 1 }, width: 10, height: 10, parentId: 'b' }
    const b: FocusableNode = { id: 'b', position: { x: 2, y: 2 }, width: 10, height: 10, parentId: 'a' }
    expect(nodeFitRect(a, [a, b])).not.toBeNull()
  })

  it('falls back to the style size, then gives up rather than guessing', () => {
    const styled: FocusableNode = {
      id: 'n',
      position: { x: 10, y: 20 },
      style: { width: 300, height: 150 }
    }
    expect(nodeFitRect(styled, [styled])).toEqual({ x: 10, y: 20, width: 300, height: 150 })

    const sizeless: FocusableNode = { id: 'n', position: { x: 10, y: 20 } }
    expect(nodeFitRect(sizeless, [sizeless])).toBeNull()
    // A zero-size node would produce the very origin jump we are fixing.
    expect(nodeFitRect({ id: 'n', position: { x: 5, y: 5 }, width: 0, height: 0 }, [])).toBeNull()
  })
})

describe('viewportForRect', () => {
  it('centres the node in the container instead of the canvas origin', () => {
    const vp = viewportForRect({ x: 4000, y: 3000, width: 600, height: 400 }, 1280, 900)
    // Same maths React Flow's fitView would have used for a MEASURED node.
    expect(vp).toEqual(
      getViewportForBounds(
        { x: 4000, y: 3000, width: 600, height: 400 },
        1280,
        900,
        FIT_NODE_OPTIONS.minZoom,
        FIT_NODE_OPTIONS.maxZoom,
        FIT_NODE_OPTIONS.padding
      )
    )
    // The node's centre lands in the middle of the container…
    expect(vp!.x + 4300 * vp!.zoom).toBeCloseTo(640, 0)
    expect(vp!.y + 3200 * vp!.zoom).toBeCloseTo(450, 0)
    // …which is emphatically NOT where an empty fit-set puts it (the bug: 640/450 at maxZoom,
    // i.e. the canvas origin parked in the middle of the screen).
    expect(vp!.x).not.toBeCloseTo(640, 0)
  })

  it('clamps the zoom for tiny and huge nodes', () => {
    expect(viewportForRect({ x: 0, y: 0, width: 20, height: 20 }, 1280, 900)!.zoom).toBe(
      FIT_NODE_OPTIONS.maxZoom
    )
    expect(viewportForRect({ x: 0, y: 0, width: 40000, height: 40000 }, 1280, 900)!.zoom).toBe(
      FIT_NODE_OPTIONS.minZoom
    )
  })

  it('refuses to compute against a container it cannot size', () => {
    expect(viewportForRect({ x: 0, y: 0, width: 600, height: 400 }, 0, 0)).toBeNull()
  })

  it('frames the node clear of the sidebar when given a chrome-free region', () => {
    // The regression this guards: on a cross-project focus the node was centred in the FULL pane
    // and landed partly under the (pinned) sessions sidebar. Reserving the sidebar's 400px on the
    // left as a region must push the node's centre into the free half, not the pane's centre.
    const rect = { x: 4000, y: 3000, width: 600, height: 400 }
    const region = { offsetX: 400, offsetY: 0, width: 880, height: 900 } // pane 1280×900, sidebar 400
    const vp = viewportForRect(rect, 1280, 900, region)!
    // Node centre in screen px = vp.x + centreX * zoom. It must sit inside [400, 1280], i.e. clear
    // of the sidebar, and near the free region's own centre (400 + 880/2 = 840).
    const centreX = vp.x + 4300 * vp.zoom
    expect(centreX).toBeGreaterThan(400)
    expect(centreX).toBeCloseTo(840, 0)
    // The plain (no-region) framing put the centre at the pane middle (640) — under the sidebar.
    const plain = viewportForRect(rect, 1280, 900)!
    expect(plain.x + 4300 * plain.zoom).toBeCloseTo(640, 0)
  })

  it('is identical to the plain framing when the region is the whole pane', () => {
    const rect = { x: 4000, y: 3000, width: 600, height: 400 }
    const full = { offsetX: 0, offsetY: 0, width: 1280, height: 900 }
    expect(viewportForRect(rect, 1280, 900, full)).toEqual(viewportForRect(rect, 1280, 900))
  })
})

describe('isMeasured', () => {
  it('reads React Flow measurements from either node shape, and tolerates a missing node', () => {
    expect(isMeasured({ measured: { width: 600, height: 400 } })).toBe(true)
    // A freshly deserialized node: sized, but not yet measured — fitView would DROP it.
    expect(isMeasured(term())).toBe(false)
    expect(isMeasured({ measured: { width: 600 } })).toBe(false)
    expect(isMeasured({ measured: { width: 0, height: 0 } })).toBe(false)
    expect(isMeasured(undefined)).toBe(false)
  })
})

describe('measuredFitRect (the measured focus path, which no longer goes through fitView)', () => {
  // Canvas.frameNode drops React Flow's DEFERRED fitView entirely and frames BOTH cases itself:
  // measured ⇒ this rect, unmeasured ⇒ nodeFitRect. These pin that the swap cannot drift.
  const internal = (over: Record<string, unknown> = {}) => ({
    measured: { width: 600, height: 400 },
    internals: { positionAbsolute: { x: 4000, y: 3000 } },
    ...over
  })

  it('frames a measured node identically to the persisted-rect path for the same geometry', () => {
    const fromStore = measuredFitRect(internal())
    const fromPersisted = nodeFitRect(term(), [term()])
    expect(fromStore).toEqual(fromPersisted)
    // …and therefore lands the exact same camera, with and without a chrome-free region.
    const region = { offsetX: 400, offsetY: 0, width: 880, height: 900 }
    expect(viewportForRect(fromStore!, 1280, 900)).toEqual(viewportForRect(fromPersisted!, 1280, 900))
    expect(viewportForRect(fromStore!, 1280, 900, region)).toEqual(
      viewportForRect(fromPersisted!, 1280, 900, region)
    )
  })

  it('uses the absolute position React Flow already resolved (no parent walk needed)', () => {
    // The store hands out positionAbsolute with the group chain applied, which is why the measured
    // branch needs neither the node list nor absolutePosition().
    expect(measuredFitRect(internal({ internals: { positionAbsolute: { x: 5050, y: 260 } } }))).toEqual(
      { x: 5050, y: 260, width: 600, height: 400 }
    )
  })

  it('gives up rather than framing a half-known rect — the caller then stands still', () => {
    expect(measuredFitRect(internal({ measured: { width: 0, height: 0 } }))).toBeNull()
    expect(measuredFitRect(internal({ measured: { width: 600 } }))).toBeNull()
    expect(measuredFitRect({ measured: { width: 600, height: 400 } })).toBeNull()
    expect(measuredFitRect(internal({ internals: { positionAbsolute: { x: 10 } } }))).toBeNull()
    expect(measuredFitRect(null)).toBeNull()
    expect(measuredFitRect(undefined)).toBeNull()
    // frameNode's rule, end to end: no rect from either source ⇒ no viewport ⇒ setViewport is
    // never called and the camera stays put. Teleporting to the origin is the bug being fixed.
    const sizeless: FocusableNode = { id: 'ghost', position: { x: 0, y: 0 } }
    const rect = measuredFitRect({ measured: {} }) ?? nodeFitRect(sizeless, [sizeless])
    expect(rect).toBeNull()
  })

  it('documents the failure mode it replaces: an empty fit set centres the ORIGIN at maxZoom', () => {
    // What a DEFERRED fitView resolved after a project switch computes: the target has left
    // nodeLookup, the filtered fit set is empty, getInternalNodesBounds collapses to zeroes and
    // the zoom divides by 0 ⇒ maxZoom. This is the number to compare a bug report against (138%,
    // empty canvas, node in the far minimap corner).
    expect(
      getViewportForBounds(
        { x: 0, y: 0, width: 0, height: 0 },
        1600,
        900,
        FIT_NODE_OPTIONS.minZoom,
        FIT_NODE_OPTIONS.maxZoom,
        FIT_NODE_OPTIONS.padding
      )
    ).toEqual({ x: 800, y: 450, zoom: FIT_NODE_OPTIONS.maxZoom })
  })
})

describe('viewportForRectPadded — the measured focus path and fitAll, both imperative now', () => {
  /*
   * The asymmetric-chrome fixture: 1280×900 pane, a 400px pinned sidebar on the left, 12px
   * FIT_VIEW_GAP elsewhere, i.e. exactly what solveFitPadding/rectToPadding hand over. Derivation
   * of the expected viewport, straight out of xyflow's getViewportForBounds:
   *   parsePaddings ⇒ left 400, right 12, top 12, bottom 12 ⇒ p.x = 412, p.y = 24
   *   xZoom = (1280 − 412)/600 = 1.4467, yZoom = (900 − 24)/400 = 2.19 ⇒ 1.4467, clamped to
   *     maxZoom 1.38
   *   x = 1280/2 − (5050 + 300)·1.38 = 640 − 7383 = −6743, y = 900/2 − (260 + 200)·1.38 = −184.8
   *   the applied left padding at that x is 226 < the required 400, so xyflow's asymmetric
   *     correction shifts by 226 − 400 = −174 ⇒ x = −6743 + 174 = −6569 (the node ends up FLUSH
   *     against the sidebar's inset, not centred in what is left); top/bottom already exceed 12.
   */
  const asymmetric = { top: '12px', left: '400px', right: '12px', bottom: '12px' } as const
  const grouped = { x: 5050, y: 260, width: 600, height: 400 }

  it('reproduces the old fitView framing of a MEASURED node under asymmetric chrome', () => {
    const vp = viewportForRectPadded(grouped, 1280, 900, asymmetric)!
    expect(vp.zoom).toBeCloseTo(1.38, 9)
    expect(vp.x).toBeCloseTo(-6569, 9)
    expect(vp.y).toBeCloseTo(-184.8, 9)
    // Identical to what xyflow computes from the same arguments — which is precisely what
    // `fitView({nodes:[{id}], ...FIT_NODE_OPTIONS, padding: solveFitPadding(…)})` used to do.
    expect(vp).toEqual(
      getViewportForBounds(
        grouped,
        1280,
        900,
        FIT_NODE_OPTIONS.minZoom,
        FIT_NODE_OPTIONS.maxZoom,
        asymmetric
      )
    )
    // The regression this guards: reducing the pane to the free region AND paying the 0.2 ratio
    // inside it applies both, framing the node ~12% smaller and 20px off centre.
    const region = { offsetX: 400, offsetY: 12, width: 868, height: 876 }
    const viaRegion = viewportForRect(grouped, 1280, 900, region)!
    expect(viaRegion.zoom).toBeCloseTo(1.2067, 4)
    expect(viaRegion.x).toBeCloseTo(-5621.67, 2)
    expect(vp).not.toEqual(viaRegion)
  })

  it('honours the caller\'s zoom limits — a fit-ALL must out-zoom the single-node clamp', () => {
    const tiny = { x: 0, y: 0, width: 100, height: 100 }
    // fitAll passes the canvas's own <ReactFlow minZoom/maxZoom> (0.01 / 2).
    expect(viewportForRectPadded(tiny, 1280, 900, 0.1, { minZoom: 0.01, maxZoom: 2 })).toEqual({
      x: 540,
      y: 350,
      zoom: 2
    })
    // The default is the single-node pair, which clamps the same rect at 1.38.
    expect(viewportForRectPadded(tiny, 1280, 900, 0.1)!.zoom).toBe(FIT_NODE_OPTIONS.maxZoom)
  })

  it('frames a whole-canvas bounds rect the way fitAll asks for it', () => {
    // What fitAll now computes instead of queueing a fitView: the non-ghost bounds, the same
    // solveFitPadding insets, the canvas zoom limits.
    const all = { x: -500, y: -200, width: 4000, height: 2000 }
    const limits = { minZoom: 0.01, maxZoom: 2 }
    const vp = viewportForRectPadded(all, 1280, 900, asymmetric, limits)!
    expect(vp.zoom).toBeCloseTo(0.217, 9)
    expect(vp.x).toBeCloseTo(508.5, 9)
    expect(vp.y).toBeCloseTo(276.4, 9)
    // …and fitAll's fallback ratio for when the chrome solve gives up (0.1, not the node's 0.2).
    expect(viewportForRectPadded(all, 1280, 900, 0.1, limits)!.zoom).toBeCloseTo(0.291, 9)
  })

  it('refuses a pane it cannot size', () => {
    expect(viewportForRectPadded(grouped, 0, 900, 0.2)).toBeNull()
    expect(viewportForRectPadded(grouped, 1280, 0, 0.2)).toBeNull()
  })
})

describe('absurd geometry can never install a viewport (project.json and peers are untrusted)', () => {
  // setViewport({x: NaN, …}) is accepted without complaint: the canvas goes blank and unpannable,
  // and onMove persists that camera into the project. Node positions arrive from a git-shared
  // .nodeterm/project.json and from canvas peers, neither of which validates them, so the refusal
  // lives here — at the one boundary every framing path crosses.
  const rect = { x: 4000, y: 3000, width: 600, height: 400 }
  const region = { offsetX: 400, offsetY: 0, width: 880, height: 900 }

  it('refuses a NaN / Infinity rect, with and without a region', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(viewportForRect({ ...rect, x: bad }, 1280, 900)).toBeNull()
      expect(viewportForRect({ ...rect, y: bad }, 1280, 900)).toBeNull()
      expect(viewportForRect({ ...rect, x: bad }, 1280, 900, region)).toBeNull()
      expect(viewportForRectPadded({ ...rect, x: bad, y: bad }, 1280, 900, 0.2)).toBeNull()
      expect(viewportForRect({ ...rect, width: bad }, 1280, 900)).toBeNull()
      expect(viewportForRect({ ...rect, height: bad }, 1280, 900)).toBeNull()
    }
  })

  it('refuses a FINITE but absurd position — the overflow happens at the zoom multiply', () => {
    // Number.MAX_VALUE passes every isFinite check going in (and 1e309 in a shared project.json
    // parses to Infinity, which the rect guard catches instead). It is the viewport check that
    // catches this one, which is why both ends are guarded.
    expect(viewportForRect({ ...rect, x: Number.MAX_VALUE }, 1280, 900)).toBeNull()
    expect(viewportForRect({ ...rect, y: -Number.MAX_VALUE }, 1280, 900)).toBeNull()
    expect(viewportForRect({ ...rect, x: Number.MAX_VALUE }, 1280, 900, region)).toBeNull()
    expect(viewportForRectPadded({ ...rect, x: Number.MAX_VALUE }, 1280, 900, 0.2)).toBeNull()
  })

  it('is NOT over-broad: ordinary (including negative) geometry frames exactly as before', () => {
    expect(viewportForRect(rect, 1280, 900)).toEqual(
      getViewportForBounds(
        rect,
        1280,
        900,
        FIT_NODE_OPTIONS.minZoom,
        FIT_NODE_OPTIONS.maxZoom,
        FIT_NODE_OPTIONS.padding
      )
    )
    expect(viewportForRect(rect, 1280, 900, region)).not.toBeNull()
    expect(viewportForRect({ x: -9e6, y: -7e6, width: 600, height: 400 }, 1280, 900)).not.toBeNull()
  })

  it('nodeFitRect refuses a non-finite position, including one SUMMED from a parent chain', () => {
    const bad: FocusableNode = { id: 'n', position: { x: NaN, y: 0 }, width: 600, height: 400 }
    expect(nodeFitRect(bad, [bad])).toBeNull()
    const inf: FocusableNode = { id: 'n', position: { x: 0, y: Infinity }, width: 600, height: 400 }
    expect(nodeFitRect(inf, [inf])).toBeNull()
    // Every term finite, the sum not: the group and the child each carry Number.MAX_VALUE.
    const g: FocusableNode = { id: 'g', position: { x: Number.MAX_VALUE, y: 0 } }
    const child: FocusableNode = {
      id: 'c',
      position: { x: Number.MAX_VALUE, y: 0 },
      width: 600,
      height: 400,
      parentId: 'g'
    }
    expect(absolutePosition(child, [g, child]).x).toBe(Infinity)
    expect(nodeFitRect(child, [g, child])).toBeNull()
  })

  it('measuredFitRect refuses a non-finite absolute position', () => {
    const m = { width: 600, height: 400 }
    expect(measuredFitRect({ measured: m, internals: { positionAbsolute: { x: NaN, y: 0 } } })).toBeNull()
    expect(
      measuredFitRect({ measured: m, internals: { positionAbsolute: { x: 0, y: Infinity } } })
    ).toBeNull()
  })
})
