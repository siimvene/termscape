// @vitest-environment jsdom
// Pi account label edit, node color, and remove — mirrors the shape of
// AccountsSection.color.test.tsx and the Claude/Codex remove paths, for the pi row.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { AccountsSection } from './AccountsSection'
import { useSettings } from '../../../state/settings'
import { useProjects } from '../../../state/projects'
import { DEFAULT_SETTINGS, type Project } from '@shared/types'
import type { PiAccount } from '@shared/pi-account'

const account: PiAccount = { id: 'p1', label: 'work pi', pending: false, createdAt: 0 }

let removedIds: string[]
/** When set, the fake `piAccounts.remove` rejects with this message instead of recording the id. */
let removeRejectsWith: string | null = null

function renderSection(accounts: PiAccount[]): { host: HTMLElement; root: Root } {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, piAccounts: accounts } })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(<AccountsSection isActive />)
  })
  return { host, root }
}

function swatch(host: HTMLElement, label: string, name: string): HTMLButtonElement {
  const group = host.querySelector(`[aria-label="Default node color for ${label}"]`)
  expect(group).toBeTruthy()
  const btn = Array.from(group!.querySelectorAll('button')).find(
    (b) => b.getAttribute('aria-label') === name
  )
  expect(btn, `no swatch "${name}"`).toBeTruthy()
  return btn as HTMLButtonElement
}

const piOf = (id: string): PiAccount | undefined =>
  useSettings.getState().settings.piAccounts.find((a) => a.id === id)

const until = async (pred: () => boolean, ms = 1500): Promise<void> => {
  const deadline = Date.now() + ms
  while (!pred() && Date.now() < deadline) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

beforeEach(() => {
  document.body.innerHTML = ''
  removedIds = []
  removeRejectsWith = null
  useProjects.setState({
    projects: [
      {
        id: 'proj1',
        name: 'p',
        cwd: '/tmp',
        nodes: [
          { id: 'login-node', accountId: 'p1', title: 'Pi login', piLogin: true },
          { id: 'plain-node', accountId: 'p1', title: 'shell' }
        ]
      } as unknown as Project
    ],
    activeProjectId: 'proj1'
  })
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    usage: { fetch: async () => null },
    ssh: { list: async () => [] },
    codexAccounts: { systemIdentity: async () => null, identity: async () => null },
    piAccounts: {
      remove: async (id: string) => {
        if (removeRejectsWith) throw new Error(removeRejectsWith)
        removedIds.push(id)
      },
      cancelWaitLogin: async () => {}
    },
    settings: { save: async () => {} }
  }
})

afterEach(() => {
  useSettings.setState({ settings: DEFAULT_SETTINGS })
  useProjects.setState({ projects: [], activeProjectId: undefined })
})

describe('AccountsSection — Pi account label + color', () => {
  it('renames the row', () => {
    const { host, root } = renderSection([account])
    const input = Array.from(host.querySelectorAll('input')).find(
      (i) => i.value === 'work pi'
    ) as HTMLInputElement
    expect(input).toBeTruthy()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setter.call(input, 'renamed pi')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(piOf('p1')?.label).toBe('renamed pi')
    expect(piOf('p1')?.labelEdited).toBe(true)
    root.unmount()
  })

  it('stores the picked color on the account', () => {
    const { host, root } = renderSection([account])
    act(() => {
      swatch(host, 'work pi', 'Node color Blue').click()
    })
    expect(piOf('p1')?.color).toBe('#0a84ff')
    root.unmount()
  })
})

describe('AccountsSection — removing a Pi account', () => {
  it('removes the row, drops its bound login node, and clears its id off other nodes', async () => {
    const { host, root } = renderSection([account])
    const removeBtn = host.querySelector('[aria-label="Remove Pi account"]') as HTMLButtonElement
    expect(removeBtn).toBeTruthy()
    await act(async () => {
      removeBtn.click()
    })
    // Confirm dialog now visible — click its confirm button.
    const confirmBtn = Array.from(document.querySelectorAll('button')).find((b) =>
      /^remove$/i.test((b.textContent ?? '').trim())
    ) as HTMLButtonElement
    expect(confirmBtn).toBeTruthy()
    await act(async () => {
      confirmBtn.click()
    })
    await until(() => removedIds.includes('p1'))
    expect(useSettings.getState().settings.piAccounts).toEqual([])
    const nodes = useProjects.getState().projects[0].nodes
    // The login node (isPiAccountLoginNode) is dropped entirely...
    expect(nodes.find((n) => n.id === 'login-node')).toBeUndefined()
    // ...while a plain node bound to the same account just loses the accountId.
    const plain = nodes.find((n) => n.id === 'plain-node') as { accountId?: string } | undefined
    expect(plain?.accountId).toBeUndefined()
    root.unmount()
  })

  it('a refused remove keeps the row and its nodes, and says why (no unhandled rejection)', async () => {
    removeRejectsWith = 'lock timeout'
    const unhandled: unknown[] = []
    const onUnhandled = (e: PromiseRejectionEvent): void => {
      unhandled.push(e.reason)
      e.preventDefault()
    }
    window.addEventListener('unhandledrejection', onUnhandled)
    const { host, root } = renderSection([account])
    try {
      const removeBtn = host.querySelector('[aria-label="Remove Pi account"]') as HTMLButtonElement
      await act(async () => {
        removeBtn.click()
      })
      const confirmBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        /^remove$/i.test((b.textContent ?? '').trim())
      ) as HTMLButtonElement
      await act(async () => {
        confirmBtn.click()
      })
      await until(() => /couldn.t remove/i.test(host.textContent ?? ''))
      expect(host.textContent).toMatch(/couldn.t remove "work pi"/i)
      // The shell refused: the row is still there, the login node is still there, nothing was
      // unbound — the account's credential dir survives, so the UI must not pretend it is gone.
      expect(piOf('p1')).toBeTruthy()
      const nodes = useProjects.getState().projects[0].nodes
      expect(nodes.find((n) => n.id === 'login-node')).toBeTruthy()
      expect((nodes.find((n) => n.id === 'plain-node') as { accountId?: string }).accountId).toBe('p1')
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20))
      })
      expect(unhandled).toEqual([])
    } finally {
      window.removeEventListener('unhandledrejection', onUnhandled)
      root.unmount()
    }
  })
})
