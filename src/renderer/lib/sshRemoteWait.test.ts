import { describe, it, expect, vi } from 'vitest'
import { waitForSshRemote, type SshRemoteFacts, type SshRemoteWaitDeps } from './sshRemoteWait'

const FULL: SshRemoteFacts = {
  controlPath: '/cm/p1',
  hookEndpointPath: '/home/u/.nodeterm/hook-endpoint.env',
  tmuxConfPath: '/home/u/.nodeterm/tmux.conf',
  remoteHome: '/home/u'
}

/** A tiny stand-in for the sshConn store: two slots plus a subscriber list. */
function store() {
  let full: SshRemoteFacts | undefined
  let early: string | undefined
  const subs = new Set<() => void>()
  const notify = (): void => {
    for (const cb of [...subs]) cb()
  }
  return {
    setFull(v: SshRemoteFacts | undefined) {
      full = v
      notify()
    },
    setEarly(v: string | undefined) {
      early = v
      notify()
    },
    deps(over: Partial<SshRemoteWaitDeps> = {}): SshRemoteWaitDeps {
      return {
        getFull: () => full,
        getEarly: () => early,
        subscribe: (cb) => {
          subs.add(cb)
          return () => subs.delete(cb)
        },
        confirmSession: async () => false,
        waitMs: 20_000,
        ...over
      }
    },
    subscriberCount: () => subs.size
  }
}

describe('waitForSshRemote', () => {
  it('returns the full facts immediately when the connect already landed', async () => {
    const s = store()
    s.setFull(FULL)
    await expect(waitForSshRemote(s.deps())).resolves.toEqual({ kind: 'full', facts: FULL })
  })

  it('WARM node attaches on the early master, without waiting for the setup chain', async () => {
    const s = store()
    const confirmSession = vi.fn(async () => true)
    const p = waitForSshRemote(s.deps({ confirmSession }))
    s.setEarly('/cm/p1')
    await expect(p).resolves.toEqual({ kind: 'early', controlPath: '/cm/p1' })
    expect(confirmSession).toHaveBeenCalledWith('/cm/p1')
  })

  it('COLD node keeps waiting for `connected` — the tmux -f/-e facts are creation-time only', async () => {
    vi.useFakeTimers()
    try {
      const s = store()
      // The host answered and said this session does NOT exist.
      const p = waitForSshRemote(s.deps({ confirmSession: async () => false }))
      const seen = vi.fn()
      void p.then(seen)
      s.setEarly('/cm/p1')
      await vi.advanceTimersByTimeAsync(5_000)
      expect(seen).not.toHaveBeenCalled() // still waiting, not attached early
      s.setFull(FULL)
      await expect(p).resolves.toEqual({ kind: 'full', facts: FULL })
    } finally {
      vi.useRealTimers()
    }
  })

  it('an UNREADABLE host is not a licence to attach early (rejection ⇒ keep waiting)', async () => {
    vi.useFakeTimers()
    try {
      const s = store()
      const p = waitForSshRemote(s.deps({ confirmSession: () => Promise.reject(new Error('ssh 255')) }))
      const seen = vi.fn()
      void p.then(seen)
      s.setEarly('/cm/p1')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(seen).not.toHaveBeenCalled()
      s.setFull(FULL)
      await expect(p).resolves.toEqual({ kind: 'full', facts: FULL })
    } finally {
      vi.useRealTimers()
    }
  })

  it('never attaches early without a node id to ask about (confirmSession null)', async () => {
    vi.useFakeTimers()
    try {
      const s = store()
      const p = waitForSshRemote(s.deps({ confirmSession: null }))
      const seen = vi.fn()
      void p.then(seen)
      s.setEarly('/cm/p1')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(seen).not.toHaveBeenCalled()
      s.setFull(FULL)
      await expect(p).resolves.toEqual({ kind: 'full', facts: FULL })
    } finally {
      vi.useRealTimers()
    }
  })

  it('the FULL facts win a race with an in-flight early confirmation', async () => {
    const s = store()
    let release!: (v: boolean) => void
    const p = waitForSshRemote(
      s.deps({ confirmSession: () => new Promise<boolean>((r) => (release = r)) })
    )
    s.setEarly('/cm/p1')
    s.setFull(FULL) // lands while the confirm is still on the wire
    release(true)
    // The setup facts are strictly better than a bare control path — a cold node needs them.
    await expect(p).resolves.toEqual({ kind: 'full', facts: FULL })
  })

  it('does not attach early over a master that went away mid-confirmation', async () => {
    vi.useFakeTimers()
    try {
      const s = store()
      let release!: (v: boolean) => void
      const p = waitForSshRemote(
        s.deps({ confirmSession: () => new Promise<boolean>((r) => (release = r)) })
      )
      const seen = vi.fn()
      void p.then(seen)
      s.setEarly('/cm/p1')
      s.setEarly(undefined) // disconnected / error cleared it
      release(true)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(seen).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('confirms each early path ONCE — an unrelated store write is not another round trip', async () => {
    const s = store()
    let release!: (v: boolean) => void
    const confirmSession = vi.fn(() => new Promise<boolean>((r) => (release = r)))
    const p = waitForSshRemote(s.deps({ confirmSession }))
    s.setEarly('/cm/p1')
    s.setEarly('/cm/p1') // same path published again (a duplicate status event)
    s.setFull(undefined) // an unrelated write
    expect(confirmSession).toHaveBeenCalledTimes(1)
    release(true)
    await expect(p).resolves.toEqual({ kind: 'early', controlPath: '/cm/p1' })
  })

  it('gives up with `none` after the window, and unsubscribes', async () => {
    vi.useFakeTimers()
    try {
      const s = store()
      const p = waitForSshRemote(s.deps({ waitMs: 20_000 }))
      expect(s.subscriberCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(20_000)
      await expect(p).resolves.toEqual({ kind: 'none' })
      expect(s.subscriberCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('prefers a full entry that landed exactly at the deadline over giving up', async () => {
    vi.useFakeTimers()
    try {
      const s = store()
      const deps = s.deps({ waitMs: 20_000 })
      let landed = false
      const p = waitForSshRemote({
        ...deps,
        // No subscription fires for this one (a store that never notifies) — the timeout path
        // must still re-read rather than report `none` over a live connection.
        subscribe: () => () => {},
        getFull: () => (landed ? FULL : undefined)
      })
      landed = true
      await vi.advanceTimersByTimeAsync(20_000)
      await expect(p).resolves.toEqual({ kind: 'full', facts: FULL })
    } finally {
      vi.useRealTimers()
    }
  })
})
