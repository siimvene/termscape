import { afterEach, describe, expect, it } from 'vitest'
import { inheritableAccountId, setCustomAgentBaseResolver } from './config'

// A managed Claude account id and a managed Codex account id share ONE alphabet, so the id alone
// cannot say which provider it belongs to. These two membership resolvers stand in for
// `settings.claudeAccounts` / `settings.codexAccounts` — CLAUDE_IDS live only in the first,
// CODEX_IDS only in the second, so a wrong-provider inheritance is caught by the sets, not a guess.
const CLAUDE_IDS = new Set(['claude-a', 'claude-b'])
const CODEX_IDS = new Set(['codex-a', 'codex-b'])
const isClaudeAccount = (id: string): boolean => CLAUDE_IDS.has(id)
const isCodexAccount = (id: string): boolean => CODEX_IDS.has(id)

// The predicate is only trustworthy if it can also answer FALSE — verify both resolvers separate
// the two alphabets before relying on any result below (per the "Test the test" discipline).
describe('inheritable-account test fixtures', () => {
  it('the membership resolvers actually partition the two id alphabets', () => {
    expect(isClaudeAccount('claude-a')).toBe(true)
    expect(isClaudeAccount('codex-a')).toBe(false)
    expect(isCodexAccount('codex-a')).toBe(true)
    expect(isCodexAccount('claude-a')).toBe(false)
  })
})

describe('inheritableAccountId — provider must match, cross-provider drops', () => {
  afterEach(() => setCustomAgentBaseResolver(null))

  it('claude → claude KEEPS the account', () => {
    expect(inheritableAccountId('claude', 'claude-a', isClaudeAccount, isCodexAccount)).toBe(
      'claude-a'
    )
  })

  it('claude → codex DROPS the account (the reported bug: a Claude id must never reach a codex spawn)', () => {
    expect(
      inheritableAccountId('codex', 'claude-a', isClaudeAccount, isCodexAccount)
    ).toBeUndefined()
  })

  it('codex → codex KEEPS the account', () => {
    expect(inheritableAccountId('codex', 'codex-a', isClaudeAccount, isCodexAccount)).toBe('codex-a')
  })

  it('codex → claude DROPS the account', () => {
    expect(
      inheritableAccountId('claude', 'codex-a', isClaudeAccount, isCodexAccount)
    ).toBeUndefined()
  })

  it('undefined src stays undefined for either provider', () => {
    expect(inheritableAccountId('claude', undefined, isClaudeAccount, isCodexAccount)).toBeUndefined()
    expect(inheritableAccountId('codex', undefined, isClaudeAccount, isCodexAccount)).toBeUndefined()
  })

  it('a non-account-bound builtin (gemini) never inherits, whatever the src provider', () => {
    expect(
      inheritableAccountId('gemini', 'claude-a', isClaudeAccount, isCodexAccount)
    ).toBeUndefined()
    expect(
      inheritableAccountId('gemini', 'codex-a', isClaudeAccount, isCodexAccount)
    ).toBeUndefined()
  })

  it('a custom agent based on claude behaves like claude (base is resolved via capabilityAgentId)', () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:proxy' ? 'claude' : undefined))
    // Same-provider src (a Claude account) is inherited …
    expect(inheritableAccountId('custom:proxy', 'claude-a', isClaudeAccount, isCodexAccount)).toBe(
      'claude-a'
    )
    // … and a Codex account is still dropped, exactly like the builtin claude target.
    expect(
      inheritableAccountId('custom:proxy', 'codex-a', isClaudeAccount, isCodexAccount)
    ).toBeUndefined()
  })

  it('a custom agent based on codex behaves like codex', () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:cx' ? 'codex' : undefined))
    expect(inheritableAccountId('custom:cx', 'codex-a', isClaudeAccount, isCodexAccount)).toBe(
      'codex-a'
    )
    expect(
      inheritableAccountId('custom:cx', 'claude-a', isClaudeAccount, isCodexAccount)
    ).toBeUndefined()
  })

  it('a baseless custom agent inherits nothing (no provider to match)', () => {
    setCustomAgentBaseResolver(() => undefined)
    expect(
      inheritableAccountId('custom:aider', 'claude-a', isClaudeAccount, isCodexAccount)
    ).toBeUndefined()
  })
})
