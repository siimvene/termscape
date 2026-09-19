// @vitest-environment jsdom
//
// MEASURES the submenu depth cap, rather than asserting it from the source.
//
// `ContextMenu` renders a submenu's children with
// `if (child.type === 'colors' || child.type === 'submenu') return null` — so a THIRD level is
// dropped with no error, no warning and nothing on screen. That is not a style rule anybody can
// choose to ignore: it is why `lib/addMenuSpec`'s `isPinnedAgentEntry` refuses to nest an agent
// row that is already a submenu. Claude's and Codex's account pickers ARE such rows, so nesting
// one would silently delete the account picker for exactly the users who have managed accounts —
// the "looks like it worked" failure, visible only to the people it breaks.
//
// If someone teaches ContextMenu to render a third level, this test goes red and the pin in
// addMenuSpec can be reconsidered deliberately. Until then it is the fact the grouping rests on.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ContextMenu, type MenuItem } from './ContextMenu'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom ships no ResizeObserver, and `useMenuFlip` (the edge-flip this menu uses) observes itself.
// The flip geometry is not what is under test here — reachability of the rows is — so a inert stub
// is enough, and leaves the component's real render path untouched.
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver

const noop = () => {}

afterEach(() => {
  document.body.innerHTML = ''
})

/** Renders into a body portal; hovers the row with `label` so its flyout opens. */
function renderMenu(items: MenuItem[], hoverLabel?: string): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  act(() => {
    createRoot(host).render(<ContextMenu x={0} y={0} items={items} onClose={noop} />)
  })
  if (!hoverLabel) return
  const row = [...document.querySelectorAll('.ctx-item--submenu')].find((el) =>
    el.textContent?.includes(hoverLabel)
  )
  if (!row) throw new Error(`no submenu row labelled ${hoverLabel}`)
  // React synthesises onMouseEnter from the delegated mouseover event.
  act(() => {
    row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
}

describe('ContextMenu submenu depth', () => {
  it('renders a second-level LEAF, including its disabled state and reason', () => {
    renderMenu(
      [
        {
          type: 'submenu',
          label: 'Orchestrate',
          children: [
            { label: 'New branch checkout…', onClick: noop, disabled: true, hint: 'Not supported in SSH' }
          ]
        }
      ],
      'Orchestrate'
    )
    const leaf = [...document.querySelectorAll('.ctx-submenu button')].find((b) =>
      b.textContent?.includes('New branch checkout…')
    ) as HTMLButtonElement | undefined
    expect(leaf).toBeDefined()
    // A leaf keeps BOTH halves of an explicit degrade inside a flyout — the depth cap drops
    // nested submenus, never a leaf's disabled state or its reason.
    expect(leaf?.disabled).toBe(true)
    expect(leaf?.getAttribute('title')).toBe('Not supported in SSH')
  })

  it('DROPS a third-level submenu silently — nothing is rendered for it', () => {
    renderMenu(
      [
        {
          type: 'submenu',
          label: 'New agent',
          children: [
            { label: 'New Gemini', onClick: noop },
            {
              type: 'submenu',
              label: 'New Codex',
              children: [{ label: 'work@example.com', onClick: noop }]
            }
          ]
        }
      ],
      'New agent'
    )
    const flyout = document.querySelector('.ctx-submenu')
    expect(flyout?.textContent).toContain('New Gemini')
    // The measurement this whole design rests on: the nested submenu row is GONE, and so is the
    // account it held. No error, no placeholder — which is why the grouping must never create one.
    expect(flyout?.textContent).not.toContain('New Codex')
    expect(flyout?.textContent).not.toContain('work@example.com')
  })
})
