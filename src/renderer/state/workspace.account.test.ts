import { describe, it, expect } from 'vitest'
import {
  accountChipLabel,
  accountsForProject,
  createAgentNode,
  createPiAccountLoginNode,
  flowToNodeStates,
  isAccountLoginNode,
  isCodexAccountLoginNode,
  isPiAccountLoginNode,
  nodeStatesToFlow,
  sshAccountsHint,
  systemAccountDisplay
} from './workspace'
import type { ClaudeAccount, Project } from '@shared/types'

const acct = (over: Partial<ClaudeAccount>): ClaudeAccount => ({
  id: 'a1',
  label: 'work@example.com',
  email: 'work@example.com',
  createdAt: 0,
  ...over
})

describe('accountChipLabel', () => {
  it('returns null when there is no accountId (no chip)', () => {
    expect(accountChipLabel(undefined, [acct({})])).toBeNull()
    expect(accountChipLabel('', [acct({})])).toBeNull()
  })

  it('takes the part before @ and tooltips as "label (email)"', () => {
    const r = accountChipLabel('a1', [acct({ label: 'work@example.com', email: 'work@example.com' })])
    expect(r).toEqual({ short: 'work', tooltip: 'work@example.com (work@example.com)' })
  })

  it('caps the short label at 10 chars with an ellipsis', () => {
    const r = accountChipLabel('a1', [acct({ label: 'verylongaccountname@example.com' })])
    expect(r?.short).toBe('verylongac…')
    expect(r?.short.length).toBe(11) // 10 chars + ellipsis
  })

  it('does not truncate a base of exactly 10 chars', () => {
    const r = accountChipLabel('a1', [acct({ label: 'tenletters@x.com' })])
    expect(r?.short).toBe('tenletters')
  })

  it('omits the "(email)" suffix when the account has no email', () => {
    const r = accountChipLabel('a1', [acct({ label: 'personal', email: undefined })])
    expect(r).toEqual({ short: 'personal', tooltip: 'personal' })
  })

  it('falls back to "Unknown account" when the id no longer resolves', () => {
    expect(accountChipLabel('gone', [acct({ id: 'a1' })])).toEqual({
      short: 'Unknown account',
      tooltip: 'Unknown account'
    })
    expect(accountChipLabel('gone', [])).toEqual({
      short: 'Unknown account',
      tooltip: 'Unknown account'
    })
  })

  it('shows the named system default on a local node when managed accounts exist', () => {
    const r = accountChipLabel(undefined, [acct({})], {
      label: 'Workspace',
      email: 'me@work.example'
    })
    expect(r).toEqual({ short: 'Workspace', tooltip: 'Workspace (me@work.example)' })
  })

  it('no system chip when there are no managed accounts (nothing to disambiguate)', () => {
    expect(
      accountChipLabel(undefined, [], { label: 'Workspace', email: 'me@work.example' })
    ).toBeNull()
  })

  it('no system chip when the caller withholds system identity (SSH/relay node)', () => {
    expect(accountChipLabel(undefined, [acct({})], undefined)).toBeNull()
  })

  it('system chip falls back to the detected email when unlabeled', () => {
    const r = accountChipLabel(undefined, [acct({})], { label: '', email: 'me@work.example' })
    expect(r).toEqual({ short: 'me', tooltip: 'me@work.example' })
  })

  it('system chip reads "System account" when neither label nor email is known', () => {
    const r = accountChipLabel(undefined, [acct({})], { label: '', email: null })
    expect(r?.short).toBe('System acc…')
    expect(r?.tooltip).toBe('System account')
  })
})

describe('systemAccountDisplay', () => {
  it('prefers the custom label', () => {
    expect(systemAccountDisplay('Kişisel', 'me@example.com')).toBe('Kişisel')
  })

  it('falls back to the detected email when the label is empty/whitespace', () => {
    expect(systemAccountDisplay('', 'me@example.com')).toBe('me@example.com')
    expect(systemAccountDisplay('   ', 'me@example.com')).toBe('me@example.com')
    expect(systemAccountDisplay(undefined, 'me@example.com')).toBe('me@example.com')
  })

  it('falls back to the generic name when nothing is known', () => {
    expect(systemAccountDisplay('', null)).toBe('System account')
    expect(systemAccountDisplay(undefined, undefined)).toBe('System account')
  })
})

describe('isAccountLoginNode', () => {
  it('matches the factory title (the only persisted signature)', () => {
    expect(isAccountLoginNode({ title: 'Claude login' })).toBe(true)
  })

  it('matches a live node by its one-shot initialCommand', () => {
    expect(isAccountLoginNode({ title: 'renamed', initialCommand: 'claude /login' })).toBe(true)
  })

  it('does not match ordinary claude nodes', () => {
    expect(isAccountLoginNode({ title: 'My session', initialCommand: 'claude' })).toBe(false)
    expect(isAccountLoginNode({ title: 'Terminal' })).toBe(false)
    expect(isAccountLoginNode({})).toBe(false)
  })
})

// The Codex twin raises a FAIL-CLOSED intent (`PtyCreateOptions.codexLogin`: the spawn refuses
// unless a managed home resolves), so a false positive is a refused terminal, not a cosmetic slip.
describe('isCodexAccountLoginNode', () => {
  it('matches the factory title and the exact login command (with or without a flag)', () => {
    expect(isCodexAccountLoginNode({ title: 'Codex login' })).toBe(true)
    expect(isCodexAccountLoginNode({ title: 'renamed', initialCommand: 'codex login' })).toBe(true)
    expect(
      isCodexAccountLoginNode({ title: 'renamed', initialCommand: 'codex login --device-auth' })
    ).toBe(true)
  })

  it('does NOT match a command that merely starts with the letters `codex login`', () => {
    expect(isCodexAccountLoginNode({ title: 'x', initialCommand: 'codex loginfoo' })).toBe(false)
    expect(isCodexAccountLoginNode({ title: 'x', initialCommand: 'codex login-helper' })).toBe(false)
  })

  it('does not match ordinary codex nodes', () => {
    expect(isCodexAccountLoginNode({ title: 'My session', initialCommand: 'codex' })).toBe(false)
    expect(isCodexAccountLoginNode({ title: 'Terminal' })).toBe(false)
    expect(isCodexAccountLoginNode({})).toBe(false)
  })
})

// The pi twin — keyed on an EXPLICIT flag the factory sets, not on the command shape: pi's login
// node runs bare `pi` (the login is the `/login` slash command inside the session), and bare `pi`
// is also exactly what `nodeterm.sh open-terminal --cmd pi` runs. A shape match sent `piLogin` for
// that plain terminal, and PRE-FLIGHT 3 refused its spawn ("no agent dir") for a node that never
// asked to be scoped.
describe('isPiAccountLoginNode', () => {
  it('is the explicit factory flag, never the title or the bare `pi` command', () => {
    const login = createPiAccountLoginNode('p1', 0)
    expect(login.data.piLogin).toBe(true)
    expect(login.data.accountId).toBe('p1')
    expect(isPiAccountLoginNode(login.data)).toBe(true)
    expect(isPiAccountLoginNode({ title: 'renamed', initialCommand: 'pi' })).toBe(false)
    expect(isPiAccountLoginNode({ title: 'Pi login' })).toBe(false)
    expect(isPiAccountLoginNode({ title: 'x', initialCommand: 'pip install foo' })).toBe(false)
    expect(isPiAccountLoginNode({ title: 'Terminal' })).toBe(false)
    expect(isPiAccountLoginNode({})).toBe(false)
  })

  it('survives the save/load round trip, so a cold restart of an unfinished login still scopes', () => {
    const login = createPiAccountLoginNode('p1', 0)
    const [back] = nodeStatesToFlow(flowToNodeStates([login]))
    expect(isPiAccountLoginNode(back.data)).toBe(true)
  })
})

describe('createAgentNode — pi accounts on an SSH project', () => {
  const ssh = { server: { host: 'box', user: 'me' }, remoteCwd: '/srv' } as unknown as Project['ssh']

  it('never stamps a managed pi account on an SSH node (the remote spawn cannot scope to it)', () => {
    const remote = createAgentNode('pi', 0, '/local', undefined, undefined, ssh, 'p1')
    expect(remote.data.accountId).toBeUndefined()
    const local = createAgentNode('pi', 0, '/local', undefined, undefined, undefined, 'p1')
    expect(local.data.accountId).toBe('p1')
  })
})

// An SSH project's account pickers list ONLY accounts created on that host — local accounts are
// (correctly) invisible there, which read as "multi-account is broken on SSH" without a hint row
// explaining where accounts for this host come from.
describe('sshAccountsHint', () => {
  const sshProject = { ssh: { server: { host: 'box', user: 'me' } } }

  it('hints on an SSH project whose host has no eligible accounts', () => {
    const localOnly = [acct({ id: 'a1' })] // no `host` → local → filtered out for SSH
    const eligible = accountsForProject(localOnly, sshProject)
    expect(eligible).toEqual([])
    expect(sshAccountsHint(sshProject, eligible)).toMatch(/Settings → Accounts/)
  })

  it('is null once the host has a matching account', () => {
    const hosted = [acct({ id: 'a2', host: 'me@box' })]
    const eligible = accountsForProject(hosted, sshProject)
    expect(eligible).toHaveLength(1)
    expect(sshAccountsHint(sshProject, eligible)).toBeNull()
  })

  it('is null for local projects (empty list there just means no managed accounts)', () => {
    expect(sshAccountsHint(undefined, [])).toBeNull()
    expect(sshAccountsHint({}, [])).toBeNull()
  })
})
