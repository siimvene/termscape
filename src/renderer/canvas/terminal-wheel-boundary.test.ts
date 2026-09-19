// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MacWheelGestureRouter } from './wheel-gesture'

/**
 * Issue #767 — where, inside one terminal node, the wheel stops being the terminal's.
 *
 * Wheel routing is a per-packet HIT TEST: `Canvas.tsx` answers `overNativeScrollable` with
 * `target?.closest('.nowheel')`, and React Flow's own `panOnScroll` walks the same class
 * (`noWheelClassName`, default `nowheel`). So the boundary is wherever that class sits in the DOM,
 * and it is invisible — which is what the report is about.
 *
 * #767 names the band by which the body insets the xterm as a place where the wheel silently
 * becomes the canvas's. MEASURED (headless Chromium, `elementFromPoint` over the verbatim rules
 * from styles.css): it is not. `.term-node__xterm` carries `nowheel` AND is `position: absolute;
 * inset: 0` over a body with no padding and no border, so its own padding box — the visible band,
 * and the co-attach letterbox band with it — hit-tests to the host and already routes to the
 * terminal. The styles.css comment the report reads ("insets the xterm by a few px") is about
 * PAINT: the band shows the body's `--term-bg` because the host paints none. Paint and hit test
 * are different questions and only the second decides the wheel.
 *
 * That correctness is INCIDENTAL, though — it rests on a three-link CSS chain nothing enforced.
 * The first describe below turns the chain into an invariant; the second pins the class contract
 * itself, hover guard included, so "the wheel is the terminal's inside the body" cannot be widened
 * or narrowed by accident.
 */
// Paths are resolved from `__dirname`, not `import.meta.url`: this file runs under jsdom, where
// `import.meta.url` is an http:// URL and `readFileSync` refuses it. The CRLF normalization is the
// house rule (`src/shared/line-endings.guard.test.ts`) — the block slicer below keys on `\n`.
const read = (rel: string): string =>
  readFileSync(resolve(__dirname, rel), 'utf8').replace(/\r\n/g, '\n')
/**
 * Comments are stripped BEFORE anything is matched, and that is not tidiness — every rule below
 * carries a comment explaining the very declaration it asserts, so a match against the raw text
 * passes on the PROSE after the declaration is deleted. Both CSS mutations were silently survived
 * until this line existed.
 */
const css = read('../styles.css').replace(/\/\*[\s\S]*?\*\//g, '')
const terminalNode = read('../nodes/TerminalNode.tsx')

/** The declaration block of a rule whose selector list is exactly `selector`. */
const block = (selector: string): string => {
  const at = css.indexOf(`\n${selector} {`)
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1)
  const open = css.indexOf('{', at)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

describe('#767 — the terminal body is one wheel surface (CSS chain)', () => {
  it('the xterm host covers the whole body, so its inset band hit-tests to the host', () => {
    const host = block('.term-node__xterm')
    // Both halves are load-bearing. `inset: 0` is what makes the host's box equal the body's;
    // `position: absolute` is what makes `inset` mean anything. Drop either and the padding band
    // stops belonging to the host — and the wheel there starts panning the canvas.
    expect(host).toMatch(/position:\s*absolute/)
    expect(host).toMatch(/inset:\s*0/)
    // The band exists because the host has padding. That is fine — padding is part of an element's
    // hit area — but it is the reason this test exists, so pin that it is still there.
    expect(host).toMatch(/padding:/)
  })

  it('the body adds no padding and no border of its own', () => {
    // A padding or border on the BODY would push the host inward and open a real band that belongs
    // to nobody — the gap #767 describes. (styles.css already states this for the glyphgrid plate,
    // which measures the host and not the body for exactly the same reason.)
    const body = block('.term-node__body')
    expect(body).not.toMatch(/(^|[;\s])padding\b/)
    expect(body).not.toMatch(/(^|[;\s])border\b/)
  })

  it('overlays laid over a LIVE terminal do not intercept its wheel', () => {
    // These three sit on top of a terminal that is still running and still scrollable, so the
    // pixels have to fall through to the host beneath. The upload note and the copy receipt were
    // already `pointer-events: none` for the same reason; the stale-cwd banner (shared by the
    // launch-too-long and lost-session banners) was not, and is the one thing #767 names that
    // measured true.
    for (const sel of ['.term-node__stalecwd', '.term-node__upload', '.term-copy-pill'])
      expect(block(sel), sel).toMatch(/pointer-events:\s*none/)
    // …and the banner's interactive halves must opt back in, or the fix breaks its buttons.
    expect(block('.term-node__stalecwd-restart,\n.term-node__stalecwd-dismiss')).toMatch(
      /pointer-events:\s*auto/
    )
  })

  it('the overlays that REPLACE the terminal keep the canvas wheel, deliberately', () => {
    // The offscreen plate and the closed/ended/failed/offline notices cover a view that is gone:
    // there is nothing underneath to scroll, so a wheel there panning the canvas is the useful
    // answer, not a bug. Stated as a test so the boundary above is read as a decision.
    for (const sel of ['.term-node__offscreen', '.term-node__closed'])
      expect(block(sel), sel).not.toMatch(/pointer-events:\s*none/)
  })
})

/**
 * The class contract, exercised through the real router with the real predicate from Canvas.tsx.
 * jsdom has no layout, so this pins WHICH ancestor owns each element — not geometry, which the
 * chain above covers.
 */
const node = (): HTMLElement => {
  const root = document.createElement('div')
  root.innerHTML = `
    <div class="react-flow__node">
      <div class="term-node">
        <div class="term-node__header"><span class="term-node__title">t</span></div>
        <div class="term-node__body">
          <div class="term-node__xterm nodrag nowheel">
            <div class="xterm"><div class="xterm-viewport"></div></div>
          </div>
          <div class="term-hover-guard"></div>
        </div>
      </div>
    </div>`
  return root
}

/** Exactly what Canvas.tsx computes per packet. */
const routeOf = (target: Element): 'native' | 'flow-pan' =>
  new MacWheelGestureRouter().destination(
    { deltaY: 6.25, deltaX: 0, deltaMode: 0, ctrlKey: false, metaKey: false },
    true, // macOS + trackpadPan: the configuration #767 reports from
    () => !!target.closest('.nowheel')
  )

describe('#767 — wheel routing inside a terminal node (class contract)', () => {
  const root = node()
  const at = (sel: string): Element => {
    const el = root.querySelector(sel)
    expect(el, sel).not.toBeNull()
    return el as Element
  }

  it('the xterm host and everything xterm renders inside it route to the terminal', () => {
    // The host itself is the element a packet in the inset band lands on.
    expect(routeOf(at('.term-node__xterm'))).toBe('native')
    expect(routeOf(at('.xterm-viewport'))).toBe('native')
  })

  it('the header stays the canvas’s — it is the drag handle, not content', () => {
    expect(routeOf(at('.term-node__header'))).toBe('flow-pan')
    expect(routeOf(at('.term-node__title'))).toBe('flow-pan')
  })

  it('the hover guard keeps panning the canvas — unchanged, and on purpose', () => {
    // While the guard is up (the first `panHoverDelay` ms after the pointer enters, and again
    // after it leaves) it covers the whole body, so the wheel pans even over terminal text. That
    // is the hover guard's own contract — "quick drag = move node, scroll = pan canvas" — and it
    // is what actually makes the boundary time-dependent rather than spatial. #767's fix does not
    // touch it; this test is here so a later change to the body's class cannot silently take the
    // guard's pan away with it.
    expect(routeOf(at('.term-hover-guard'))).toBe('flow-pan')
  })

  it('the class sits on the host, not on the node or the body', () => {
    // The whole-node variant #767 offers would also disable wheel-zoom-to-cursor over every node
    // and swallow the hover guard's pan; keep the placement explicit.
    expect(terminalNode).toContain('term-node__xterm nodrag nowheel')
    expect(terminalNode).not.toMatch(/term-node__body[^"`']*\bnowheel\b/)
  })
})
