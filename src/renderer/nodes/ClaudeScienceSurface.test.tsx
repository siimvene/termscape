// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeScienceSurface } from './ClaudeScienceSurface'
import { useSettings } from '../state/settings'
import { DEFAULT_SETTINGS } from '@shared/types'

vi.mock('../bridge/runtime', () => ({ isBrowserRuntime: () => true }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
let api: { open: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; logs: ReturnType<typeof vi.fn> }
const original = useSettings.getState()
let order: string[]

beforeEach(() => {
  order = []
  api = {
    open: vi.fn(async () => { order.push('open'); return '/apps/claude-science/?nonce=ephemeral' }),
    status: vi.fn(async () => ({ installed: true, enabled: true, running: true, previewConfigured: true })),
    stop: vi.fn(async () => {}), logs: vi.fn(async () => '')
  }
  window.nodeTerminal = { science: api } as unknown as typeof window.nodeTerminal
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, claudeScienceEnabled: false },
    update: (patch) => useSettings.setState((s) => ({ settings: { ...s.settings, ...patch } })),
    flush: async () => { order.push('save') }
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useSettings.setState(original)
})

describe('Science panel permission and lifecycle', () => {
  it('requires consent before launching, saves consent before opening, and leaves work running on close', async () => {
    await act(async () => root.render(<ClaudeScienceSurface />))
    expect(api.open).not.toHaveBeenCalled()
    const allow = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Allow Claude Science panels')!
    await act(async () => allow.click())
    expect(order).toEqual(['save', 'open'])
    expect(host.querySelector('iframe')?.getAttribute('src')).toBe('/apps/claude-science/?nonce=ephemeral')
    expect(api.stop).not.toHaveBeenCalled()
    await act(async () => useSettings.setState((s) => ({ settings: { ...s.settings, claudeScienceEnabled: false } })))
    expect(host.querySelector('iframe')).toBeNull()
    expect(api.stop).not.toHaveBeenCalled()
  })

  it('refuses a remote bridge response that would navigate the viewer outside the managed proxy', async () => {
    api.open.mockResolvedValue('http://localhost:8765/?nonce=secret')
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, claudeScienceEnabled: true } })
    await act(async () => root.render(<ClaudeScienceSurface />))
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('unexpected URL')
    expect(host.querySelector('iframe')).toBeNull()
  })
})
