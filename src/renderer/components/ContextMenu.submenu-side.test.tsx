// @vitest-environment jsdom
//
// MEASURES that the flyout actually changes side, rather than asserting the hook was called.
//
// `useSubmenuFlip` reads the flyout's `offsetParent` and `offsetWidth`, and jsdom reports 0 for
// both — so a test that renders the menu and expects a flip would pass or fail for reasons that
// have nothing to do with the decision. Both are stubbed here with the geometry of the reported
// case (a menu opened near the right edge of the window), which is the smallest thing that makes
// the render path real: the hook runs in a layout effect, reads the ROW's rect, and stamps
// `data-side` that the stylesheet anchors on.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ContextMenu, type MenuItem } from './ContextMenu'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver

const noop = () => {}
const items: MenuItem[] = [
  { type: 'submenu', label: 'New agent', children: [{ label: 'Claude', onClick: noop }] }
]

/** Place the submenu ROW at `rowLeft` in a 1000px-wide window and give the flyout `width`. */
function renderAt(rowLeft: number, width: number): HTMLElement {
  window.innerWidth = 1000
  const host = document.createElement('div')
  document.body.appendChild(host)
  // The flyout's offsetParent IS its row (the row is `position: relative`), which is what the
  // hook measures — its own rect already carries the side being decided.
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('ctx-submenu') ? this.parentElement : null
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('ctx-submenu') ? width : 0
    }
  })
  act(() => {
    createRoot(host).render(<ContextMenu x={rowLeft} y={0} items={items} onClose={noop} />)
  })
  const row = document.querySelector('.ctx-item--submenu') as HTMLElement
  row.getBoundingClientRect = () =>
    ({ left: rowLeft, right: rowLeft + 200, top: 0, bottom: 30, width: 200, height: 30 }) as DOMRect
  act(() => {
    row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
  return document.querySelector('.ctx-submenu') as HTMLElement
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ContextMenu submenu side', () => {
  it('opens to the right when there is room — the unchanged case', () => {
    expect(renderAt(100, 240).getAttribute('data-side')).toBe('right')
  })

  it('opens to the LEFT near the right edge, instead of off-screen', () => {
    // Row ends at 900; a 240px flyout would reach 1136 in a 1000px window.
    expect(renderAt(700, 240).getAttribute('data-side')).toBe('left')
  })
})
