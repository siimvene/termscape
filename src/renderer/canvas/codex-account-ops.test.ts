import { describe, expect, it } from 'vitest'
import type { CodexAccount } from '@shared/codex-account'
import {
  codexProjectDefault,
  codexSwitchOutcomeNotice,
  resolveNewCodexNodeAccount,
  planCodexAccountSwitch,
  summarizeCodexBulkSwitch
} from './codex-account-ops'

const local: CodexAccount = { id: 'account-a', label: 'Work' }
const remote: CodexAccount = { id: 'account-r', label: 'Box', host: 'u@box' }
const accounts = [local, remote]
const connected = (host: string): string | undefined => (host === 'u@box' ? 'proj-1' : undefined)
const noConnection = (): undefined => undefined

describe('resolveNewCodexNodeAccount (fail-closed New Codex picker — §3.4 / Property 4)', () => {
  it('creates on the system account when nothing is picked', () => {
    expect(resolveNewCodexNodeAccount(undefined, accounts, noConnection)).toEqual({
      create: true,
      accountId: undefined
    })
    expect(resolveNewCodexNodeAccount('', accounts, noConnection)).toEqual({
      create: true,
      accountId: undefined
    })
  })

  it('creates on a present local managed account', () => {
    expect(resolveNewCodexNodeAccount('account-a', accounts, noConnection)).toEqual({
      create: true,
      accountId: 'account-a'
    })
  })

  it('REFUSES an explicitly picked MISSING account — no silent substitution to system', () => {
    // MUTATION PIN: if a refused selection fell back to `{ create: true, accountId: undefined }`
    // (the system login) instead of refusing, this goes green — a missing pick would silently bind
    // the system account. Must stay red.
    expect(resolveNewCodexNodeAccount('account-gone', accounts, connected)).toEqual({
      create: false,
      reason: 'unavailable'
    })
  })

  it('REFUSES a hostile (path-escaping) id even when a matching row is present', () => {
    const hostile: CodexAccount = { id: '../escape', label: 'evil' }
    expect(resolveNewCodexNodeAccount('../escape', [...accounts, hostile], connected)).toEqual({
      create: false,
      reason: 'unavailable'
    })
  })

  it('REFUSES a remote account whose host is not connected — never binds it locally', () => {
    expect(resolveNewCodexNodeAccount('account-r', accounts, noConnection)).toEqual({
      create: false,
      reason: 'no-connection'
    })
  })
})

describe('planCodexAccountSwitch (fail-closed switch origination — §3.5)', () => {
  const codexNode = {
    agentId: 'codex',
    cwd: '/repo',
    accountId: 'account-a',
    ssh: false,
    sessionId: 'thread-a'
  }

  it('plans a switch to a present account, preserving the conversation id', () => {
    // `account-r` lives on u@box, so the node must run there too — a switch never crosses machines.
    const d = planCodexAccountSwitch({ ...codexNode, ssh: true, hostKey: 'u@box' }, 'account-r', accounts, connected)
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.plan.sourceAccountId).toBe('account-a')
    expect(d.plan.targetAccountId).toBe('account-r')
    // MUTATION PIN: the switch must resume the SAME conversation id, never fork. If the plan carried
    // any id other than the node's own `sessionId` here (or in `expected.sessionId`), a UI switch
    // could recycle a diverged pane. Both must equal 'thread-a'. Must stay red on any divergence.
    expect(d.plan.sessionId).toBe('thread-a')
    expect(d.plan.expected.sessionId).toBe('thread-a')
    // The eligibility snapshot pins the SOURCE account (the pane still runs it pre-recycle).
    expect(d.plan.expected.accountId).toBe('account-a')
    expect(d.plan.expected.agentId).toBe('codex')
  })

  it('plans a switch to the system account (target undefined) from a managed one', () => {
    const d = planCodexAccountSwitch(codexNode, undefined, accounts, connected)
    expect(d).toMatchObject({ ok: true, plan: { targetAccountId: undefined } })
  })

  it('refuses a non-Codex node', () => {
    expect(planCodexAccountSwitch({ ...codexNode, agentId: 'claude' }, 'account-r', accounts, connected)).toEqual({
      ok: false,
      reason: 'not-codex'
    })
  })

  it('refuses a node with no resumable conversation id', () => {
    expect(planCodexAccountSwitch({ ...codexNode, sessionId: undefined }, 'account-r', accounts, connected)).toEqual({
      ok: false,
      reason: 'no-session'
    })
  })

  // A persisted node can be remote (`sshRemoteTmux`) with no `ssh` spec left to name its host
  // (the worktree gate's drift class). Its pane is on SOME host, so neither a local account nor
  // this machine's system login may be planned for it: refuse instead of switching it as local.
  it('refuses a remote node whose host cannot be named, for a local or a system target', () => {
    const drifted = { ...codexNode, accountId: undefined, ssh: true, hostKey: undefined }
    expect(planCodexAccountSwitch(drifted, 'account-a', accounts, connected)).toEqual({
      ok: false,
      reason: 'no-connection'
    })
    expect(planCodexAccountSwitch({ ...drifted, accountId: 'account-a' }, undefined, accounts, connected)).toEqual({
      ok: false,
      reason: 'no-connection'
    })
  })

  it('refuses a no-op switch to the account the node already runs', () => {
    // MUTATION PIN: drop the `source === target` short-circuit → a same-account switch would be
    // ORIGINATED (reserving + recycling for nothing). Must stay red.
    expect(planCodexAccountSwitch(codexNode, 'account-a', accounts, connected)).toEqual({
      ok: false,
      reason: 'same-account'
    })
  })

  it('REFUSES a MISSING target account — no silent substitution', () => {
    // MUTATION PIN: if a refused target fell through to `{ ok: true }`, the UI would originate a
    // switch that main-side then binds/refuses. The renderer must fail closed first. Must stay red.
    expect(planCodexAccountSwitch(codexNode, 'account-gone', accounts, connected)).toEqual({
      ok: false,
      reason: 'unavailable'
    })
  })

  it('REFUSES a remote target whose host is not connected', () => {
    expect(
      planCodexAccountSwitch({ ...codexNode, ssh: true, hostKey: 'u@box' }, 'account-r', accounts, noConnection)
    ).toEqual({
      ok: false,
      reason: 'no-connection'
    })
  })
})

describe('planCodexAccountSwitch — the account must live on the node\'s machine', () => {
  const accts = [
    { id: 'loc', label: 'Local' },
    { id: 'rem', label: 'Remote', host: 'u@h' },
    { id: 'rem2', label: 'Remote 2', host: 'u@h' },
    { id: 'far', label: 'Elsewhere', host: 'x@y' }
  ]
  const connected = (): string => 'p1'
  const base = { agentId: 'codex', cwd: '/srv/app', sessionId: 't1' }

  it('switches an SSH node between accounts on its host, and to the host system login', () => {
    const ssh = { ...base, ssh: true, hostKey: 'u@h', accountId: 'rem' }
    expect(planCodexAccountSwitch(ssh, 'rem2', accts, connected)).toMatchObject({ ok: true })
    expect(planCodexAccountSwitch(ssh, undefined, accts, connected)).toMatchObject({ ok: true })
  })

  it('refuses an account on another machine, in both directions', () => {
    const ssh = { ...base, ssh: true, hostKey: 'u@h', accountId: 'rem' }
    expect(planCodexAccountSwitch(ssh, 'loc', accts, connected)).toEqual({ ok: false, reason: 'unavailable' })
    expect(planCodexAccountSwitch(ssh, 'far', accts, connected)).toEqual({ ok: false, reason: 'unavailable' })
    const local = { ...base, accountId: 'loc' }
    expect(planCodexAccountSwitch(local, 'rem', accts, connected)).toEqual({
      ok: false,
      reason: 'unavailable'
    })
  })
})

describe('codexProjectDefault (project.defaultCodexAccountId at node creation)', () => {
  const pending: CodexAccount = { id: 'account-p', label: 'Pending', pending: true }
  const all = [local, remote, pending]

  it('returns a valid local default for a local project', () => {
    expect(codexProjectDefault('account-a', undefined, all, noConnection)).toBe('account-a')
  })

  it('falls back to SYSTEM (undefined) — never refuses — for a stale, pending or foreign default', () => {
    expect(codexProjectDefault(undefined, undefined, all, connected)).toBeUndefined()
    expect(codexProjectDefault('account-gone', undefined, all, connected)).toBeUndefined()
    expect(codexProjectDefault('account-p', undefined, all, connected)).toBeUndefined()
    // A local account is not this SSH project's machine, and a host account is not a local one's.
    expect(codexProjectDefault('account-a', 'u@box', all, connected)).toBeUndefined()
    expect(codexProjectDefault('account-r', undefined, all, connected)).toBeUndefined()
  })

  it('takes a host account on its own SSH project only while that host is connected', () => {
    expect(codexProjectDefault('account-r', 'u@box', all, connected)).toBe('account-r')
    expect(codexProjectDefault('account-r', 'u@box', all, noConnection)).toBeUndefined()
  })

  it('refuses a hostile id even when a row carries it', () => {
    const hostile: CodexAccount = { id: '../x', label: 'Evil' }
    expect(codexProjectDefault('../x', undefined, [hostile], noConnection)).toBeUndefined()
  })
})

describe('Codex switch outcomes — one notice for a node, one summary for a bulk move', () => {
  it('keeps the single-switch wording and says nothing for a no-op', () => {
    expect(codexSwitchOutcomeNotice({ kind: 'noop' })).toBeNull()
    expect(codexSwitchOutcomeNotice({ kind: 'switched' })).toEqual({
      kind: 'info',
      text: 'Codex account switched — conversation resumed.'
    })
    expect(codexSwitchOutcomeNotice({ kind: 'failed' })?.text).toBe(
      'The Codex account switch failed and was rolled back. Nothing was changed.'
    )
    expect(codexSwitchOutcomeNotice({ kind: 'host-down', hostKey: 'u@box' })?.text).toBe(
      'u@box is not connected — reconnect the project, then switch. Nothing was changed.'
    )
  })

  it('summarizes moved, needs-restart, skipped and failed', () => {
    expect(summarizeCodexBulkSwitch([{ kind: 'switched' }, { kind: 'switched' }], 0, 'Work')).toEqual({
      kind: 'info',
      text: 'Moved 2 Codex sessions to Work.'
    })
    expect(
      summarizeCodexBulkSwitch(
        [
          { kind: 'switched' },
          { kind: 'switched-not-relaunched' },
          { kind: 'diverged' },
          { kind: 'failed' }
        ],
        1,
        'Work'
      )
    ).toEqual({
      kind: 'error',
      text:
        'Moved 2 Codex sessions to Work · 1 need a restart to resume there · ' +
        '2 skipped (busy, not attached or without a conversation yet) · 1 failed and stayed on their account.'
    })
  })
})
