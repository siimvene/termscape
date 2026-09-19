import type { Viewport } from './types'

/**
 * A canvas layout is a NAMED SNAPSHOT OF NODE GEOMETRY for one project: where every node sat, how
 * big it was, and whether it was collapsed. It exists so an arrangement made for an ultrawide
 * monitor can be restored after a day on the laptop screen, without rebuilding it by hand.
 *
 * It carries GEOMETRY ONLY, and that is the whole safety story. A restore never creates, deletes,
 * renames, recolors, reparents or respawns a node, and never touches a tmux session - so the worst
 * a bad layout can do is move things, which the user can undo. The moment a layout could carry a
 * node's identity (a `cwd`, a command, an agent id) it would become a second, stale copy of the
 * canvas competing with `project.json`, and restoring it would be a merge rather than a move.
 *
 * The snapshot is CONTENT: it rides the git-shared `.nodeterm/project.json` beside `nodes` and
 * `kanban`, because node geometry is already shared content in that file and a restore writes
 * exactly those fields. The camera precedent (`viewport`, `breadcrumbs`) deliberately does NOT
 * reach here - those are camera facts, and nobody else's canvas moves when I pan. This machine's
 * camera per layout is the separate, machine-local `LayoutViewports`.
 *
 * Everything here therefore treats its input as hostile: `.nodeterm/project.json` is git-shared,
 * cloned and hand-editable, exactly like the node icons and trigger specs beside it. The readers
 * below DROP rather than repair, for the same reason `sanitizeLoadedClosedSessions` does - a
 * half-honored geometry is a canvas that is wrong in a way nobody can see.
 */

/**
 * One node's remembered rect inside a layout.
 *
 * The rect is ROOT-space - the coordinate space `withNodeRect` (renderer/state/workspace.ts)
 * already speaks - so a node whose frame was ungrouped, moved or re-fitted since the layout was
 * saved still lands where the author put it on screen, rather than a few hundred pixels off its
 * old parent's origin.
 */
export interface CanvasLayoutNode {
  id: string
  x: number
  y: number
  width: number
  /**
   * Always the EXPANDED height, matching the rule `flowToNodeStates` uses when it serializes a
   * collapsed node: a collapsed node's on-screen height is chrome, not a size the user chose, and
   * storing it would make every save-while-collapsed shrink the node permanently.
   */
  height: number
  collapsed?: boolean
  /**
   * The parent frame at capture time. Recorded so a restore can be HONEST about what changed (a
   * node that has since moved to another frame is a fact worth reporting); never used to reparent
   * anything, which would make a restore a structural edit rather than a move.
   */
  parentId?: string
}

/** A named geometry snapshot for one project. See the module doc block for the trust model. */
export interface CanvasLayout {
  id: string
  /** Trimmed, at most `CANVAS_LAYOUT_NAME_MAX` characters. */
  name: string
  createdAt: number
  updatedAt: number
  /**
   * The AUTHOR's window size when they saved it. A LABEL for the reader ("this one was made on the
   * 34 inch"), never a matcher and never a claim about the machine reading it: the file travels,
   * so auto-selecting a layout from it would pick a stranger's monitor for the user's screen.
   */
  window?: { width: number; height: number }
  nodes: CanvasLayoutNode[]
}

/**
 * This machine's camera per layout, keyed by layout id.
 *
 * MACHINE-LOCAL: it rides `IndexEntryV3.layoutViewports` and is never written into the shared
 * project file, the same rule `viewport` and `breadcrumbs` follow. Where a teammate was looking
 * when they saved the arrangement is not something a repo carries.
 */
export type LayoutViewports = Record<string, Viewport>

/** How many layouts one project may keep. A layout is a full node-geometry list, and the file it
 *  lives in is committed and cloned, so the list is bounded rather than left to grow. */
export const CANVAS_LAYOUTS_CAP = 20

/** Longest a layout name may be. It is rendered in a menu, and the file it rides is git-shared,
 *  so an unbounded string is a blob in everyone's checkout (the `NodeIcon` emoji rule). */
export const CANVAS_LAYOUT_NAME_MAX = 60

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * The tolerant reader for one layout node entry, or `null` when the entry is unusable.
 *
 * A non-finite coordinate is the crash, not a tidiness concern: a restore assigns these straight
 * onto `node.position` / the node size, and React Flow's `adoptUserNodes` dereferences the
 * position unguarded - a white-screen renderer crash from a file anyone can commit. `NaN` also
 * survives a round trip in the worst possible way: `JSON.stringify` writes it back into the
 * committed file as `null`, so one bad edit becomes a permanently broken shared document.
 *
 * Unknown fields are dropped rather than carried: whatever we admit is what a later
 * `projectToFile` writes back, so passing an unrecognized key through would let a hand edit
 * accumulate in everyone's checkout.
 */
function sanitizeLayoutNode(x: unknown): CanvasLayoutNode | null {
  if (!x || typeof x !== 'object') return null
  const n = x as Partial<CanvasLayoutNode>
  if (typeof n.id !== 'string' || !n.id) return null
  if (!isFiniteNumber(n.x) || !isFiniteNumber(n.y)) return null
  if (!isFiniteNumber(n.width) || !isFiniteNumber(n.height)) return null
  return {
    id: n.id,
    x: n.x,
    y: n.y,
    width: n.width,
    height: n.height,
    ...(n.collapsed === true ? { collapsed: true } : {}),
    ...(typeof n.parentId === 'string' && n.parentId ? { parentId: n.parentId } : {})
  }
}

/** The author's window size, or `undefined`: both numbers must be finite and positive, because the
 *  value is only ever shown as a label and a `0 x 0` or `NaN x NaN` label is worse than none. */
function sanitizeLayoutWindow(x: unknown): { width: number; height: number } | undefined {
  if (!x || typeof x !== 'object') return undefined
  const w = x as Partial<{ width: number; height: number }>
  if (!isFiniteNumber(w.width) || !isFiniteNumber(w.height)) return undefined
  if (w.width <= 0 || w.height <= 0) return undefined
  return { width: w.width, height: w.height }
}

/**
 * The tolerant reader for a project's layouts, applied on BOTH sides of the shared-file boundary
 * (`fileToProject` on the way in, `projectToFile` on the way out) - the same two-seam rule
 * `normalizeNodeIcon` and `sanitizeNodeTriggers` follow. Live node data is reachable by a peer
 * canvas mutation, and whatever we write is what the next machine trusts, so validating only the
 * read direction passes every round-trip test while leaving the other one open.
 *
 * It DROPS rather than repairs. A layout is dropped WHOLE when any part of it is wrong: a repaired
 * layout is one that silently no longer describes the arrangement it is named after, and a
 * half-restored canvas is wrong in a way the user cannot see. See `sanitizeLayoutNode` for why a
 * non-finite coordinate in particular is a crash rather than a blemish.
 *
 * Returns `undefined` - never `[]` - for anything that fails or has nothing to admit, the
 * convention `sanitizeLoadedClosedSessions` sets: an absent field adds no bytes to the committed
 * file, while an empty array does.
 */
export function sanitizeLayouts(x: unknown): CanvasLayout[] | undefined {
  if (!Array.isArray(x)) return undefined
  const out: CanvasLayout[] = []
  for (const raw of x) {
    if (out.length >= CANVAS_LAYOUTS_CAP) break
    if (!raw || typeof raw !== 'object') continue
    const l = raw as Partial<CanvasLayout>
    if (typeof l.id !== 'string' || !l.id) continue
    if (typeof l.name !== 'string') continue
    if (!isFiniteNumber(l.createdAt) || !isFiniteNumber(l.updatedAt)) continue
    if (!Array.isArray(l.nodes)) continue
    const name = l.name.trim().slice(0, CANVAS_LAYOUT_NAME_MAX)
    if (!name) continue
    const nodes: CanvasLayoutNode[] = []
    let bad = false
    for (const entry of l.nodes) {
      const node = sanitizeLayoutNode(entry)
      if (!node) { bad = true; break }
      nodes.push(node)
    }
    if (bad) continue
    const window = sanitizeLayoutWindow(l.window)
    out.push({
      id: l.id,
      name,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
      ...(window ? { window } : {}),
      nodes
    })
  }
  return out.length ? out : undefined
}

/**
 * The tolerant reader for this machine's per-layout cameras. Same rules as `sanitizeLayouts`, one
 * layer down: workspace.json is hand-editable too, and a non-finite `zoom` reaching `setViewport`
 * blanks the canvas just as effectively as a non-finite position does.
 */
export function sanitizeLayoutViewports(x: unknown): LayoutViewports | undefined {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return undefined
  const out: LayoutViewports = {}
  for (const [key, value] of Object.entries(x as Record<string, unknown>)) {
    if (!key) continue
    if (!value || typeof value !== 'object') continue
    const v = value as Partial<Viewport>
    if (!isFiniteNumber(v.x) || !isFiniteNumber(v.y) || !isFiniteNumber(v.zoom)) continue
    out[key] = { x: v.x, y: v.y, zoom: v.zoom }
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * Drops camera entries naming no live layout.
 *
 * workspace.json is forever and a canvas churns through ids, so an id-keyed machine-local map that
 * is only ever added to grows without bound - the rule `pruneCollapsedItems` states for
 * `settings.sidebarCollapsedItems`. Run on both save and load, so a layout deleted by a teammate
 * (the layouts are shared, the cameras are not) cannot leave a permanent orphan here.
 */
export function pruneLayoutViewports(
  views: LayoutViewports | undefined,
  layouts: CanvasLayout[] | undefined
): LayoutViewports | undefined {
  if (!views) return undefined
  const live = new Set((layouts ?? []).map((l) => l.id))
  const out: LayoutViewports = {}
  for (const [key, value] of Object.entries(views)) {
    if (live.has(key)) out[key] = value
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * The layout whose name matches `name`, ignoring case and surrounding space.
 *
 * Name uniqueness is enforced HERE, at the point of save, and deliberately NOT as an invariant
 * over the list: the layouts are git-shared, so a merge can legitimately land two called
 * "Ultrawide", and silently dropping a teammate's on load is the worse failure. The UI asks this
 * before saving and offers to replace; nothing repairs a list that already holds a duplicate.
 *
 * The needle is normalized exactly the way a save normalizes it (trim, then the same cap), or a
 * 70-character name would match nothing, pass the ask, and then be stored under the 60-character
 * name it collides with.
 */
export function findLayoutByName(
  layouts: CanvasLayout[] | undefined,
  name: string
): CanvasLayout | undefined {
  const needle = name.trim().slice(0, CANVAS_LAYOUT_NAME_MAX).toLowerCase()
  if (!needle) return undefined
  return (layouts ?? []).find((l) => l.name.trim().toLowerCase() === needle)
}
