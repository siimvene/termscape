import { describe, expect, it } from 'vitest'
import {
  installWindowActivity,
  resolveWindowActivity,
  WINDOW_ACTIVITY_ATTR,
  type WindowActivityDeps
} from './windowActivity'

function harness(init: { focused: boolean; hidden: boolean }) {
  const attrs = new Map<string, string>()
  const listeners = new Map<string, Set<() => void>>()
  const state = { ...init }
  const deps: WindowActivityDeps = {
    root: {
      setAttribute: (n, v) => void attrs.set(n, v),
      removeAttribute: (n) => void attrs.delete(n)
    },
    hasFocus: () => state.focused,
    isHidden: () => state.hidden,
    addEventListener: (type, l) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(l)
    },
    removeEventListener: (type, l) => void listeners.get(type)?.delete(l)
  }
  return {
    deps,
    state,
    attr: () => attrs.get(WINDOW_ACTIVITY_ATTR),
    fire: (type: string) => {
      for (const l of listeners.get(type) ?? []) l()
    },
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0)
  }
}

describe('resolveWindowActivity', () => {
  it('is active only when focused AND visible', () => {
    expect(resolveWindowActivity(true, false)).toBe('active')
    expect(resolveWindowActivity(false, false)).toBe('idle')
    expect(resolveWindowActivity(true, true)).toBe('idle')
    expect(resolveWindowActivity(false, true)).toBe('idle')
  })

  it('treats a VISIBLE but unfocused window as idle — the case the gate exists for', () => {
    // A nodeterm window sitting on a second monitor while its owner works elsewhere is not hidden
    // by any definition Chromium uses, and composites at full display rate. If this ever flips to
    // 'active' the feature is inert on the only scenario that motivated it.
    expect(resolveWindowActivity(false, false)).toBe('idle')
  })
})

describe('installWindowActivity', () => {
  it('leaves NO attribute while active, so a never-blurred window is unchanged', () => {
    const h = harness({ focused: true, hidden: false })
    installWindowActivity(h.deps)
    expect(h.attr()).toBeUndefined()
  })

  it('marks idle on blur and clears it again on focus', () => {
    const h = harness({ focused: true, hidden: false })
    installWindowActivity(h.deps)

    h.state.focused = false
    h.fire('blur')
    expect(h.attr()).toBe('idle')

    h.state.focused = true
    h.fire('focus')
    expect(h.attr()).toBeUndefined()
  })

  it('marks idle when the page is hidden even though it still has focus', () => {
    const h = harness({ focused: true, hidden: false })
    installWindowActivity(h.deps)
    h.state.hidden = true
    h.fire('visibilitychange')
    expect(h.attr()).toBe('idle')
  })

  it('applies the initial state at install time, not only on the first event', () => {
    // The page can be restored into an unfocused window (a reload while the user is in another
    // app); waiting for an event would leave every animation running until they came back.
    const h = harness({ focused: false, hidden: false })
    installWindowActivity(h.deps)
    expect(h.attr()).toBe('idle')
  })

  it('resolves blur+hide landing in the same tick to one value, whichever event ran last', () => {
    // ⌘H fires both. Each listener re-reads BOTH facts rather than asserting the one it knows
    // about, so the second listener to run cannot undo the first.
    const h = harness({ focused: true, hidden: false })
    installWindowActivity(h.deps)
    h.state.focused = false
    h.state.hidden = true
    h.fire('blur')
    h.fire('visibilitychange')
    expect(h.attr()).toBe('idle')
  })

  it('falls back to active when the environment cannot answer', () => {
    // Fail-safe direction: a wrong answer costs a running animation, never a frozen one.
    const h = harness({ focused: true, hidden: false })
    h.deps.hasFocus = () => {
      throw new Error('no focus API')
    }
    installWindowActivity(h.deps)
    expect(h.attr()).toBeUndefined()
  })

  it('removes every listener on teardown', () => {
    const h = harness({ focused: true, hidden: false })
    const stop = installWindowActivity(h.deps)
    expect(h.listenerCount()).toBeGreaterThan(0)
    stop()
    expect(h.listenerCount()).toBe(0)
  })

  it('writes only on a change', () => {
    const writes: string[] = []
    const h = harness({ focused: true, hidden: false })
    h.deps.root = {
      setAttribute: (_n, v) => void writes.push('set:' + v),
      removeAttribute: () => void writes.push('remove')
    }
    installWindowActivity(h.deps)
    h.state.focused = false
    h.fire('blur')
    h.fire('blur')
    h.fire('visibilitychange')
    // The leading removal is the install seeding a known state (it clears a stale value left by a
    // previous install); after that only real transitions reach the DOM.
    expect(writes).toEqual(['remove', 'set:idle'])
  })
})
