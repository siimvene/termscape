import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n')

describe('camera-moving raster freeze', () => {
  it('styles.css promotes the viewport only while the camera moves', () => {
    const css = read('styles.css')
    expect(css).toMatch(/\.canvas-camera-moving \.react-flow__viewport\s*\{[^}]*will-change:\s*transform/)
    // Never permanently: a permanent will-change freezes raster scale and blurs text after zoom.
    expect(css).not.toMatch(/(^|\n)\.react-flow__viewport\s*\{[^}]*will-change/)
  })

  it('Canvas adds the class on move start BEFORE the glass early-return, and clears it on end', () => {
    const src = read('canvas/Canvas.tsx')
    const start = src.slice(src.indexOf('const onCanvasMoveStart'), src.indexOf('const onCanvasMoveEnd'))
    const add = start.indexOf("classList.add('canvas-camera-moving')")
    const glassReturn = start.indexOf('if (keepBlurWhileMovingRef.current) return')
    expect(add).toBeGreaterThan(-1)
    expect(add).toBeLessThan(glassReturn)
    const end = src.slice(src.indexOf('const onCanvasMoveEnd'), src.indexOf('const onCanvasMoveEnd') + 600)
    expect(end).toContain("classList.remove('canvas-camera-moving')")
  })
})
