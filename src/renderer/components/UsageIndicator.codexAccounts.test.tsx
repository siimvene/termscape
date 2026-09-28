// @vitest-environment jsdom
//
// Codex rows are ACCOUNT rows, like Claude's: three Codex logins must read as three accounts, not
// as three blocks titled "Codex" told apart only by an email line (user report, 2026-09-28). Each
// is headed by its account, carries the provider as a chip, and gets the same two actions — "Use
// for new sessions" (project.defaultCodexAccountId, NOT the Claude default) and "Move N sessions"
// (Codex sessions only, onto another Codex account of the same machine).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { UsageIndicator } from './UsageIndicator'
import { useSettings } from '../state/settings'
import { useProjects } from '../state/projects'
import { DEFAULT_SETTINGS, type ClaudeUsage, type ProviderUsage, type UsageLimit } from '@shared/types'

const limit: UsageLimit = {
  kind: 'session',
  group: 'session',
  usedPercent: 40,
  severity: null,
  resetsAt: null,
  windowMinutes: null,
  scopeLabel: null,
  isActive: false
}
const claude: ClaudeUsage = {
  limits: [limit],
  session: null,
  weekly: null,
  email: 'claude@example.com',
  updatedAt: 0,
  status: 'ok'
}
const codexRow = (account: string, accountId?: string): ProviderUsage => ({
  provider: 'codex',
  limits: [limit],
  account,
  ...(accountId ? { accountId } : {}),
  updatedAt: 0,
  status: 'ok'
})

let root: Root
let host: HTMLElement
const onSetDefault = vi.fn()
const onSetDefaultCodex = vi.fn()
const onMove = vi.fn()
const onMoveCodex = vi.fn()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  for (const f of [onSetDefault, onSetDefaultCodex, onMove, onMoveCodex]) f.mockReset()
  useSettings.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      // A Claude account with the SAME id as a Codex one: the rows must never cross wires.
      claudeAccounts: [{ id: 'cx1', label: 'Claude twin', email: 'twin@example.com', createdAt: 0 }],
      codexAccounts: [
        { id: 'cx1', label: 'Taltech', email: 'two@example.com' },
        { id: 'cx2', label: 'PLG', email: 'three@example.com' },
        { id: 'cx3', label: 'New Codex account', pending: true }
      ]
    },
    hydrated: true
  })
  useProjects.setState({
    projects: [{ id: 'p1', name: 'local', nodes: [], defaultCodexAccountId: 'cx1' } as never],
    activeProjectId: 'p1'
  })
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    usage: {
      fetch: async () => claude,
      onUpdate: () => () => {},
      providers: async () => [
        codexRow('one@example.com'),
        codexRow('two@example.com', 'cx1'),
        codexRow('three@example.com', 'cx2')
      ],
      remote: async () => []
    },
    settings: { save: async () => {} }
  }
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useSettings.setState({ settings: DEFAULT_SETTINGS })
  useProjects.setState({ projects: [], activeProjectId: '' })
  vi.unstubAllGlobals()
})

async function renderOpen(codexCounts: Record<string, number> = {}): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(
      <UsageIndicator
        onSetDefaultAccount={onSetDefault}
        countAccountSessions={() => 0}
        onMoveSessions={onMove}
        onSetDefaultCodexAccount={onSetDefaultCodex}
        countCodexAccountSessions={(id) => codexCounts[id ?? 'system'] ?? 0}
        onMoveCodexSessions={onMoveCodex}
      />
    )
  })
  await act(async () => (host.querySelector('.usage-pill') as HTMLButtonElement).click())
}

/** The account blocks whose provider chip says Codex. */
const codexBlocks = (): HTMLElement[] =>
  [...host.querySelectorAll<HTMLElement>('.usage-account')].filter((b) =>
    [...b.querySelectorAll('.usage-account__host')].some((c) => c.textContent === 'Codex')
  )
const heading = (b: HTMLElement): string =>
  (b.querySelector('.usage-account__label')?.firstChild?.textContent ?? '').trim()
const block = (name: string): HTMLElement => codexBlocks().find((b) => heading(b) === name)!
const button = (root: ParentNode, text: string): HTMLButtonElement | undefined =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === text)

describe('usage popover — Codex account rows', () => {
  it('heads each Codex login by its account, one block per login, pending rows excluded', async () => {
    await renderOpen()
    expect(codexBlocks().map(heading)).toEqual(['one@example.com', 'Taltech', 'PLG'])
    // The email line is shown where the heading is not already the email.
    expect(block('Taltech').querySelector('.usage-account__email')?.textContent).toBe('two@example.com')
    expect(block('one@example.com').querySelector('.usage-account__email')).toBeNull()
  })

  it('marks the project Codex default and sets another through the CODEX handler only', async () => {
    await renderOpen()
    expect(block('Taltech').textContent).toContain('✓ new sessions')
    await act(async () => button(block('PLG'), 'Use for new sessions')!.click())
    expect(onSetDefaultCodex).toHaveBeenCalledWith('p1', 'cx2')
    await act(async () => button(block('one@example.com'), 'Use for new sessions')!.click())
    expect(onSetDefaultCodex).toHaveBeenLastCalledWith('p1', undefined)
    expect(onSetDefault).not.toHaveBeenCalled()
  })

  it('moves a Codex account’s sessions onto another Codex account of this machine', async () => {
    await renderOpen({ cx1: 2 })
    await act(async () => button(block('Taltech'), '⇄ Move 2 sessions')!.click())
    const targets = [...block('Taltech').querySelectorAll('button')]
      .map((b) => b.textContent ?? '')
      .filter((t) => t.startsWith('→ '))
    // Its own account is never a target, a pending login is never one, and no Claude account is.
    expect(targets).toEqual(['→ one@example.com', '→ PLG'])
    await act(async () => button(block('Taltech'), '→ PLG')!.click())
    expect(onMoveCodex).toHaveBeenCalledWith('cx1', 'cx2', 'PLG')
    expect(onMove).not.toHaveBeenCalled()
  })

  it('shows no move control on a Codex row with no Codex sessions', async () => {
    await renderOpen({})
    expect(codexBlocks().some((b) => b.textContent?.includes('⇄ Move'))).toBe(false)
  })
})
