import { getViewportForBounds, type Padding, type Rect, type Viewport } from '@xyflow/system'

import { NO_INSETS, type ScreenInsets } from './pinnedInsets'

/**
 * "Zoom to this node" geometry, computed OURSELVES — the whole of it, measured or not.
 *
 * Why this exists: `fitView({ nodes: [{ id }] })` is the natural way to frame one node, and it is
 * what `Canvas.goToNode` used to do — but it frames nothing when you call it. In `@xyflow/react`
 * 12 `fitView` is DEFERRED: it parks `fitViewQueued`/`fitViewOptions` and resolves on a later
 * `setNodes` (and only once EVERY node is measured) or on the next `updateNodeInternals`. So the
 * fit is resolved against whatever `nodeLookup` holds by then, not the canvas the user clicked on;
 * and its fit set is filtered down to nodes React Flow has already MEASURED (`getFitViewNodes`
 * keys off `measured.width && measured.height`, with no `width`/`height` fallback), so a set that
 * comes out EMPTY collapses the bounds to `{0,0,0,0}` and the camera flies to the canvas ORIGIN at
 * max zoom — an empty stretch of canvas, nowhere near the node.
 *
 * Both halves fire on the same everyday path. A cross-project focus (sessions sidebar, OS
 * notification, ⌘K jump, presence travel) switches project → loads its nodes → frames the target,
 * all before the mount-time measuring has settled: the queued fit then waits for a later node
 * update, and by the time it runs the canvas may have moved on. The second click always works,
 * because by then everything is measured — which is what makes it read as "sometimes".
 *
 * So the maths is ours, from React Flow's measurement when it has one and from the size the node
 * was persisted with when it does not — neither needs layout — and the camera is driven with
 * `setViewport`, which applies immediately.
 */

/** The subset of a React Flow node this module needs. Loose on purpose: it must accept both a
 *  freshly deserialized node (`width`/`height`, no `measured`) and a live measured one. */
export interface FocusableNode {
  id: string
  position: { x: number; y: number }
  parentId?: string
  width?: number | null
  height?: number | null
  measured?: { width?: number | null; height?: number | null }
  style?: { width?: number | string | null; height?: number | string | null }
}

/**
 * Is this node currently MAXIMIZED — i.e. was it placed against the chrome-free rectangle rather
 * than dropped somewhere by hand?
 *
 * `premaxRect` is the maximize MODE flag (`maximizeNodeToRect` writes it, `restoreMaximizedNode`
 * clears it), which is what makes it the right key here: it is exactly the set of nodes whose
 * position was chosen by `maximizeTargetRect`, and the fix below is about framing a node against
 * the rectangle its own placement used.
 *
 * It survives things that make the node no longer free-area-sized — a manual resize, a window
 * resize (maximize deliberately does not re-fit on those) — and that is acceptable in both
 * directions: with no pinned panel the inset is zero and this decision is a no-op, and with one
 * the worst case is a node framed clear of a panel it was already meant to clear. Unpinning the
 * panel needs no special case at all: `fitMaximizedToUsableArea` re-fits every maximized node
 * whenever the insets change, so the flag and the geometry re-converge on their own.
 */
export function isMaximized(node: { data?: { premaxRect?: unknown } } | null | undefined): boolean {
  return !!node?.data?.premaxRect
}

/** Zoom/padding for framing a single node, shared by both framing paths here so the whole-pane
 *  and chrome-free-frame answers cannot drift apart: the clamp keeps a small node from filling the
 *  screen and a huge one from being fit microscopic. (`maxZoom` 1.38 is the 138% a correct
 *  terminal focus lands on.) */
export const FIT_NODE_OPTIONS = { padding: 0.2, minZoom: 0.25, maxZoom: 1.38 } as const

/** A `parentId` chain longer than this is a data bug (or a cycle) — stop walking. */
const MAX_PARENT_DEPTH = 20

const numeric = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null

const sizeOf = (n: FocusableNode): { width: number; height: number } | null => {
  const width = numeric(n.measured?.width) ?? numeric(n.width) ?? numeric(n.style?.width)
  const height = numeric(n.measured?.height) ?? numeric(n.height) ?? numeric(n.style?.height)
  return width && height ? { width, height } : null
}

/**
 * The node's top-left in ABSOLUTE canvas coordinates. A grouped node's `position` is relative to
 * its group frame, so the parent chain is walked. Needs no size — unlike `nodeFitRect` this always
 * answers, which is what placement (as opposed to framing) needs: a node spawned next to a grouped
 * source must be positioned in the same space the source really occupies, not at its raw
 * group-relative `position`.
 */
export function absolutePosition(
  node: FocusableNode,
  all: readonly FocusableNode[]
): { x: number; y: number } {
  let x = node.position.x
  let y = node.position.y
  let parentId = node.parentId
  const seen = new Set<string>([node.id])
  for (let depth = 0; parentId && depth < MAX_PARENT_DEPTH; depth++) {
    if (seen.has(parentId)) break
    seen.add(parentId)
    const parent = all.find((n) => n.id === parentId)
    if (!parent) break
    x += parent.position.x
    y += parent.position.y
    parentId = parent.parentId
  }
  return { x, y }
}

/**
 * The node's rect in ABSOLUTE canvas coordinates, or null when its size is unknowable (in which
 * case the caller must leave the camera alone — a zero-size rect is what produces the origin jump).
 */
export function nodeFitRect(node: FocusableNode, all: readonly FocusableNode[]): Rect | null {
  const size = sizeOf(node)
  if (!size) return null
  const at = absolutePosition(node, all)
  // The parent chain SUMS positions, and every term comes from a git-shared `project.json` or a
  // canvas peer — neither validated here. A NaN or an overflow to ±Infinity would reach
  // `setViewport` as a blank, unpannable canvas that `onMove` then persists, so it is refused
  // where it is first knowable: no rect ⇒ the caller stands still.
  if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) return null
  return { ...at, ...size }
}

/** The zoom clamp a fit is solved under. `FIT_NODE_OPTIONS` supplies the single-node pair; a
 *  fit-ALL passes the canvas's own `<ReactFlow minZoom/maxZoom>` instead, because it must be able
 *  to zoom out far enough to hold the whole content. */
export interface FitLimits {
  minZoom: number
  maxZoom: number
}

/** Geometry that reached us from a git-shared `project.json` or a canvas peer is not validated
 *  anywhere upstream, and `Number.MAX_VALUE` is FINITE — it only becomes Infinity once multiplied
 *  by the zoom. So both ends are checked: the rect going in, and the viewport coming out. */
const finiteRect = (r: Rect): boolean =>
  Number.isFinite(r.x) && Number.isFinite(r.y) && r.width > 0 && r.height > 0

const finiteViewport = (v: Viewport): Viewport | null =>
  Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.zoom) && v.zoom > 0 ? v : null

/**
 * The viewport that frames `rect` in a `containerWidth × containerHeight` pane with `padding` —
 * xyflow's own fit maths (`getViewportForBounds`), i.e. exactly what a `fitView` with the same
 * arguments would have computed, minus its deferral. Used by `fitAll` (whole-canvas bounds) and
 * anywhere a directional-inset frame is needed.
 *
 * `padding` takes every shape `fitView` accepts, and the shapes are NOT interchangeable: a NUMBER
 * is a proportional ratio applied on top of the bounds, while the DIRECTIONAL pixel insets
 * `solveFitPadding` produces reserve exactly those edges of the full pane (xyflow's own asymmetric
 * path, which also pushes the rect flush against the reserved edge rather than centring it in what
 * is left).
 *
 * Null when the container has no size, or when the rect or the resulting viewport is not finite:
 * `setViewport({x: NaN, …})` is accepted without complaint, leaves the canvas blank and
 * unpannable, and `onMove` then persists it. Callers read null as "stand still".
 */
export function viewportForRectPadded(
  rect: Rect,
  containerWidth: number,
  containerHeight: number,
  padding: Padding,
  limits: FitLimits = FIT_NODE_OPTIONS
): Viewport | null {
  if (!(containerWidth > 0) || !(containerHeight > 0)) return null
  if (!finiteRect(rect)) return null
  return finiteViewport(
    getViewportForBounds(rect, containerWidth, containerHeight, limits.minZoom, limits.maxZoom, padding)
  )
}

/**
 * The viewport that frames `rect` in a `containerWidth × containerHeight` pane, with the same
 * padding/zoom clamp `fitView` would have applied. Null when the container has no size yet, or
 * when the rect or the resulting viewport is not finite (see `viewportForRectPadded`).
 *
 * **Centred in the band the pinned chrome leaves free — `insets` are that chrome's directional
 * pixel insets.** `insets.left`/`insets.right` are how far the PINNED side panels (the sessions
 * sidebar, the explorer drawer) reach in over the canvas; this reduces the pane by them, centres
 * the node in the remaining band, and shifts by `insets.left`. A caller with nothing pinned passes
 * `NO_INSETS` (zeros) and gets whole-pane centring unchanged — the insets only bite once the user
 * has pinned a panel that would otherwise sit over the node. Trade-off, stated plainly: with a wide
 * pinned sidebar this pushes the node right by up to the sidebar's width, which this codebase
 * prefers over leaving part of the node under the panel (the placement upstream 1c248da7 chose).
 *
 * **The MAXIMIZED case (issue #743) reproduces its own placement, it is not a special rule here.**
 * A maximized node's premise differs by CONSTRUCTION, not by degree: `maximizeTargetRect` sized the
 * node to be *exactly* as wide as the free area, so centring it in the WHOLE pane would bury half
 * the inset less the margin (137px in the reported layout, scaling with the PANEL, not the node) —
 * where an ordinary node loses only a couple of dozen pixels (33px, measured by the reporter). Its
 * placement already used these same insets, so framing it against the same free band — the node
 * being that band minus two margins — lands it exactly where maximize put it. No branch on
 * `isMaximized` is needed: passing the pinned insets is correct for both cases.
 *
 * `zoom` keeps the camera at a scale the caller already has (`settings.focusZoomToNode` off): the
 * node is centred exactly as it would be, at that zoom, so "go to" stays a pan. It is passed
 * through UNCLAMPED — it is a zoom the canvas is already displaying, and re-clamping it to the
 * framing range would rescale the view this option exists to leave alone.
 */
export function viewportForRect(
  rect: Rect,
  containerWidth: number,
  containerHeight: number,
  zoom?: number,
  insets: ScreenInsets = NO_INSETS
): Viewport | null {
  if (!(containerWidth > 0) || !(containerHeight > 0)) return null
  if (!finiteRect(rect)) return null
  // A pane narrower than the panels covering it is not a rectangle anything can be centred in —
  // fall back to the whole pane rather than solving against a negative width.
  const freeWidth = containerWidth - insets.left - insets.right
  const originX = freeWidth > 0 ? insets.left : 0
  const width = freeWidth > 0 ? freeWidth : containerWidth
  if (zoom !== undefined) {
    if (!(zoom > 0)) return null
    return finiteViewport({
      x: originX + width / 2 - (rect.x + rect.width / 2) * zoom,
      y: containerHeight / 2 - (rect.y + rect.height / 2) * zoom,
      zoom
    })
  }
  const fitted = getViewportForBounds(
    rect,
    width,
    containerHeight,
    FIT_NODE_OPTIONS.minZoom,
    FIT_NODE_OPTIONS.maxZoom,
    FIT_NODE_OPTIONS.padding
  )
  return finiteViewport(originX ? { ...fitted, x: fitted.x + originX } : fitted)
}

/** Whether React Flow already knows this node's on-screen size — i.e. whether its measurement can
 *  be framed from directly or the persisted size has to stand in. Takes the minimal shape so it
 *  reads either a user-land node or React Flow's own internal node (the authoritative one; see
 *  Canvas.frameNode). */
export function isMeasured(
  node: { measured?: { width?: number | null; height?: number | null } } | null | undefined
): boolean {
  return !!(numeric(node?.measured?.width) && numeric(node?.measured?.height))
}
