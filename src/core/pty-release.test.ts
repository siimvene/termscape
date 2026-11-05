import { afterEach, describe, it, expect, vi } from 'vitest'
import { releasePty, type ReleasablePty } from './pty-release'

// Contract test with a stub: real node-pty is compiled against Electron's ABI and cannot load
// under vitest's node runtime, but the fd-leak fix is entirely about WHICH methods run in WHICH
// order — resume first (unblock a paused socket), then destroy (deterministic fd close) with a
// kill() fallback where destroy doesn't exist.
function stub(overrides: Partial<Record<'resume' | 'destroy' | 'kill', () => void>> = {}) {
  const calls: string[] = []
  const proc: ReleasablePty = {
    resume: overrides.resume ?? (() => calls.push('resume')),
    kill: overrides.kill ?? (() => calls.push('kill')),
    ...(overrides.destroy !== undefined || 'destroy' in overrides
      ? { destroy: overrides.destroy }
      : {})
  }
  return { proc, calls }
}

describe('releasePty', () => {
  afterEach(() => vi.restoreAllMocks())
  it('resumes first, then prefers destroy (deterministic fd close) over kill', () => {
    const calls: string[] = []
    const proc: ReleasablePty = {
      resume: () => calls.push('resume'),
      kill: () => calls.push('kill'),
      destroy: () => calls.push('destroy')
    }
    releasePty(proc)
    expect(calls).toEqual(['resume', 'destroy'])
  })

  it('force-kills a disposable client before destroying its PTY master', () => {
    const calls: string[] = []
    const proc: ReleasablePty = {
      resume: () => calls.push('resume'),
      kill: (signal?: string) => calls.push(`kill:${signal ?? 'default'}`),
      destroy: () => calls.push('destroy')
    }
    releasePty(proc, { forceKill: true })
    expect(calls).toEqual(['resume', 'kill:SIGKILL', 'destroy'])
  })

  it('continues releasing the PTY when force-kill cannot signal an exited client', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const calls: string[] = []
    const proc: ReleasablePty = {
      resume: () => calls.push('resume'),
      kill: () => {
        calls.push('kill')
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
      },
      destroy: () => calls.push('destroy')
    }
    expect(() => releasePty(proc, { forceKill: true })).not.toThrow()
    expect(calls).toEqual(['resume', 'kill', 'destroy'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('reports unexpected force-kill failures without skipping PTY cleanup', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = Object.assign(new Error('permission denied'), { code: 'EPERM' })
    const destroy = vi.fn()
    const proc: ReleasablePty = {
      resume: () => {},
      kill: () => { throw error },
      destroy
    }
    expect(() => releasePty(proc, { forceKill: true })).not.toThrow()
    expect(warn).toHaveBeenCalledWith('[pty] Failed to terminate released tmux client', error)
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('falls back to kill() when destroy is unavailable (winpty)', () => {
    const { proc, calls } = stub()
    releasePty(proc)
    expect(calls).toEqual(['resume', 'kill'])
  })

  it('a throwing resume() does not prevent the fd release', () => {
    const calls: string[] = []
    const proc: ReleasablePty = {
      resume: () => {
        throw new Error('socket closed')
      },
      kill: () => calls.push('kill'),
      destroy: () => calls.push('destroy')
    }
    expect(() => releasePty(proc)).not.toThrow()
    expect(calls).toEqual(['destroy'])
  })

  it('a throwing destroy/kill never propagates (process already dead)', () => {
    const proc: ReleasablePty = {
      resume: () => {},
      kill: () => {
        throw new Error('ESRCH')
      }
    }
    expect(() => releasePty(proc)).not.toThrow()
  })
})
