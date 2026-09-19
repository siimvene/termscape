// Two surfaces host a <webview> — the canvas WebNode and the BrowserSurface shared by the browser
// node and the kanban card modal. A failed page must read the same on both, and a page that failed
// must be COVERED rather than left showing Chromium's own error page, so both go through the one
// module and the one plate. The tempting simplification is a per-surface string, which is how the
// two ended up describing (and, in WebNode's case, not describing) the same failure differently.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const read = (file: string): string => readFileSync(path.join(__dirname, file), 'utf8')

const SURFACES = ['WebNode.tsx', 'BrowserSurface.tsx']

describe('every webview surface reports load failures the same way', () => {
  it.each(SURFACES)('%s describes a failure through the shared module', (file) => {
    const src = read(file)
    expect(src).toContain("from './webviewError'")
    expect(src).toContain('describeLoadFailure(')
    expect(src).toContain('<WebviewErrorPlate')
  })

  it.each(SURFACES)('%s filters the event through isReportableFailure', (file) => {
    const src = read(file)
    expect(src).toContain('isReportableFailure(')
    // Not the inlined predicate this replaced: a bare `!== -3` loses the name of what it skips.
    expect(src).not.toMatch(/errorCode\s*!==\s*-3/)
  })

  it.each(SURFACES)('%s shows the shared bar while a navigation is in flight', (file) => {
    expect(read(file)).toContain('<WebviewLoadingBar')
  })

  it.each(SURFACES)('%s clears the plate on did-start-loading', (file) => {
    // Chromium navigates to its own error page under the URL that just failed, so a new load
    // starting is the only signal that means "we are trying again".
    const src = read(file)
    const start = src.indexOf('const onStart')
    expect(start).toBeGreaterThan(-1)
    expect(src.slice(start, start + 400)).toContain('setFailure(null)')
  })

  // The surfaces genuinely differ here, so each is asserted rather than probed: a handle looked up
  // and not found would take the guard with it and leave the suite green.
  it('BrowserSurface.tsx never clears the plate from did-navigate', () => {
    // Clearing there would wipe the plate the instant Chromium's error page navigated under it.
    const src = read('BrowserSurface.tsx')
    const nav = src.indexOf('const onNav = ')
    const end = src.indexOf('const onNavInPage')
    expect(nav).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(nav)
    expect(src.slice(nav, end)).not.toContain('setFailure(')
  })

  it('WebNode.tsx has no did-navigate handler the plate could be cleared from', () => {
    expect(read('WebNode.tsx')).not.toContain('did-navigate')
  })
})
