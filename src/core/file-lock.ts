// A cross-process advisory lock, backed by `proper-lockfile`.
//
// `renameAtomic`/`writeFileAtomic` (fs-atomic.ts) guarantee COMPLETE bytes, never correct ORDER
// between two read-modify-write callers loaded before either write — see docs/atomic-writes.md.
// A per-process write queue serializes that process's writers and says nothing about a SECOND
// process on the same directory (two `nodeterm-server --data-dir X`, a desktop sharing it). For a
// read-modify-write on a shared file that must not lose a concurrent process's change, the fix is
// an advisory lock held across read + write.
//
// WHY proper-lockfile AND NOT A HAND-ROLLED O_EXCL LOCK. The previous version created a `<file>.lock`
// sibling with `open(…, 'wx')` and broke a lock whose mtime was past a ceiling. That has one race
// it cannot close: two processes breaking the SAME stale lock in the same instant can BOTH acquire
// (one removes the other's freshly-created lock, then both create their own), and NEITHER learns it
// lost — a silent double-acquire that can lose a concurrent process's account row. proper-lockfile
// closes the practical hole two ways a bare O_EXCL cannot:
//   1. A live holder HEARTBEATS its lock (touches the lockfile mtime every `update` ms), so a slow
//      but living holder is never wrongly declared stale and broken. The hand-rolled lock had no
//      heartbeat, so any hold longer than the ceiling was breakable even while alive.
//   2. If a holder's lock IS broken out from under it (stale-break race, or a heartbeat that missed
//      the stale window after a system sleep), proper-lockfile DETECTS it — the holder stats its own
//      lockfile, sees the mtime is no longer its own, and fires `onCompromised`. We surface that as a
//      thrown `FileLockCompromisedError`. This does NOT prevent the write — `fn`'s atomic rename may
//      already have landed by the time the heartbeat detects the break — it FLAGS it: the caller
//      treats the mutation as not-guaranteed-exclusive and retries/refreshes instead of trusting it.
//      Because every protected write is a single atomic rename (whole file, last-writer-wins), a
//      raced write is never torn; the throw turns a SILENT double-acquire into a loud, recoverable one.
// The lock is still ADVISORY: it serializes callers that USE it, nothing more. A raw external write
// that never takes the lock is not ordered — the callers layer a stamp re-read on top (settings-store).

import lock from 'proper-lockfile'

/** Default ceiling on how long an acquire waits before giving up. Settings writes sit behind user
 *  actions and complete in single-digit ms, so real contention is brief; the ceiling exists so a
 *  wedged holder surfaces as a thrown error rather than a hang. */
const DEFAULT_TIMEOUT_MS = 5000
/** Poll interval while the lock is held by someone else (proper-lockfile's own retry is disabled so
 *  the wall-clock budget below governs the wait precisely). */
const RETRY_MS = 20
/** A lockfile whose mtime is older than this is treated as abandoned by a dead holder and broken by
 *  proper-lockfile on the next acquire. Generous relative to a write (ms) and to the heartbeat, so
 *  it never fires against a live holder — the heartbeat keeps a live lock's mtime fresh. */
const STALE_LOCK_MS = 30_000
/** Heartbeat interval: how often a live holder refreshes its lockfile mtime. Well under the stale
 *  ceiling so a brief event-loop stall between beats still leaves the lock live. */
const UPDATE_LOCK_MS = 5_000

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

/** Thrown when a held lock was compromised (broken by another holder / a missed heartbeat) while
 *  `fn` was running. `fn`'s write may already have LANDED (it runs inside `fn`), so this does not
 *  prevent the write — it SIGNALS that it was not guaranteed exclusive. Callers treat it as
 *  not-trusted and retry/refresh rather than trusting it (the write is one atomic rename, so a
 *  raced write is last-writer-wins, never torn). */
export class FileLockCompromisedError extends Error {
  constructor(lockPath: string, cause: Error) {
    super(`Lock ${lockPath} was compromised while held: ${cause.message}`)
    this.name = 'FileLockCompromisedError'
  }
}

export interface FileLockOptions {
  /** Acquire budget in ms (default 5000). */
  timeoutMs?: number
  /** Override the abandoned-lock ceiling (default 30000; proper-lockfile floors it at 2000). */
  staleMs?: number
  /** Override the heartbeat interval (default 5000; proper-lockfile clamps to [1000, stale/2]). */
  updateMs?: number
  /** Test seam for the wall clock, governing the acquire deadline. Production uses `Date.now`.
   *  (proper-lockfile's internal staleness clock is not injectable and always uses the real time.) */
  now?: () => number
}

/**
 * Run `fn` while holding an exclusive lock on `resourcePath` (a `<resourcePath>.lock` sibling
 * directory, created atomically by `mkdir`). Acquires with a bounded wait — throwing
 * `FileLockTimeoutError` on timeout — runs `fn`, then always releases (even if `fn` throws). The
 * lock is cross-process: a second process on the same directory locking the SAME `resourcePath`
 * blocks until this one releases. If the held lock is compromised mid-`fn`, `FileLockCompromisedError`
 * is thrown after `fn` completes (unless `fn` itself threw, whose error takes precedence).
 */
export async function withFileLock<T>(
  resourcePath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {}
): Promise<T> {
  const now = opts.now ?? Date.now
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const deadline = now() + timeoutMs
  const lockfilePath = `${resourcePath}.lock`
  const stale = opts.staleMs ?? STALE_LOCK_MS
  const update = opts.updateMs ?? UPDATE_LOCK_MS
  let compromised: Error | undefined

  // Acquire with a wall-clock-bounded wait. proper-lockfile's own retry is disabled (`retries: 0`)
  // so a held lock throws `ELOCKED` immediately; we poll here until the deadline. A STALE lock is
  // broken by proper-lockfile inside a single `lock()` call, so that path acquires without waiting.
  let release: (() => Promise<void>) | undefined
  for (;;) {
    try {
      release = await lock(resourcePath, {
        realpath: false, // resourcePath may not exist yet (a fresh settings.json is written by fn)
        lockfilePath,
        stale,
        update,
        retries: 0,
        onCompromised: (err) => {
          // Fired from the heartbeat timer; never throw here (that would be an uncaught rejection).
          // Record it so the run below can fail closed.
          compromised = err
        }
      })
      break
    } catch (e) {
      // ELOCKED = a live holder has it: wait and retry until the budget runs out. Any OTHER error
      // (an unbreakable stale lock, a filesystem error) is not a contention signal — propagate it as
      // a failed acquire rather than spinning on it.
      if (codeOf(e) !== 'ELOCKED') throw e
      if (now() >= deadline) throw new FileLockTimeoutError(lockfilePath, timeoutMs)
      await sleep(RETRY_MS)
    }
  }

  try {
    const result = await fn()
    // fn ran to completion — but if the lock was compromised while it ran, its write was not
    // guaranteed exclusive (and, being inside fn, may already have landed on disk). Surface that so
    // the caller treats the mutation as not-trusted and retries/refreshes, rather than reporting a
    // clean success. It is a single atomic rename, so a raced write is last-writer-wins, never torn.
    if (compromised) throw new FileLockCompromisedError(lockfilePath, compromised)
    return result
  } finally {
    // Release is best-effort: a compromised lock is already released internally (proper-lockfile
    // returns ERELEASED), and a release failure must never mask fn's result or error. `release` is
    // always set here (the loop only breaks after a successful acquire), but guard for the compiler.
    if (release) await release().catch(() => {})
  }
}
