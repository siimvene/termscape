import { describe, it, expect } from 'vitest'
import { describeLoadFailure, isReportableFailure, ERR_ABORTED } from './webviewError'

describe('isReportableFailure', () => {
  it('reports a main-frame failure', () => {
    expect(isReportableFailure(true, -102)).toBe(true)
  })

  it('ignores a subframe failure', () => {
    // Covering a working page because an ad or an iframe died hides the content the user came for.
    expect(isReportableFailure(false, -102)).toBe(false)
  })

  it('ignores an aborted navigation', () => {
    expect(isReportableFailure(true, ERR_ABORTED)).toBe(false)
  })
})

describe('describeLoadFailure', () => {
  it('explains a refused connection, which is the one a dev server produces', () => {
    const f = describeLoadFailure(-102, 'ERR_CONNECTION_REFUSED', 'http://localhost:3000/')
    expect(f.message).toBe('Nothing is listening at that address.')
    expect(f.hint).toContain('dev server')
    expect(f.url).toBe('http://localhost:3000/')
    expect(f.retryable).toBe(true)
  })

  it("carries Chromium's own symbol even when the code is known", () => {
    // It is the only part of the plate that is searchable and quotable in a bug report.
    expect(describeLoadFailure(-105, 'ERR_NAME_NOT_RESOLVED', 'https://nope.invalid/').raw).toBe(
      'ERR_NAME_NOT_RESOLVED'
    )
  })

  it('degrades an unknown code to the generic sentence rather than inventing one', () => {
    const f = describeLoadFailure(-99999, 'ERR_SOMETHING_NEW', 'https://example.com/')
    expect(f.message).toBe('The page could not be loaded.')
    expect(f.hint).toBe('')
    expect(f.raw).toBe('ERR_SOMETHING_NEW')
    expect(f.retryable).toBe(true)
  })

  it('names the code when the event carried no description', () => {
    expect(describeLoadFailure(-7, '   ', '').raw).toBe('Error -7')
  })

  it('offers no retry when the address itself is the problem', () => {
    // Re-running the identical navigation cannot succeed; the fix is to type something else.
    expect(describeLoadFailure(-300, 'ERR_INVALID_URL', 'ht!tp://x').retryable).toBe(false)
    expect(describeLoadFailure(-302, 'ERR_UNKNOWN_URL_SCHEME', 'wat://x').retryable).toBe(false)
  })

  it('offers a retry for a certificate failure, which the user can fix and re-attempt', () => {
    expect(describeLoadFailure(-202, 'ERR_CERT_AUTHORITY_INVALID', 'https://local.test/').retryable).toBe(true)
  })

  it('tolerates a missing url', () => {
    expect(describeLoadFailure(-106, 'ERR_INTERNET_DISCONNECTED', '').url).toBe('')
  })

  it('never returns an undefined hint', () => {
    for (const code of [-2, -6, -7, -100, -101, -104, -106, -109, -118, -200, -201, -310, -324, -501]) {
      expect(typeof describeLoadFailure(code, 'ERR', '').hint).toBe('string')
    }
  })
})
