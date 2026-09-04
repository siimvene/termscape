import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { withFileLock, FileLockTimeoutError } from './file-lock'

describe('withFileLock', () => {
  let dir: string
  let lock: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'nodeterm-file-lock-'))
    lock = path.join(dir, 'thing.lock')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('runs fn while holding the lock and releases it afterwards', async () => {
    const out = await withFileLock(lock, async () => {
      expect(existsSync(lock)).toBe(true) // held for the duration of fn
      return 42
    })
    expect(out).toBe(42)
    expect(existsSync(lock)).toBe(false) // released
  })

  it('releases the lock even when fn throws', async () => {
    await expect(
      withFileLock(lock, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow(/boom/)
    expect(existsSync(lock)).toBe(false)
  })

  it('serializes overlapping holders — no two run at once', async () => {
    let active = 0
    let maxActive = 0
    const order: number[] = []
    const one = (n: number) =>
      withFileLock(lock, async () => {
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
    const held = withFileLock(lock, () => new Promise<void>((r) => (release = r)))
    await new Promise((r) => setTimeout(r, 5)) // let `held` acquire
    await expect(
      withFileLock(lock, async () => 'never', { timeoutMs: 40 })
    ).rejects.toBeInstanceOf(FileLockTimeoutError)
    release()
    await held
  })

  it('breaks a STALE lockfile (mtime past the ceiling) left by a dead holder', async () => {
    // Simulate a crashed holder: an ancient lockfile nobody will ever release.
    writeFileSync(lock, '')
    const old = Date.now() / 1000 - 60 * 60 // one hour ago, well past STALE_LOCK_MS
    utimesSync(lock, old, old)
    const out = await withFileLock(lock, async () => 'acquired', { timeoutMs: 200 })
    expect(out).toBe('acquired')
    expect(existsSync(lock)).toBe(false)
  })

  it('an unremovable STALE lock throws (bounded) instead of hot-spinning forever', async () => {
    // A DIRECTORY at the lock path: `fs.open(path,'wx')` sees EEXIST, but `fs.rm(path,{force:true})`
    // WITHOUT `recursive` cannot delete a directory — the "stale but unremovable" case. Its mtime is
    // set old so the stale-break branch is entered on every pass. Pre-fix, the failed `fs.rm` set
    // broke=true and `continue`d before the deadline check, hot-spinning forever; now every path
    // checks the deadline and throws.
    mkdirSync(lock)
    const old = Date.now() / 1000 - 60 * 60 // well past STALE_LOCK_MS
    utimesSync(lock, old, old)
    // `now` seam jumps forward on each read so the throw is provably BOUNDED regardless of sleeps.
    let t = Date.now()
    const now = (): number => (t += 100)
    await expect(
      withFileLock(lock, async () => 'never', { timeoutMs: 10, now })
    ).rejects.toBeInstanceOf(FileLockTimeoutError)
    rmSync(lock, { recursive: true, force: true })
  })
})
