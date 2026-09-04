// A cross-process advisory lock, built on an O_EXCL lockfile.
//
// `renameAtomic`/`writeFileAtomic` (fs-atomic.ts) guarantee COMPLETE bytes, never correct ORDER
// between two read-modify-write callers loaded before either write — see docs/atomic-writes.md.
// A per-process write queue serializes that process's writers and says nothing about a SECOND
// process on the same directory (two `nodeterm-server --data-dir X`, a desktop sharing it). For a
// read-modify-write on a shared file that must not lose a concurrent process's change, the
// complete fix is an advisory lock held across read + write; Node exposes no `flock` without a
// native dependency, so this is the portable stand-in.
//
// The lock is the ATOMIC EXISTENCE of a `<file>.lock` sibling created with `wx`
// (O_CREAT|O_EXCL|O_WRONLY): exactly one creator wins, the loser sees `EEXIST` and waits. Release
// is an unlink. A crash between create and unlink would strand the lock forever, so a lock whose
// mtime is older than `STALE_LOCK_MS` is broken and re-taken — the one race this cannot fully
// close (two processes breaking the same stale lock in the same instant) is narrowed by a
// re-stat immediately before the unlink and is no worse than the lock-less check-then-act it
// replaces. This is advisory: it serializes callers that USE it, nothing more.

import { promises as fs } from 'fs'

/** Default ceiling on how long an acquire waits before giving up. Settings writes sit behind user
 *  actions and complete in single-digit ms, so real contention is brief; the ceiling exists so a
 *  wedged holder surfaces as a thrown error rather than a hang. */
const DEFAULT_TIMEOUT_MS = 5000
/** Poll interval while the lock is held by someone else. */
const RETRY_MS = 20
/** A lockfile older than this is treated as abandoned by a dead holder and broken. Generous
 *  relative to a write (ms) so it never fires against a live, slow holder. */
const STALE_LOCK_MS = 30_000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function codeOf(e: unknown): string {
  return typeof e === 'object' && e && 'code' in e ? String((e as { code: unknown }).code) : ''
}

/** Thrown when the lock could not be acquired within the budget — a wedged or hopelessly contended
 *  holder. Callers surface it as a failed write (never a stale one). */
export class FileLockTimeoutError extends Error {
  constructor(lockPath: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms acquiring ${lockPath}`)
    this.name = 'FileLockTimeoutError'
  }
}

export interface FileLockOptions {
  /** Acquire budget in ms (default 5000). */
  timeoutMs?: number
  /** Test seam for the wall clock. Production uses `Date.now`. */
  now?: () => number
}

/**
 * Run `fn` while holding an exclusive lock keyed on `lockPath` (a `<file>.lock` sibling). Acquires
 * with a bounded wait — throwing `FileLockTimeoutError` on timeout — runs `fn`, then always
 * releases (even if `fn` throws). The lock is cross-process: a second process on the same directory
 * acquiring the SAME `lockPath` blocks until this one releases.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {}
): Promise<T> {
  const now = opts.now ?? Date.now
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const deadline = now() + timeoutMs
  for (;;) {
    try {
      // `wx` = O_CREAT|O_EXCL: the create is the acquire. Existence is the lock; the empty file's
      // mtime is the staleness clock, so nothing is written into it.
      const handle = await fs.open(lockPath, 'wx')
      await handle.close()
      break
    } catch (e) {
      if (codeOf(e) !== 'EEXIST') throw e
      // Held by someone. Break it only if it looks abandoned (mtime past the stale ceiling),
      // re-checking immediately before the unlink so we never remove a lock another process just
      // freshly created (its mtime would then be recent again).
      let broke = false
      try {
        const st = await fs.stat(lockPath)
        if (now() - st.mtimeMs > STALE_LOCK_MS) {
          const again = await fs.stat(lockPath)
          if (now() - again.mtimeMs > STALE_LOCK_MS) {
            await fs.rm(lockPath, { force: true })
            broke = true
          }
        }
      } catch {
        // The lockfile vanished between our open and our stat — the holder released. Retry now.
        broke = true
      }
      if (broke) continue
      if (now() >= deadline) throw new FileLockTimeoutError(lockPath, timeoutMs)
      await sleep(RETRY_MS)
    }
  }
  try {
    return await fn()
  } finally {
    await fs.rm(lockPath, { force: true }).catch(() => {})
  }
}
