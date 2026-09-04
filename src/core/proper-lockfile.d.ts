// Minimal ambient types for `proper-lockfile` (the package ships none, and @types/proper-lockfile
// is not vendored). Only the async surface `file-lock.ts` uses is declared; the sync variants and
// `check`/`unlock` are intentionally omitted — add them here if a caller ever needs them.
declare module 'proper-lockfile' {
  interface LockOptions {
    /** ms after which a lockfile whose mtime is older is considered abandoned and may be broken. */
    stale?: number
    /** ms between mtime heartbeats that keep a held lock fresh (default stale/2). */
    update?: number
    /** `retry` module config for the acquire; a number is shorthand for `{ retries: n }`. */
    retries?: number | { retries?: number; factor?: number; minTimeout?: number; maxTimeout?: number; randomize?: boolean }
    /** When false, the path is used verbatim (no `fs.realpath`) — required for a file that may not exist. */
    realpath?: boolean
    /** Exact lockfile artifact path; defaults to `${file}.lock`. */
    lockfilePath?: string
    /** Called if the held lock is lost (stale-broken by another holder, or the heartbeat failed). */
    onCompromised?: (err: Error) => void
  }
  /** Acquire the lock for `file`, resolving to a release function. */
  function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>
  export = lock
}
