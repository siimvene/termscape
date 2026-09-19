// Two surfaces reload a guest — the canvas WebNode's header button and the BrowserSurface toolbar
// shared by the browser node and the kanban card modal. Both must go through `reloadWebview`, which
// is where the two rules live: Shift bypasses the cache and never silently falls back to a cached
// re-fetch, and a guest that has not attached yet throws instead of reloading. Calling the element's
// own methods works in the happy path and loses both, which is exactly the "simplification" a later
// refactor reaches for — so it is pinned at source level.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const read = (file: string): string => readFileSync(path.join(__dirname, file), 'utf8')

const SURFACES = ['WebNode.tsx', 'BrowserSurface.tsx']

describe('every reload path goes through reloadWebview', () => {
  it.each(SURFACES)('%s reloads through the helper, carrying the Shift modifier', (file) => {
    const src = read(file)
    expect(src).toContain("from './webviewReload'")
    expect(src).toMatch(/reloadWebview\([^)]*e\.shiftKey\)/)
  })

  it.each(SURFACES)('%s never calls the guest reload methods directly', (file) => {
    expect(read(file)).not.toMatch(/\.current\??\.reload(IgnoringCache)?\s*\(/)
  })
})
