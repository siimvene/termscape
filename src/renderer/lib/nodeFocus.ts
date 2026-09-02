import { getViewportForBounds, type Rect, type Viewport } from '@xyflow/system'

/**
 * "Zoom to this node" geometry, computed OURSELVES — the whole of it, measured or not.
 *
 * Why this exists: `fitView({ nodes: [{ id }] })` is the natural way to frame one node, and it is
 * what `Canvas.goToNode` used to do. Two independent ways it lands on nothing:
 *
 * 1. React Flow filters the fit set down to nodes it has already MEASURED (`getFitViewNodes` keys
 *    off `measured.width && measured.height`; there is no `width`/`height` fallback there). A node
 *    handed to React Flow a tick ago has no measurement, so the fit set comes out EMPTY, its bounds
 *    collapse to `{0,0,0,0}` and the camera flies to the canvas ORIGIN at max zoom. That is exactly
 *    the window a cross-project focus lands in: switch project → load its nodes → focus the target,
 *    all before mount-time measuring has run.
 * 2. In `@xyflow/react` 12 `fitView` is DEFERRED — it parks `fitViewQueued`/`fitViewOptions` and
 *    resolves on a later `setNodes`, and only while `nodesInitialized === true`, which this canvas
 *    never is (the webview keep-alive ghosts are unmeasurable and cannot be `hidden`). So even a
 *    fully MEASURED node did not move the camera on the click, and the stale queued fit resolved
 *    later — often after a project switch, i.e. against case 1's empty set.
 *
 * So we do the maths ourselves and drive the camera with `setViewport`: from React Flow's own
 * measurement when it has one (`measuredFitRect`), otherwise from the size the node was persisted
 * with (`nodeFitRect`), which needs no layout. Same padding/zoom clamp `fitView` would have used.
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

/** Zoom/padding for framing a single node — the same numbers `fitView` would have applied, kept
 *  beside the maths: the clamp keeps a small node from filling the screen and a huge one from
 *  being fit microscopic. (`maxZoom` 1.38 is the 138% a correct terminal focus lands on, which is
 *  why 138% alone never proved the degenerate empty-fit jump.) */
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
  return { ...absolutePosition(node, all), ...size }
}

/** The subset of React Flow's OWN internal node this module needs: the store's measurement plus
 *  the absolute position React Flow has already resolved for it (group chains included). Loose on
 *  purpose so a plain object can stand in for one in a test. */
export interface MeasuredNode {
  measured?: { width?: number | null; height?: number | null }
  internals?: { positionAbsolute?: { x?: number | null; y?: number | null } }
}

/**
 * The rect React Flow's own measurement implies, in ABSOLUTE canvas coordinates — the framing
 * input for a node the store has already sized. Null when there is no usable measurement or no
 * absolute position, in which case the caller falls back to `nodeFitRect` (or stands still).
 *
 * Why the caller computes the rect at all instead of handing the id to `fitView`: in
 * `@xyflow/react` 12 `fitView` is DEFERRED (it parks `fitViewQueued`/`fitViewOptions` and resolves
 * on a later `setNodes`, only while `nodesInitialized === true`), so the camera does not move on
 * the click and the queued fit can later resolve against a node list the target has left — an
 * empty fit set, bounds `{0,0,0,0}`, the world origin at maxZoom. See `Canvas.frameNode`.
 */
export function measuredFitRect(node: MeasuredNode | null | undefined): Rect | null {
  const width = numeric(node?.measured?.width)
  const height = numeric(node?.measured?.height)
  if (!width || !height) return null
  const { x, y } = node?.internals?.positionAbsolute ?? {}
  if (!Number.isFinite(x as number) || !Number.isFinite(y as number)) return null
  return { x: x as number, y: y as number, width, height }
}

/** A chrome-free sub-rectangle of the pane to frame within, offset from the pane's top-left (all in
 *  screen px). Lets the focus path reserve the same space around the sidebar/dock/etc. that
 *  `fitAll` gets from `solveFitPadding`, instead of centering the node underneath them. */
export interface FocusRegion {
  offsetX: number
  offsetY: number
  width: number
  height: number
}

/** The viewport that frames `rect` in a `containerWidth × containerHeight` pane, with the same
 *  padding/zoom clamp `fitView` would have applied. Null when the container has no size yet.
 *
 *  With a `region`, `rect` is framed inside that sub-rectangle instead of the whole pane: the fit
 *  is solved for the region's size and the resulting translation shifted by the region's offset, so
 *  the node lands centred in the free space — never underneath the chrome the region excludes. */
export function viewportForRect(
  rect: Rect,
  containerWidth: number,
  containerHeight: number,
  region?: FocusRegion
): Viewport | null {
  const w = region ? region.width : containerWidth
  const h = region ? region.height : containerHeight
  if (!(w > 0) || !(h > 0)) return null
  const vp = getViewportForBounds(
    rect,
    w,
    h,
    FIT_NODE_OPTIONS.minZoom,
    FIT_NODE_OPTIONS.maxZoom,
    FIT_NODE_OPTIONS.padding
  )
  return region ? { x: vp.x + region.offsetX, y: vp.y + region.offsetY, zoom: vp.zoom } : vp
}

/** Whether React Flow already knows this node's on-screen size — i.e. whether its measurement can
 *  be framed from (`measuredFitRect`) or the persisted size has to stand in. Takes the minimal
 *  shape so it reads either a user-land node or React Flow's own internal node (the authoritative
 *  one; see Canvas.frameNode). */
export function isMeasured(
  node: { measured?: { width?: number | null; height?: number | null } } | null | undefined
): boolean {
  return !!(numeric(node?.measured?.width) && numeric(node?.measured?.height))
}
