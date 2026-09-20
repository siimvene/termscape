import { describe, it, expect } from 'vitest'
import { getViewportForBounds } from '@xyflow/system'
import {
  FIT_NODE_OPTIONS,
  absolutePosition,
  isMaximized,
  isMeasured,
  nodeFitRect,
  viewportForRect,
  viewportForRectPadded
} from './nodeFocus'
import type { FocusableNode } from './nodeFocus'
import { NODE_MAXIMIZE_MARGIN_PX } from './nodeMaximize'

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
})

describe('viewportForRect — the framing "go to node" applies', () => {
  const rect = { x: 5000, y: 4000, width: 600, height: 400 }

  it('centres the node in the pane, whatever chrome floats over it', () => {
    // Twice-reported regression: framing against the chrome-free rectangle — centred in it, or
    // centred in the pane and then nudged clear of it — pushes the node right by most of its width,
    // because the sessions sidebar is a 300px OVERLAY and it is open exactly when this is used.
    // "Go to node" puts the node where the eye is; the free-rect solve belongs to fitAll.
    const wide = viewportForRect(rect, 3440, 1400)!
    expect(wide.x + 5300 * wide.zoom).toBeCloseTo(1720, 0)
    expect(wide.y + 4200 * wide.zoom).toBeCloseTo(700, 0)
    const laptop = viewportForRect(rect, 1440, 900)!
    expect(laptop.x + 5300 * laptop.zoom).toBeCloseTo(720, 0)
    expect(laptop.y + 4200 * laptop.zoom).toBeCloseTo(450, 0)
  })

  it('keeps a given zoom and only pans (settings.focusZoomToNode off)', () => {
    // The point of the option: a user who settled on a zoom level loses their sense of place when
    // a jump also rescales the canvas. The node is still centred.
    const vp = viewportForRect(rect, 1440, 900, 0.5)!
    expect(vp.zoom).toBe(0.5)
    expect(vp.x + 5300 * 0.5).toBeCloseTo(720, 0)
    expect(vp.y + 4200 * 0.5).toBeCloseTo(450, 0)
  })

  it('passes an out-of-framing-range zoom through — it is one the canvas already shows', () => {
    // Re-clamping to FIT_NODE_OPTIONS would rescale the very view this option exists to leave
    // alone; the canvas's own limits already bound what getZoom() can return.
    expect(viewportForRect(rect, 1440, 900, 1.9)!.zoom).toBe(1.9)
    expect(viewportForRect(rect, 1440, 900, 0.1)!.zoom).toBe(0.1)
    expect(viewportForRect(rect, 1440, 900, 0)).toBeNull()
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

describe('viewportForRect — the maximized exception (issue #743)', () => {
  /**
   * The reporter's controlled measurement, reproduced as arithmetic. macOS, signed v0.3.5,
   * `focusZoomToNode` OFF (so the zoom is held and cannot confound it), sessions sidebar pinned,
   * one node, maximized. Only the CAMERA moved across "go to another node and back": the node's
   * position, size and the zoom were byte-identical before and after.
   */
  const PANE_W = 1710
  const ZOOM = 0.7345
  const INSETS = { left: 322, right: 0 }
  const rect = { x: -68.9, y: 0, width: 1824, height: 1261 }
  /** Where the node's left edge lands on screen for a given viewport. */
  const leftEdge = (vp: { x: number }) => vp.x + rect.x * ZOOM

  it('reproduces the reported drift when the framing ignores the pinned inset', () => {
    // 1824 × 0.7345 = 1339.8 rendered px; (1710 - 1339.8) / 2 = 185.1 — centred in the WHOLE pane,
    // exactly as measured. Maximize had put it at 346.0, so the camera moved 160.9 px, which is
    // 322 / 2: half the left inset, what centring a free-area-wide object in the full pane gives.
    const vp = viewportForRect(rect, PANE_W, 900, ZOOM)!
    expect(leftEdge(vp)).toBeCloseTo(185.1, 0)
    expect(leftEdge(viewportForRect(rect, PANE_W, 900, ZOOM, INSETS)!) - leftEdge(vp)).toBeCloseTo(
      160.9,
      0
    )
  })

  it('frames a maximized node exactly where maximizeTargetRect placed it', () => {
    // maximize's own origin is `marginPx + insets.left` = 24 + 322 = 346. The node is the free
    // area minus two margins, so centring it in the free area reproduces that origin — which is
    // the property that makes this a fix rather than a different opinion about where to put it.
    const vp = viewportForRect(rect, PANE_W, 900, ZOOM, INSETS)!
    expect(leftEdge(vp)).toBeCloseTo(NODE_MAXIMIZE_MARGIN_PX + INSETS.left, 0)
    // 136.9 px of the node sat behind the sidebar before; none does now.
    expect(leftEdge(vp)).toBeGreaterThanOrEqual(INSETS.left)
  })

  it('is a mathematical no-op when no panel is pinned', () => {
    const bare = viewportForRect(rect, PANE_W, 900, ZOOM)!
    const zero = viewportForRect(rect, PANE_W, 900, ZOOM, { left: 0, right: 0 })!
    expect(zero).toEqual(bare)
    expect(viewportForRect(rect, PANE_W, 900, undefined, { left: 0, right: 0 })).toEqual(
      viewportForRect(rect, PANE_W, 900)
    )
  })

  it('insets the zoom-to-fit path too, without changing the unpinned answer', () => {
    // `focusZoomToNode` ON rescales as well. The rectangle question is the same one, so the
    // maximized node is fitted INSIDE the free area rather than the pane — its whole width is
    // clear of the panel, where centring in the pane left part of it underneath.
    const fitted = viewportForRect(rect, PANE_W, 900, undefined, INSETS)!
    expect(fitted.x + rect.x * fitted.zoom).toBeGreaterThanOrEqual(INSETS.left)
    expect(fitted.x + (rect.x + rect.width) * fitted.zoom).toBeLessThanOrEqual(PANE_W)
  })

  it('falls back to the whole pane when the panels are wider than it', () => {
    // Not a rectangle anything can be centred in — solving against a negative width would put the
    // camera somewhere arbitrary. Standing on the old answer is the honest degrade.
    const narrow = viewportForRect(rect, 300, 900, ZOOM, { left: 322, right: 0 })!
    expect(narrow).toEqual(viewportForRect(rect, 300, 900, ZOOM))
  })

  it('refuses a container it cannot size, insets or not', () => {
    expect(viewportForRect(rect, 0, 0, ZOOM, INSETS)).toBeNull()
    expect(viewportForRect(rect, PANE_W, 900, 0, INSETS)).toBeNull()
  })
})

describe('viewportForRect — a focused node is framed inside the pinned-chrome-free region', () => {
  /*
   * The regression this pins (reported after the v0.3.7 merge): with the sessions sidebar PINNED,
   * clicking a session framed the node centred in the WHOLE pane, so part of it sat behind the
   * sidebar. frameNode now passes measurePinnedInsets(box) for EVERY node, so viewportForRect
   * frames inside the region the pinned chrome leaves over. The fix restores fork a0c86e92.
   */
  const PANE = { w: 1280, h: 900 }
  const INSETS = { left: 400, right: 0 }
  const node = { x: 5050, y: 260, width: 600, height: 400 }

  it('puts the whole node to the right of a 400px left inset and centres it in the 880px remainder', () => {
    const vp = viewportForRect(node, PANE.w, PANE.h, undefined, INSETS)!
    const leftEdge = vp.x + node.x * vp.zoom
    const rightEdge = vp.x + (node.x + node.width) * vp.zoom
    const centreX = vp.x + (node.x + node.width / 2) * vp.zoom
    // Entirely clear of the sidebar, and inside the pane.
    expect(leftEdge).toBeGreaterThanOrEqual(INSETS.left)
    expect(rightEdge).toBeLessThanOrEqual(PANE.w)
    // Centred in the free region: 400 + (1280 - 400) / 2 = 840.
    expect(centreX).toBeCloseTo(INSETS.left + (PANE.w - INSETS.left) / 2, 6)
  })

  it('differs from the whole-pane centring the merge produced (the actual regression)', () => {
    const framed = viewportForRect(node, PANE.w, PANE.h, undefined, INSETS)!
    const wholePane = viewportForRect(node, PANE.w, PANE.h)!
    // The merge centred in the whole pane: node centre at 1280 / 2 = 640, so its left edge fell
    // behind the 400px sidebar. That is what insets fix.
    expect(wholePane.x + (node.x + node.width / 2) * wholePane.zoom).toBeCloseTo(PANE.w / 2, 6)
    expect(framed.x).not.toBeCloseTo(wholePane.x, 3)
    // An UNPINNED sidebar measures 0 insets, so the common case is untouched — same as whole pane.
    expect(viewportForRect(node, PANE.w, PANE.h, undefined, { left: 0, right: 0 })).toEqual(wholePane)
  })
})

describe('isMaximized', () => {
  it('keys on premaxRect — the flag maximize itself writes and restore clears', () => {
    expect(isMaximized({ data: { premaxRect: { x: 0, y: 0, width: 10, height: 10 } } })).toBe(true)
    expect(isMaximized({ data: {} })).toBe(false)
    expect(isMaximized({})).toBe(false)
    expect(isMaximized(null)).toBe(false)
    expect(isMaximized(undefined)).toBe(false)
  })
})

describe('viewportForRectPadded — the imperative fit path (fitAll and directional insets)', () => {
  /*
   * The asymmetric-chrome fixture: 1280×900 pane, a 400px pinned sidebar on the left, 12px
   * FIT_VIEW_GAP elsewhere, i.e. exactly what solveFitPadding/rectToPadding hand over. This is the
   * measured focus path fitAll shares — a MEASURED node framed with DIRECTIONAL pixel insets.
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
  })

  it("honours the caller's zoom limits — a fit-ALL must out-zoom the single-node clamp", () => {
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
    // What fitAll computes instead of queueing a fitView: the non-ghost bounds, the same
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
  // lives here — at the one boundary every framing path crosses (both viewportForRect and
  // viewportForRectPadded).
  const rect = { x: 4000, y: 3000, width: 600, height: 400 }

  it('refuses a NaN / Infinity rect on both framing paths', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(viewportForRect({ ...rect, x: bad }, 1280, 900)).toBeNull()
      expect(viewportForRect({ ...rect, y: bad }, 1280, 900)).toBeNull()
      // …with a held zoom (the pan path) and with a pinned inset (the maximized path) too.
      expect(viewportForRect({ ...rect, x: bad }, 1280, 900, 0.5)).toBeNull()
      expect(viewportForRect({ ...rect, x: bad }, 1280, 900, undefined, { left: 322, right: 0 })).toBeNull()
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
})
