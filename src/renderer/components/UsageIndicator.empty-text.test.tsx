// @vitest-environment jsdom
// The sentence a human actually reads when a usage row has no bars. Every one of these used to
// be 'Could not read usage.' or 'No usage data.', so an expired sign-in, a 429 and an account
// nobody ever logged into were one indistinguishable word on screen.
//
// Two properties matter more than the exact wording: a recorded cause is SAID, and an absent one
// is never guessed — a row that predates the taxonomy (a cached snapshot, the remote-over-SSH
// reader, a provider row) must degrade to exactly the old sentences.
import { describe, it, expect } from 'vitest'
import { usageEmptyText } from './UsageIndicator'

describe('usageEmptyText', () => {
  // A store the reader could not open must not be worded as an absence: "Not signed in" for a
  // permissions problem is a guess presented as a fact.
  it('tells "could not read the credentials" apart from "not signed in"', () => {
    const unreadable = usageEmptyText({ status: 'error', cause: 'credentials-unreadable' })
    expect(unreadable).not.toBe('Not signed in.')
    expect(unreadable).not.toBe('Could not read usage.')
    expect(unreadable).toContain('credentials')
  })

  it('tells "never signed in" apart from "sign-in refused"', () => {
    expect(usageEmptyText({ status: 'unavailable', cause: 'no-credentials' })).toBe('Not signed in.')
    const refused = usageEmptyText({ status: 'unavailable', cause: 'unauthorized', httpStatus: 401 })
    expect(refused).toContain('expired')
    expect(refused).toContain('401')
    expect(refused).not.toBe('No usage data.')
  })

  it('separates a rate limit from a server fault from an unclassified code', () => {
    expect(usageEmptyText({ status: 'error', cause: 'rate-limited', httpStatus: 429 })).toContain(
      'Rate limited'
    )
    expect(usageEmptyText({ status: 'error', cause: 'server-error', httpStatus: 503 })).toContain(
      '503'
    )
    expect(usageEmptyText({ status: 'error', cause: 'http', httpStatus: 418 })).toContain('418')
  })

  it('separates unreachable from too-slow from an unreadable body', () => {
    expect(usageEmptyText({ status: 'error', cause: 'network' })).toBe('Could not reach Anthropic.')
    expect(usageEmptyText({ status: 'error', cause: 'timeout' })).toBe('Timed out reading usage.')
    expect(usageEmptyText({ status: 'error', cause: 'parse' })).toBe('Could not read the response.')
  })

  // The honesty rule: with nothing recorded, say no more than the old copy did.
  it('invents nothing when no cause was recorded', () => {
    expect(usageEmptyText({ status: 'error' })).toBe('Could not read usage.')
    expect(usageEmptyText({ status: 'ok' })).toBe('No usage data.')
    expect(usageEmptyText({ status: 'unavailable' })).toBe('No usage data.')
  })

  it('keeps the remote block naming the machine it failed to read', () => {
    expect(usageEmptyText({ status: 'error' }, 'on this host')).toBe(
      'Could not read usage on this host.'
    )
    // …but a real cause outranks the host suffix: the reason is the useful half.
    expect(usageEmptyText({ status: 'error', cause: 'network' }, 'on this host')).toBe(
      'Could not reach Anthropic.'
    )
  })

  it('never leaks an HTTP number it does not have', () => {
    expect(usageEmptyText({ status: 'unavailable', cause: 'unauthorized' })).not.toContain('HTTP')
    expect(usageEmptyText({ status: 'error', cause: 'server-error' })).not.toContain('HTTP')
  })
})
