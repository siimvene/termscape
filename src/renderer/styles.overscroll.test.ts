import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(__dirname, 'styles.css'), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')

describe('canvas browser navigation boundary', () => {
  it('blocks horizontal overscroll navigation at the document root', () => {
    // A canvas-only guard misses gestures bubbling from native node scrollers.
    const root = css.match(/\bhtml,\s*body,\s*#root\s*\{([^}]*)\}/)?.[1]
    expect(root).toBeDefined()
    expect(root).toMatch(/\boverscroll-behavior-x:\s*none\s*;/)
    expect(root).toMatch(/\boverflow:\s*hidden\s*;/)
  })
})
