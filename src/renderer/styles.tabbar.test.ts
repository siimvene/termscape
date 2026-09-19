import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TABBAR_HEIGHT_PX } from '@shared/window-chrome-metrics'

/**
 * The tab bar's height used to be a literal in four places — the bar's own rule, the kanban
 * overlay's `top`, the usage popover's cap and (in another process) the macOS traffic-light `y`.
 * Shrinking the bar to Chrome's proportions meant finding all of them by hand. Now there is one
 * token, one constant, and this file to keep the two equal and every dependant on the token.
 */
const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8').replace(/\r\n/g, '\n')

/** The value of a `--token:` declaration inside the dark `:root {` block. */
function token(name: string): string {
  const root = CSS.slice(CSS.indexOf(':root {'), CSS.search(/^:root\[data-theme='light'\]\s*\{/m))
  const m = new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm').exec(root)
  if (!m) throw new Error(`${name} is not declared in :root`)
  return m[1].trim()
}

/**
 * The body of the rule whose selector is exactly `selector` — on its own, not as the last line of
 * a selector GROUP (`.tab,\n.tabbar__tabs {` is the no-drag list, not the strip's rule).
 */
function rule(selector: string): string {
  const re = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`, 'gm')
  for (const m of CSS.matchAll(re)) {
    const prev = CSS.lastIndexOf('\n', m.index - 1)
    const prevLine = CSS.slice(CSS.lastIndexOf('\n', prev - 1) + 1, prev).trim()
    if (prevLine.endsWith(',')) continue
    return CSS.slice(m.index, CSS.indexOf('}', m.index))
  }
  throw new Error(`no rule for ${selector}`)
}

describe('tab bar height', () => {
  it('is the shared constant main centres the traffic lights on', () => {
    expect(token('--tabbar-h')).toBe(`${TABBAR_HEIGHT_PX}px`)
  })

  it('is read through the token by the bar and by everything positioned against it', () => {
    expect(rule('.tabbar')).toMatch(/height:\s*var\(--tabbar-h\)/)
    expect(rule('.kanban-overlay')).toMatch(/top:\s*var\(--tabbar-h\)/)
    expect(rule('.usage-popover')).toMatch(/max-height:\s*calc\([^)]*var\(--tabbar-h\)/)
  })

  it('appears as a literal nowhere else — a second copy is the drift this token exists to end', () => {
    // Every `top:`/`height:`/`max-height:` whose value is the bar's own pixel height, outside the
    // token declaration itself. `.chat-node__attach-chip` is a 44px square that happened to share
    // the OLD height; a match here has to name the bar to count.
    const px = `${TABBAR_HEIGHT_PX}px`
    const offenders = CSS.split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => new RegExp(`^\\s*(top|height|max-height):\\s*${px};`).test(line))
      .filter(({ line }) => /tab ?bar/i.test(line))
    expect(offenders).toEqual([])
  })
})

describe('tab strip geometry', () => {
  it('lets the active tab reach the bar\'s bottom while the hover pill stays inset', () => {
    expect(rule('.tab')).toMatch(/margin:\s*var\(--tab-inset\)\s+0/)
    expect(rule('.tab.active')).toMatch(/margin-bottom:\s*0/)
    expect(rule('.tab.active')).toMatch(/background:\s*var\(--canvas-bg\)/)
  })

  it('draws the concave flares in the surface colour the tab merges into', () => {
    const flares = rule('.tab.active::after')
    expect(flares.match(/radial-gradient/g)).toHaveLength(2)
    expect(flares.match(/var\(--canvas-bg\)/g)).toHaveLength(2)
    // The strip must leave room for them, or the first/last tab's flare is clipped by the scroller.
    expect(rule('.tabbar__tabs')).toMatch(/padding:\s*0\s+var\(--tab-flare\)/)
  })

  it('sizes every tab by its own NAME, and scrolls instead of shortening one', () => {
    const tab = rule('.tab')
    // Content width, never a shared basis: the two earlier rounds (#789, #790) both rationed the
    // name between tabs, which is the one thing the strip exists to show.
    expect(tab).toMatch(/max-width:\s*var\(--tab-max\)/)
    expect(tab).toMatch(/flex:\s*0 0 auto/)
    expect(tab).not.toMatch(/width:\s*var\(--tab-w\)/)
    const name = rule('.tab__name')
    // Ellipsis, not the old fade: a mask gradient is unconditional and would fade the tail of a
    // name that fits perfectly, which is most names now.
    expect(name).toMatch(/text-overflow:\s*ellipsis/)
    expect(name).not.toMatch(/mask-image/)
    expect(name).not.toMatch(/min-width:\s*var\(--tab-name-min\)/)
    // The strip is the thing that gives way.
    expect(rule('.tabbar__tabs')).toMatch(/overflow-x:\s*auto/)
  })

  it('carries no density machinery any more — nothing sheds furniture to buy name width', () => {
    // `lib/tabDensity.ts` is deleted with this change: with full names there is no name budget to
    // protect, and shedding the SSH chip took a LABEL off every remote tab at the width people
    // work at (the report that ended the previous approach).
    expect(CSS).not.toMatch(/data-density/)
  })
})
