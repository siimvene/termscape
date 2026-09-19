import { CANVAS_LAYOUTS_CAP, type CanvasLayout, type CanvasLayoutNode } from '@shared/canvas-layout'
import type { Viewport } from '@shared/types'
import type { SaveLayoutResult } from '../state/projects'

/**
 * What the layout SURFACES need: the menu's row order and subtitle, the camera a restore falls back
 * to, and the sentence that reports what a restore did.
 *
 * Pure, and separate from `canvasLayout.ts` (which owns capture and apply) because these are
 * presentation decisions rather than geometry ones. Keeping them here lets the Dock and Canvas share
 * one wording and one ordering instead of each spelling their own.
 */

/**
 * The layouts in menu order: by name, case-insensitively.
 *
 * A list of named things is SCANNED for the one you want, not replayed in the order it was written,
 * so the storage order (append on save) is the wrong order to read in. Stable within a tie, so two
 * layouts that differ only in case keep the order the file gave them.
 */
export function sortedLayouts(layouts: CanvasLayout[] | undefined): CanvasLayout[] {
  return [...(layouts ?? [])].sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  )
}

/**
 * The line under a layout's name: the window it was saved on and how many nodes it addresses.
 *
 * The window size is a LABEL and never a matcher (see `CanvasLayout.window`) - it is here so the
 * user can tell the ultrawide arrangement from the laptop one, which is the whole reason they saved
 * two. A layout with no recorded window shows the node count alone rather than an invented size.
 */
export function layoutSubtitle(layout: CanvasLayout): string {
  const count = `${layout.nodes.length} node${layout.nodes.length === 1 ? '' : 's'}`
  if (!layout.window) return count
  return `${layout.window.width} x ${layout.window.height} - ${count}`
}

/**
 * The camera for a layout this machine has never restored: zoom 1, panned so the top-left node sits
 * just inside the corner.
 *
 * The same rule `framingViewport` (core/workspace-files.ts) applies to a canvas nobody here has
 * framed, reimplemented rather than imported: the renderer has no import path into `src/core`, and
 * that function reads `CanvasNodeState.position` and skips children (whose positions are
 * parent-relative). A layout's rects are ROOT-space, so here EVERY entry anchors the camera - a
 * layout of nothing but framed children would otherwise open on empty space.
 */
export function layoutFramingViewport(nodes: CanvasLayoutNode[]): Viewport {
  let minX = Infinity
  let minY = Infinity
  for (const node of nodes) {
    if (Number.isFinite(node.x) && node.x < minX) minX = node.x
    if (Number.isFinite(node.y) && node.y < minY) minY = node.y
  }
  return {
    x: Number.isFinite(minX) ? 80 - minX : 0,
    y: Number.isFinite(minY) ? 80 - minY : 0,
    zoom: 1
  }
}

/**
 * What to tell the user when a save did not land, or `null` when it did.
 *
 * Every refusal gets a sentence, including the two the Dock's own path cannot reach (a name that
 * survived the trim, a project that is on screen): the store is not this feature's only writer, and
 * a save that reports nothing is indistinguishable from one that worked until the layout is missing
 * from the menu.
 */
export function saveLayoutRefusal(result: SaveLayoutResult): string | null {
  switch (result) {
    case 'saved':
      return null
    case 'cap-reached':
      return `This project already holds the maximum of ${CANVAS_LAYOUTS_CAP} layouts. Delete one before saving another.`
    case 'invalid-name':
      return 'That name is empty once trimmed, so the layout was not saved.'
    case 'unknown-project':
      return 'This project is no longer open, so the layout was not saved.'
  }
}

/**
 * What a restore did, in one sentence, BUILT FROM THE COUNTS `applyLayout` returned so it cannot
 * claim something the transform did not do.
 *
 * A clause whose count is zero is omitted rather than printed as "0" - the ordinary restore then
 * reads as a plain confirmation instead of a report full of nothing.
 */
export function restoreSummary(
  name: string,
  counts: { moved: number; missing: number; extra: number }
): string {
  const parts: string[] = []
  if (counts.moved) parts.push(`${counts.moved} node${counts.moved === 1 ? '' : 's'} moved`)
  if (counts.missing) parts.push(`${counts.missing} no longer on this canvas`)
  if (counts.extra) parts.push(`${counts.extra} not in this layout`)
  return `Restored "${name}": ${parts.length ? parts.join(', ') : 'nothing changed'}.`
}

/**
 * Does this project's `.nodeterm/project.json` live somewhere other people read?
 *
 * A layout is CONTENT, so it sits in that file wherever the file is: in the repo for a folder
 * project, on the host for an SSH one. Both are shared with whoever else opens the project. Only a
 * cwd-less canvas keeps its file inside this machine's userData and is genuinely nobody else's.
 *
 * One definition because two dialogs ask it (delete and update) and a wrong answer is a sentence
 * that lies about who a destructive edit reaches.
 */
export function layoutIsShared(project: { cwd?: string; ssh?: unknown } | undefined): boolean {
  return !!(project?.cwd || project?.ssh)
}

/** The shared half of the two destructive-edit dialogs: who else this reaches. */
const sharedClause = (shared: boolean): string =>
  shared ? ' It is shared with the project, so it changes for everyone who opens it.' : ''

/**
 * Deleting a layout. Confirmed because layout edits are NOT in the undo stack: ⌘Z replays node
 * arrays, and a layout lives beside them rather than in them.
 */
export function deleteLayoutMessage(name: string, shared: boolean): string {
  return `Delete the layout "${name}"?${sharedClause(shared)} This cannot be undone.`
}

/**
 * Overwriting a layout with the arrangement now on screen.
 *
 * Confirmed for the same reason delete is, and it is the reason this is not a bare one-click
 * action: the previous rects are gone the moment it runs, and there is no undo to reach for. The
 * message names what is replaced rather than what is kept, because the saved arrangement is the
 * thing the user is about to lose.
 */
export function updateLayoutMessage(name: string, shared: boolean): string {
  return `Update "${name}" to the arrangement on screen? Its saved positions are replaced.${sharedClause(shared)} This cannot be undone.`
}
