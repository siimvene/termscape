import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { withFileLock, FileLockTimeoutError, FileLockCompromisedError } from './file-lock'

describe('withFileLock', () => {
  let dir: string
  let resource: string
  let lockDir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'nodeterm-file-lock-'))
    // The RESOURCE being protected (need not exist); the artifact is `${resource}.lock` (a directory).
    resource = path.join(dir, 'thing')
    lockDir = `${resource}.lock`
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('runs fn while holding the lock and releases it afterwards', async () => {
    const out = await withFileLock(resource, async () => {
      expect(existsSync(lockDir)).toBe(true) // held for the duration of fn
      return 42
    })
    expect(out).toBe(42)
    expect(existsSync(lockDir)).toBe(false) // released
  })

  it('releases the lock even when fn throws', async () => {
    await expect(
      withFileLock(resource, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow(/boom/)
    expect(existsSync(lockDir)).toBe(false)
  })

  it('serializes overlapping holders — no two run at once', async () => {
    let active = 0
    let maxActive = 0
    const order: number[] = []
    const one = (n: number) =>
      withFileLock(resource, async () => {
        active++
        maxActive = Math.max(maxActive, active)
        order.push(n)
        await new Promise((r) => setTimeout(r, 15))
        active--
      })
    await Promise.all([one(1), one(2), one(3)])
    expect(maxActive).toBe(1) // never overlapped
    expect(order.sort()).toEqual([1, 2, 3]) // all ran
  })

  it('throws FileLockTimeoutError when a live lock is never released within the budget', async () => {
    // Hold the lock, then race a second acquire with a tight budget against it.
    let release!: () => void
    const held = withFileLock(resource, () => new Promise<void>((r) => (release = r)))
    await new Promise((r) => setTimeout(r, 20)) // let `held` acquire
    await expect(
      withFileLock(resource, async () => 'never', { timeoutMs: 60 })
    ).rejects.toBeInstanceOf(FileLockTimeoutError)
    release()
    await held
  })

  it('breaks a STALE lock (mtime past the ceiling) left by a dead holder', async () => {
    // Simulate a crashed holder: an ancient lockfile DIRECTORY nobody will ever release.
    mkdirSync(lockDir)
    const old = Date.now() / 1000 - 60 * 60 // one hour ago, well past the stale ceiling
    utimesSync(lockDir, old, old)
    const out = await withFileLock(resource, async () => 'acquired', { timeoutMs: 500 })
    expect(out).toBe('acquired')
    expect(existsSync(lockDir)).toBe(false)
  })

  it('does NOT break a live holder that outlives the stale ceiling (heartbeat keeps it fresh)', async () => {
    // A short stale window with a live holder that holds LONGER than it: the heartbeat must keep the
    // lock alive so a waiter never steals it. The hand-rolled predecessor had no heartbeat and would
    // have let the second acquire break in.
    let sawSecond = false
    const held = withFileLock(
      resource,
      async () => {
        await new Promise((r) => setTimeout(r, 350)) // > stale (2000 floor doesn't apply to us — see below)
      },
      { staleMs: 2000, updateMs: 1000 }
    )
    await new Promise((r) => setTimeout(r, 20))
    // Second acquire with a budget that spans the whole hold: it must WAIT for the release, not
    // break in, and then run exactly once afterwards.
    const second = withFileLock(
      resource,
      async () => {
        sawSecond = true
      },
      { staleMs: 2000, updateMs: 1000, timeoutMs: 2000 }
    )
    await Promise.all([held, second])
    expect(sawSecond).toBe(true)
    expect(existsSync(lockDir)).toBe(false)
  })

  it('throws FileLockCompromisedError when the held lock is broken out from under it', async () => {
    // Force a compromise: while the lock is held, rewrite the lockfile mtime so the holder's next
    // heartbeat stats a mtime that is no longer its own — exactly what a stale-break by another
    // process would leave behind. proper-lockfile fires onCompromised; withFileLock fails closed.
    await expect(
      withFileLock(
        resource,
        async () => {
          // Wait for the lock dir to exist, then forge its mtime to a foreign value.
          await new Promise((r) => setTimeout(r, 50))
          const foreign = Date.now() / 1000 - 5 // any value != the holder's recorded mtime
          utimesSync(lockDir, foreign, foreign)
          // Hold past at least one heartbeat so the compromise is detected before fn returns.
          await new Promise((r) => setTimeout(r, 1600))
        },
        { staleMs: 2000, updateMs: 1000 }
      )
    ).rejects.toBeInstanceOf(FileLockCompromisedError)
  })
})
