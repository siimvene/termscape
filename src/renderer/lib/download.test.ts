import { describe, it, expect } from 'vitest'
import { canRevealLocally, canUseLocalShell, downloadRoute } from './download'

describe('downloadRoute', () => {
  it('pulls an SSH project over scp on the desktop', () => {
    expect(downloadRoute({ browser: false, ssh: true, source: 'local' })).toBe('scp')
  })

  it('serves every browser tree over HTTP — including a "local" project, which is on the server', () => {
    expect(downloadRoute({ browser: true, ssh: false, source: 'local' })).toBe('http')
  })

  it('offers nothing for a desktop local project (the file is already here)', () => {
    expect(downloadRoute({ browser: false, ssh: false, source: 'local' })).toBe('none')
  })

  it('offers nothing on a relay tab, whatever the project is', () => {
    expect(downloadRoute({ browser: false, ssh: true, source: 'relay' })).toBe('none')
    expect(downloadRoute({ browser: true, ssh: false, source: 'relay' })).toBe('none')
  })

  it('does not mint a ticket for an SSH tree in the browser (that fs is not the server’s)', () => {
    expect(downloadRoute({ browser: true, ssh: true, source: 'local' })).toBe('none')
  })
})

describe('canRevealLocally', () => {
  it('is true only for a desktop local project', () => {
    expect(canRevealLocally({ browser: false, ssh: false, source: 'local' })).toBe(true)
  })

  it('is false where the path is not on this machine, or nothing can open it', () => {
    expect(canRevealLocally({ browser: false, ssh: true, source: 'local' })).toBe(false)
    expect(canRevealLocally({ browser: true, ssh: false, source: 'local' })).toBe(false)
    expect(canRevealLocally({ browser: false, ssh: false, source: 'relay' })).toBe(false)
  })
})

describe('canUseLocalShell', () => {
  // The Server Edition bug this predicate was extracted for: a browser tab's session source is
  // 'local' (SessionSource's 'server' is declared but never constructed), so `source` alone can
  // never tell you you are in a browser — only `isBrowserRuntime()` can. `shell.openPath` is a
  // `noop` stub there, so an ungated call on a .zip or .dmg was a silent dead click.
  it('is false in a browser tab even though its session source is local', () => {
    expect(canUseLocalShell({ browser: true, ssh: false, source: 'local' })).toBe(false)
  })

  it('is true only for a desktop shell acting on this machine', () => {
    expect(canUseLocalShell({ browser: false, ssh: false, source: 'local' })).toBe(true)
    expect(canUseLocalShell({ browser: false, ssh: true, source: 'local' })).toBe(false)
    expect(canUseLocalShell({ browser: false, ssh: false, source: 'relay' })).toBe(false)
  })

  // One rule, not two that drift: reveal was gated and openPath was not, which is how the
  // Server Edition ended up with a dead click on one member of the same namespace.
  it('is the same rule reveal already used', () => {
    for (const browser of [true, false])
      for (const ssh of [true, false])
        for (const source of ['local', 'relay', 'server'] as const)
          expect(canUseLocalShell({ browser, ssh, source })).toBe(
            canRevealLocally({ browser, ssh, source })
          )
  })
})
