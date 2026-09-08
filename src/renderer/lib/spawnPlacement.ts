// Where a node an AGENT opens lands on the canvas (the `nodeterm` CLI's open-*/show-*/sticky/
// spawn-team/open-worktree verbs). Pure, so the rule is unit-testable where the 13,000-line
// canvas component is not.
//
// WHY IT EXISTS: every spawned node used to be placed at ONE spot — centred under the calling
// node, fanned right only by the index WITHIN a single command — with no look at what was already
// there. Each new `open-agent` call restarted at index 0, so the second, third and fourth stations
// a conductor opened over an afternoon landed on exactly the same pixels, and all of them on top of
// whatever frame happened to sit under the conductor. "They just pile up, no organizing" (Siim,
// 2026-09-08). `verify` never had the problem: its panel goes through `freeSpot` with every
// top-level node as an obstacle. This is that rule for everything else.

import { freeSpot, type Box } from './placement'

export type { Box }

/** Vertical gap between the source node and the row its spawned nodes start on. */
export const SPAWN_ROW_GAP = 80
/** Gap kept between spawned nodes and their neighbours. */
export const SPAWN_GAP = 60
/** How many columns a row is tried for before the next row, and how many rows before falling
 *  back to `freeSpot`'s nearest-first ring search. */
export const SPAWN_MAX_COLS = 8
export const SPAWN_MAX_ROWS = 6

const overlaps = (a: Box, b: Box, gap: number): boolean =>
  a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y

/**
 * The top-left of the first clear `size` slot in the rows under `source`: left-aligned with the
 * source, walking RIGHT along a row (`SPAWN_MAX_COLS` cells), then the next row down. Rows first
 * on purpose — a conductor's stations then read as a ribbon under it in the order they were
 * opened, which is what a person expects to see, rather than the nearest-first ring `freeSpot`
 * would pick (which puts the second node to the LEFT of the first). `freeSpot` is the fallback
 * when the grid under the source is full, so the answer is never an overlap while any clear spot
 * exists.
 *
 * `obstacles` are every node already on the canvas in ROOT space — group frames included, since
 * a frame under the conductor is exactly what the old rule landed on — plus the slots this same
 * command has already handed out (the caller accumulates them: the canvas has not seen those
 * nodes yet when the next one is placed).
 */
export function spawnSlot(
  source: Box,
  size: { w: number; h: number },
  obstacles: readonly Box[],
  gap = SPAWN_GAP
): { x: number; y: number } {
  const clear = (x: number, y: number): boolean =>
    !obstacles.some((b) => overlaps({ x, y, w: size.w, h: size.h }, b, gap))
  const x0 = source.x
  const y0 = source.y + source.h + SPAWN_ROW_GAP
  for (let row = 0; row < SPAWN_MAX_ROWS; row++) {
    const y = y0 + row * (size.h + gap)
    for (let col = 0; col < SPAWN_MAX_COLS; col++) {
      const x = x0 + col * (size.w + gap)
      if (clear(x, y)) return { x, y }
    }
  }
  return freeSpot([...obstacles], { x: x0, y: y0 }, size, gap)
}
