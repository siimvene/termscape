import { describe, it, expect, vi } from 'vitest'
import { reloadWebview } from './webviewReload'

const guest = () => ({ reload: vi.fn(), reloadIgnoringCache: vi.fn() })

describe('reloadWebview', () => {
  it('a plain click reloads', () => {
    const el = guest()
    reloadWebview(el, false)
    expect(el.reload).toHaveBeenCalledOnce()
    expect(el.reloadIgnoringCache).not.toHaveBeenCalled()
  })

  it('Shift+click bypasses the cache', () => {
    const el = guest()
    reloadWebview(el, true)
    expect(el.reloadIgnoringCache).toHaveBeenCalledOnce()
    expect(el.reload).not.toHaveBeenCalled()
  })

  it('a forced reload never falls back to the cached one', () => {
    const el = { reload: vi.fn() }
    reloadWebview(el, true)
    expect(el.reload).not.toHaveBeenCalled()
  })

  it('does nothing without a guest', () => {
    expect(() => reloadWebview(null, false)).not.toThrow()
    expect(() => reloadWebview(undefined, true)).not.toThrow()
  })

  it('swallows the throw from a guest that has not attached yet', () => {
    const notAttached = {
      reload: () => {
        throw new Error('The WebView must be attached to the DOM')
      },
      reloadIgnoringCache: () => {
        throw new Error('The WebView must be attached to the DOM')
      }
    }
    expect(() => reloadWebview(notAttached, false)).not.toThrow()
    expect(() => reloadWebview(notAttached, true)).not.toThrow()
  })
})
