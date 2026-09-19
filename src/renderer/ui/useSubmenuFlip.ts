import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

/** Which side of its row a submenu flyout opens towards. */
export type SubmenuSide = 'right' | 'left'

/** How far the flyout overlaps its row, so the cursor crosses no gap (the `- 4px` in the CSS). */
export const SUBMENU_OVERLAP_PX = 4
/** Viewport margin, the same one `useMenuFlip` keeps. */
const M = 6

/**
 * Which side a submenu should open towards, given where its row sits and how wide the flyout is.
 *
 * Native menus (and the root menu here, via `useMenuFlip`) never let a menu run off screen; the
 * submenu flyout was the one surface that did — it was pinned to `left: calc(100% - 4px)` with no
 * measurement at all, so a context menu opened near the right edge of the window pushed its
 * flyout off-screen entirely. A submenu cannot use `useMenuFlip`'s clamp because it is positioned
 * against its ROW, not the viewport: the fix is a side, not an offset.
 *
 * When neither side fits (a narrow window, a wide flyout) the roomier side wins rather than a
 * refusal — the flyout's own `max-width` then bounds it, so part of it stays reachable either way.
 * Pure so the decision is testable without a DOM.
 */
export function submenuSide(input: {
  /** The submenu ROW's viewport rect edges. */
  rowLeft: number
  rowRight: number
  /** Measured flyout width. */
  width: number
  viewportWidth: number
  margin?: number
}): SubmenuSide {
  const margin = input.margin ?? M
  const rightEdge = input.rowRight - SUBMENU_OVERLAP_PX + input.width
  if (rightEdge <= input.viewportWidth - margin) return 'right'
  const leftEdge = input.rowLeft + SUBMENU_OVERLAP_PX - input.width
  if (leftEdge >= margin) return 'left'
  const roomRight = input.viewportWidth - margin - (input.rowRight - SUBMENU_OVERLAP_PX)
  const roomLeft = input.rowLeft + SUBMENU_OVERLAP_PX - margin
  return roomLeft > roomRight ? 'left' : 'right'
}

/**
 * Measure an open submenu flyout and answer which side it should open towards.
 *
 * Measured after render but BEFORE paint (`useLayoutEffect`), so a flyout never appears on the
 * wrong side first and jumps. Re-measured on size changes for the same reason `useMenuFlip` is: a
 * flyout that grows must be able to change its mind.
 *
 * The rect read is the flyout's OFFSET PARENT — the submenu row — because the flyout's own rect
 * already carries the side we are deciding.
 */
export function useSubmenuFlip(): { ref: RefObject<HTMLDivElement>; side: SubmenuSide } {
  const ref = useRef<HTMLDivElement>(null)
  const [side, setSide] = useState<SubmenuSide>('right')
  useLayoutEffect(() => {
    const el = ref.current
    const row = el?.offsetParent as HTMLElement | null
    if (!el || !row) return
    const measure = (): void => {
      const r = row.getBoundingClientRect()
      const next = submenuSide({
        rowLeft: r.left,
        rowRight: r.right,
        width: el.offsetWidth,
        viewportWidth: window.innerWidth
      })
      setSide((cur) => (cur === next ? cur : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { ref, side }
}
