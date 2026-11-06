import { describe, expect, it, vi } from 'vitest'
import { PtyManager } from './pty-manager'

type ReleaseManager = {
  releaseSessionPty(session: {
    proc: { resume: () => void; kill: (signal?: string) => void; destroy: () => void }
    tmuxBacked: boolean
    sshRemote?: object
    sessionHost?: boolean
    zellij?: boolean
    watcherClient?: boolean
  }): void
}

type ReleaseSession = Parameters<ReleaseManager['releaseSessionPty']>[0]

function releaseProbe(overrides: Partial<Omit<ReleaseSession, 'proc'>> = {}) {
  const signals: Array<string | undefined> = []
  const proc = {
    resume: vi.fn(),
    kill: vi.fn((signal?: string) => signals.push(signal)),
    destroy: vi.fn()
  }
  const session = {
    proc,
    tmuxBacked: true,
    ...overrides
  }
  ;(new PtyManager() as unknown as ReleaseManager).releaseSessionPty(session)
  return { proc, signals }
}

describe('PtyManager local tmux client release guard', () => {
  it('force-kills only the disposable local tmux attach client', () => {
    const { proc, signals } = releaseProbe()
    expect(signals).toEqual(['SIGKILL'])
    expect(proc.resume).toHaveBeenCalledOnce()
    expect(proc.destroy).toHaveBeenCalledOnce()
  })

  it.each([
    ['plain shell', { tmuxBacked: false }],
    ['remote SSH tmux', { sshRemote: {} }],
    ['Zellij-backed session', { zellij: true }],
    ['session-host backend', { sessionHost: true }]
  ])('does not SIGKILL %s', (_label, overrides) => {
    const { proc, signals } = releaseProbe(overrides)
    expect(signals).toEqual([])
    expect(proc.resume).toHaveBeenCalledOnce()
    expect(proc.destroy).toHaveBeenCalledOnce()
  })

  it('also kills a read-only local tmux watcher because it is a disposable attach client', () => {
    const { signals } = releaseProbe({ watcherClient: true })
    expect(signals).toEqual(['SIGKILL'])
  })
})
