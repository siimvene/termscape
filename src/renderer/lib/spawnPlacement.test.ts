import { describe, it, expect } from 'vitest'
import { spawnSlot, SPAWN_GAP, SPAWN_ROW_GAP, SPAWN_MAX_COLS, type Box } from './spawnPlacement'

const src: Box = { x: 100, y: 100, w: 640, h: 440 }
const size = { w: 640, h: 440 }
const rowY = src.y + src.h + SPAWN_ROW_GAP

describe('spawnSlot — where an agent-opened node lands', () => {
  it('an empty canvas: directly under the source, left-aligned', () => {
    expect(spawnSlot(src, size, [src])).toEqual({ x: src.x, y: rowY })
  })

  // THE BUG: every open-agent call restarted at the same spot, so a conductor's second station
  // landed on its first. The slots a command hands out are obstacles for the next one.
  it('successive nodes fan out RIGHT along the row, not onto each other', () => {
    const first = spawnSlot(src, size, [src])
    const second = spawnSlot(src, size, [src, { ...first, ...size }])
    const third = spawnSlot(src, size, [src, { ...first, ...size }, { ...second, ...size }])
    expect(second).toEqual({ x: src.x + size.w + SPAWN_GAP, y: rowY })
    expect(third).toEqual({ x: src.x + 2 * (size.w + SPAWN_GAP), y: rowY })
  })

  it('a frame sitting under the source is stepped over, never landed on', () => {
    // The screenshot case: a wide group frame directly below the conductor.
    const frame: Box = { x: 0, y: rowY - 20, w: 1500, h: 600 }
    const slot = spawnSlot(src, size, [src, frame])
    const box = { ...slot, ...size }
    const hits = box.x < frame.x + frame.w && box.x + box.w > frame.x && box.y < frame.y + frame.h && box.y + box.h > frame.y
    expect(hits).toBe(false)
    // …and it is the first clear column past the frame, still on the first row.
    expect(slot.y).toBe(rowY)
    expect(slot.x).toBeGreaterThanOrEqual(frame.x + frame.w + SPAWN_GAP)
  })

  it('a full row wraps to the next row, left-aligned again', () => {
    const taken: Box[] = [src]
    for (let c = 0; c < SPAWN_MAX_COLS; c++) {
      taken.push({ x: src.x + c * (size.w + SPAWN_GAP), y: rowY, ...size })
    }
    expect(spawnSlot(src, size, taken)).toEqual({ x: src.x, y: rowY + size.h + SPAWN_GAP })
  })

  it('a different size (a sticky) gets its own slot geometry under the same source', () => {
    const sticky = { w: 240, h: 200 }
    const slot = spawnSlot(src, sticky, [src])
    expect(slot).toEqual({ x: src.x, y: rowY })
    const next = spawnSlot(src, sticky, [src, { ...slot, ...sticky }])
    expect(next).toEqual({ x: src.x + sticky.w + SPAWN_GAP, y: rowY })
  })

  it('never returns an overlap while a clear spot exists (the freeSpot fallback past the grid)', () => {
    // Pack the whole grid under the source; the answer must still be clear of everything.
    const taken: Box[] = [src]
    for (let r = 0; r < 6; r++)
      for (let c = 0; c < SPAWN_MAX_COLS; c++)
        taken.push({ x: src.x + c * (size.w + SPAWN_GAP), y: rowY + r * (size.h + SPAWN_GAP), ...size })
    const slot = spawnSlot(src, size, taken)
    const box = { ...slot, ...size }
    const overlapsAny = taken.some(
      (b) => box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y
    )
    expect(overlapsAny).toBe(false)
  })
})
