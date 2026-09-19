import type { CanvasLayout, CanvasLayoutNode } from '@shared/canvas-layout'
import { CANVAS_LAYOUT_NAME_MAX } from '@shared/canvas-layout'
import {
  COLLAPSED_HEIGHT,
  fitGroupToChildren,
  GROUP_HEADER,
  GROUP_PAD,
  rootPosition,
  type CanvasNode
} from '../state/workspace'

/**
 * Capture and restore of a canvas layout: a named snapshot of node GEOMETRY for one project (see
 * the trust model in @shared/canvas-layout).
 *
 * Pure on purpose. Everything here is array in, array out, so the two halves that decide where a
 * canvas ends up can be tested under vitest's default node environment instead of behind React
 * Flow, a zustand store and a mounted canvas.
 */

/**
 * Node kinds that exist only as a live render and are never serialized (`subagent`, `loop` in
 * CLAUDE.md's node-kinds list). A layout entry for one is an id nothing can ever resolve again -
 * the next turn clears the card - so capture skips them and the restore's `extra` count ignores
 * them rather than reporting a "node the layout does not mention" the user cannot act on.
 */
const EPHEMERAL_KINDS: ReadonlySet<string> = new Set(['subagent', 'loop'])

/** A rect in ROOT space, the coordinate space a layout entry and `withNodeRect` both speak. */
interface RootRect {
  x: number
  y: number
  width: number
  height: number
}

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** A node's on-canvas width, preferring React Flow's own measurement the way `flowToNodeStates`
 *  does, so a captured rect matches what the user actually sees rather than the last size written. */
function capturedWidth(node: CanvasNode): number | undefined {
  return (
    finiteNumber(node.measured?.width) ??
    finiteNumber(node.width) ??
    finiteNumber(node.style?.width)
  )
}

/**
 * A node's EXPANDED height, which is the only height a layout may store.
 *
 * While a node is collapsed its on-screen height is chrome (`COLLAPSED_HEIGHT`), not a size the
 * user chose, so the measurement is ignored in favor of `data.expandedHeight` - the same rule
 * `flowToNodeStates` applies when it serializes a collapsed node. Storing the shrunk height would
 * make every save-while-collapsed permanently shrink the node on the next restore.
 */
function capturedExpandedHeight(node: CanvasNode): number | undefined {
  if (node.data.collapsed) return finiteNumber(node.data.expandedHeight)
  return (
    finiteNumber(node.measured?.height) ??
    finiteNumber(node.height) ??
    finiteNumber(node.style?.height)
  )
}

/**
 * Snapshot the live canvas: every node's ROOT-space rect, its collapse state and its parent.
 *
 * Root space rather than parent-relative because a frame that has since been ungrouped, moved or
 * re-fitted must not drag its old children hundreds of pixels off screen when the layout is
 * restored - the same reasoning `maximizeNodeToRect` gives for storing `premaxRect` in root space.
 *
 * A node whose size cannot be established is SKIPPED rather than captured at a guessed rect: an
 * unaddressed node is left exactly where it is on restore (rule 1), which is always safe, while a
 * guessed rect would resize it. In practice every node carries a size - `nodeStatesToFlow` and the
 * node factories both write one - so this is a refusal, not a fallback.
 *
 * The name is trimmed and capped here so the layout survives its own reader: `sanitizeLayouts`
 * drops a layout WHOLE when its name is empty after trimming, and a capture that produced an
 * unreadable snapshot would look like a save that silently did nothing.
 */
export function captureLayout(
  nodes: CanvasNode[],
  opts: { id: string; name: string; now: number; window?: { width: number; height: number } }
): CanvasLayout {
  const entries: CanvasLayoutNode[] = []
  for (const node of nodes) {
    if (EPHEMERAL_KINDS.has(node.type ?? '')) continue
    const width = capturedWidth(node)
    const height = capturedExpandedHeight(node)
    if (width === undefined || height === undefined) continue
    const root = rootPosition(node, nodes)
    entries.push({
      id: node.id,
      x: root.x,
      y: root.y,
      width,
      height,
      ...(node.data.collapsed ? { collapsed: true } : {}),
      ...(node.parentId ? { parentId: node.parentId } : {})
    })
  }
  return {
    id: opts.id,
    name: opts.name.trim().slice(0, CANVAS_LAYOUT_NAME_MAX),
    createdAt: opts.now,
    updatedAt: opts.now,
    ...(opts.window ? { window: opts.window } : {}),
    nodes: entries
  }
}

/** What a restore did, in the terms the user-facing toast reports. Counted by the transform itself
 *  so the sentence cannot drift from what happened on the canvas. */
export interface ApplyLayoutResult {
  nodes: CanvasNode[]
  /** Nodes the layout addressed and actually placed. */
  moved: number
  /** Entries in the layout whose node no longer exists. Never recreated. */
  missing: number
  /** Live nodes the layout does not mention. Left untouched. */
  extra: number
}

/** A node's rect as it is drawn right now: the rendered height, so a collapsed node contributes its
 *  chrome height rather than the size it would have if expanded. */
function renderedRootRect(node: CanvasNode, nodes: CanvasNode[]): RootRect {
  const root = rootPosition(node, nodes)
  const width =
    finiteNumber(node.measured?.width) ?? finiteNumber(node.width) ?? finiteNumber(node.style?.width) ?? 0
  const height =
    finiteNumber(node.measured?.height) ??
    finiteNumber(node.height) ??
    finiteNumber(node.style?.height) ??
    0
  return { x: root.x, y: root.y, width, height }
}

/**
 * Grow `saved` until it also contains `boxes` with the clearance `fitGroupToChildren` gives a
 * frame, or return `saved` untouched when it already does.
 *
 * `saved` is the FLOOR and is never padded: it is the rect the user consented to, so a frame that
 * nothing forces open comes back at exactly the size they saved. Growing only outward is also what
 * makes a repeated restore idempotent - a rule that could shrink or re-center the frame would
 * drift a little further on every apply.
 */
function grownToContain(saved: RootRect, boxes: RootRect[]): RootRect {
  if (boxes.length === 0) return saved
  const minX = Math.min(...boxes.map((b) => b.x)) - GROUP_PAD
  const minY = Math.min(...boxes.map((b) => b.y)) - GROUP_PAD - GROUP_HEADER
  const maxX = Math.max(...boxes.map((b) => b.x + b.width)) + GROUP_PAD
  const maxY = Math.max(...boxes.map((b) => b.y + b.height)) + GROUP_PAD
  const x = Math.min(saved.x, minX)
  const y = Math.min(saved.y, minY)
  const right = Math.max(saved.x + saved.width, maxX)
  const bottom = Math.max(saved.y + saved.height, maxY)
  return { x, y, width: right - x, height: bottom - y }
}

/**
 * Move and resize one frame to `rect` while every one of its children stays exactly where it is on
 * canvas, by shifting their parent-relative positions against the frame's own move - the same
 * re-anchoring `fitGroupToChildren` performs. A frame is a background container, so resizing it is
 * not supposed to be visible on anything inside it.
 */
function withFrameRect(nodes: CanvasNode[], frameId: string, rect: RootRect): CanvasNode[] {
  const frame = nodes.find((node) => node.id === frameId)
  if (!frame) return nodes
  const origin = rootPosition(frame, nodes)
  const dx = rect.x - origin.x
  const dy = rect.y - origin.y
  return nodes.map((node) => {
    if (node.id === frameId) {
      return {
        ...node,
        position: { x: node.position.x + dx, y: node.position.y + dy },
        width: rect.width,
        height: rect.height,
        style: { ...node.style, width: rect.width, height: rect.height },
        measured: undefined
      }
    }
    if (node.parentId === frameId && (dx !== 0 || dy !== 0)) {
      return { ...node, position: { x: node.position.x - dx, y: node.position.y - dy } }
    }
    return node
  })
}

/** Ancestor count, used to re-fit frames innermost-first. Read off the ORIGINAL array because a
 *  restore never reparents anything (rule 8), so the chain is the same before and after. */
function depthOf(node: CanvasNode, byId: Map<string, CanvasNode>): number {
  let depth = 0
  const seen = new Set<string>([node.id])
  let parentId = node.parentId
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = byId.get(parentId)
    if (!parent) break
    depth += 1
    parentId = parent.parentId
  }
  return depth
}

/**
 * Put the canvas back the way `layout` recorded it. Pure.
 *
 * The whole layout lands in ONE transform, as an explicit two-pass: resolve every target root
 * origin first, then emit the nodes against those origins. A reduce over per-node placements would
 * re-fit an ancestor frame between two placements, so the second node would be measured against a
 * frame the first node had just moved and the arrangement would come back subtly wrong - and
 * differently wrong depending on array order.
 *
 * Geometry only. Nothing here creates, deletes, reparents, renames or respawns anything, and the
 * layout's recorded `parentId` is read for nothing at all: it is a label for the reader, and
 * honoring it would turn a restore into a structural edit.
 */
export function applyLayout(nodes: CanvasNode[], layout: CanvasLayout): ApplyLayoutResult {
  const byId = new Map(nodes.map((node) => [node.id, node]))

  // First-wins on a duplicate id: a hand-edited file can name one node twice, and the counts below
  // must describe nodes, not entries, or the toast reports more moves than there are nodes.
  const entries = new Map<string, CanvasLayoutNode>()
  for (const entry of layout.nodes) {
    if (!entries.has(entry.id)) entries.set(entry.id, entry)
  }

  // Rule 2: an entry whose node is gone is skipped and counted. A layout is geometry; resurrecting
  // a node would be content, and content this file has no honest copy of.
  let missing = 0
  const placed = new Map<string, CanvasLayoutNode>()
  for (const [id, entry] of entries) {
    if (byId.has(id)) placed.set(id, entry)
    else missing += 1
  }

  // Rule 1: a node the layout does not know is left exactly where it is - not tidied, not stacked
  // at the origin. It is only counted, so the user learns the layout predates it.
  let extra = 0
  for (const node of nodes) {
    if (EPHEMERAL_KINDS.has(node.type ?? '')) continue
    if (!placed.has(node.id)) extra += 1
  }

  // Nothing to place: hand back the SAME array so a no-op restore cannot mark the workspace dirty
  // and write a project.json revision for a canvas that did not change.
  if (placed.size === 0) return { nodes, moved: 0, missing, extra }

  const currentRoot = new Map(nodes.map((node) => [node.id, rootPosition(node, nodes)]))

  /**
   * Pass one, the target ROOT origin of every node: the saved one for a node the layout addresses,
   * and the CURRENT one for a node it does not (rule 1, which holds even when the frame the node
   * sits in is about to move out from under it). Resolving all of them before anything is emitted
   * is what makes the transform order-independent. A dangling parentId resolves to the root,
   * matching how `containerOrigin` treats one.
   */
  const targetRoot = (id: string): { x: number; y: number } => {
    const entry = placed.get(id)
    if (entry) return { x: entry.x, y: entry.y }
    return currentRoot.get(id) ?? { x: 0, y: 0 }
  }
  const originOf = (parentId: string | undefined): { x: number; y: number } =>
    parentId && byId.has(parentId) ? targetRoot(parentId) : { x: 0, y: 0 }

  // Pass two. Group frames are placed here like any other node (rule 3): a frame the layout
  // addresses gets the rect the user saved, and is deliberately NOT re-fitted around the children
  // the layout ALSO addressed, or the fit would overwrite that rect and the arrangement would
  // drift a little on every restore.
  let next = nodes.map((node) => {
    const origin = originOf(node.parentId)
    const entry = placed.get(node.id)
    if (!entry) {
      // An unaddressed node holds its root position rather than riding its frame: "left where it
      // is" is a claim about the canvas, not about a parent-relative offset.
      const root = currentRoot.get(node.id) ?? node.position
      const position = { x: root.x - origin.x, y: root.y - origin.y }
      if (position.x === node.position.x && position.y === node.position.y) return node
      return { ...node, position }
    }
    // Rule 5: the stored height is ALWAYS the expanded one, so a collapsed entry emits the chrome
    // height on the node while `expandedHeight` keeps the real size. Getting this the other way
    // round makes expanding a restored node snap it to a stale height.
    const collapsed = entry.collapsed === true
    const height = collapsed ? COLLAPSED_HEIGHT : entry.height
    return {
      ...node,
      position: { x: entry.x - origin.x, y: entry.y - origin.y },
      width: entry.width,
      height,
      style: { ...node.style, width: entry.width, height },
      // Rule 7, the reason `withNodeRect` gives: `flowToNodeStates` prefers `measured` over
      // `width`/`height`, so a save racing the re-measure would persist the OLD size.
      measured: undefined,
      // Rule 6 and rule 8 ride on this spread: `premaxRect` and every non-geometry field (title,
      // color, cwd, agentId, accountId, pendingLaunch, trigger, icon, ...) survive untouched. A
      // restore is a placement, not a maximize, so a maximized node keeps its restore rect - the
      // same rule `placeNodeInRect` states for zone snaps.
      data: { ...node.data, collapsed, expandedHeight: entry.height }
    }
  })

  /**
   * Rule 3's one exception, and it exists to protect rule 1. A frame the layout addresses may hold
   * descendants the layout predates; those keep their root position, so a saved rect too small to
   * contain them would let React Flow's `extent: 'parent'` CLAMP them - a node the layout never
   * mentioned would move, with nothing on screen explaining why. So the frame is grown to contain
   * them instead of the node being pushed. Growing a frame is ordinary behavior the user already
   * sees from `fitGroupToChildren`; a terminal that teleports is not. The saved rect stays the
   * floor, so a frame nothing forces open still lands on it exactly.
   */
  const childIds = new Map<string, string[]>()
  for (const node of nodes) {
    if (!node.parentId) continue
    const siblings = childIds.get(node.parentId)
    if (siblings) siblings.push(node.id)
    else childIds.set(node.parentId, [node.id])
  }
  const unplacedDescendants = (frameId: string): CanvasNode[] => {
    const out: CanvasNode[] = []
    const seen = new Set<string>([frameId])
    const queue = [...(childIds.get(frameId) ?? [])]
    while (queue.length) {
      const id = queue.shift()!
      if (seen.has(id)) continue
      seen.add(id)
      const node = byId.get(id)
      if (!node) continue
      // Every level down, not just direct children: a deep node is clamped by its own frame, and
      // that frame is only safe from clamping if this one contains it too.
      if (!placed.has(id) && !EPHEMERAL_KINDS.has(node.type ?? '')) out.push(node)
      queue.push(...(childIds.get(id) ?? []))
    }
    return out
  }
  for (const [id, entry] of placed) {
    if (byId.get(id)?.type !== 'group') continue
    const saved: RootRect = { x: entry.x, y: entry.y, width: entry.width, height: entry.height }
    const grown = grownToContain(
      saved,
      unplacedDescendants(id).map((node) => renderedRootRect(node, nodes))
    )
    if (grown === saved) continue
    next = withFrameRect(next, id, grown)
  }

  // Rule 3's other half: a frame the layout does NOT mention, but whose descendant just moved, is
  // re-fitted around its children so it still hugs them. Deepest first, because a frame must be
  // sized before the frame that has to wrap it (`fitAncestorChain`'s ordering, applied across
  // every moved chain at once rather than per node).
  const toFit = new Map<string, number>()
  for (const id of placed.keys()) {
    const seen = new Set<string>([id])
    let parentId = byId.get(id)?.parentId
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId)
      const parent = byId.get(parentId)
      if (!parent) break
      if (!placed.has(parentId) && parent.type === 'group') {
        toFit.set(parentId, depthOf(parent, byId))
      }
      parentId = parent.parentId
    }
  }
  for (const id of [...toFit.keys()].sort((a, b) => (toFit.get(b) ?? 0) - (toFit.get(a) ?? 0))) {
    next = fitGroupToChildren(next, id)
  }

  return { nodes: next, moved: placed.size, missing, extra }
}
