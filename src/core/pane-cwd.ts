/**
 * Stale working-directory detection for a WARM tmux reattach (issue #464).
 *
 * The failure this classifies: a project folder is deleted and re-created at the same path while
 * the node's tmux session keeps running. The shell inside still holds the DELETED directory's
 * inode — a fresh directory with the same name is a different inode, so nothing self-heals — and
 * every prompt prints `getcwd: cannot access parent directories`. `tmux new-session -A` reattaches
 * without looking at the cwd we pass, so the warm-attach path is the one that needs to notice.
 *
 * The first signal is tmux's own `#{pane_current_path}` (present since tmux 1.7, so no version
 * hazard — see the bracket_paste_flag tombstone in pty-manager.ts for why that check matters):
 *
 * - **Linux (MEASURED, tmux 3.4):** tmux reads `/proc/<pid>/cwd`, and for an unlinked directory
 *   the kernel reports `<path> (deleted)` — including AFTER a same-named directory is re-created,
 *   because the readlink names the inode the process holds, not the path. This is the definite
 *   signal on Linux.
 * - **macOS (MEASURED 2026-09-02, tmux 3.7c on macOS 27):** tmux's string carries NO signal at
 *   all. `osdep-darwin.c` resolves the cwd via `proc_pidinfo(PROC_PIDVNODEPATHINFO)`, and the
 *   kernel keeps naming the UNLINKED directory by its old path — byte-identical before the
 *   delete, after the delete, and after the same-named `mkdir`. (The earlier rule here said tmux
 *   answers an empty string on darwin. That was inferred from the source and never measured on a
 *   device; the pane it was meant to flag reports a perfectly healthy-looking path, while
 *   `/bin/pwd` inside that same pane fails with `pwd: .: No such file or directory`.) So on
 *   darwin the pane's OWN process is asked instead — see `lsofCwdLinked` below.
 * - **Both platforms:** a non-empty path that no longer exists on disk is stale (deleted and not
 *   yet re-created).
 *
 * The second signal, used where the string is blind, is the identity of the directory the pane
 * process actually holds: the inode `lsof` reports for its cwd versus the inode that is on disk
 * at that name right now. Different inode ⇒ the process sits on an unlinked directory ⇒ stale,
 * whatever name tmux printed for it. An unreadable or unparsable answer is never evidence — it
 * degrades to "no opinion", per the house rule: degrade to nothing, never to something wrong.
 *
 * The verdict only ever raises a dismissible banner with an explicit user action (recycle +
 * respawn) — nothing is typed into the pane and nothing is killed without a click.
 */

export type PaneCwdVerdict = 'ok' | 'stale' | 'unknown'

/** The `/proc` readlink convention tmux passes through verbatim on Linux. */
const DELETED_SUFFIX = ' (deleted)'

/**
 * Classify a pane's live working directory from tmux's `#{pane_current_path}` answer.
 *
 * `reported` is the raw single-line answer (caller strips the trailing newline). `dirExists` is
 * injected so the pure rules are testable without a filesystem; it must answer "is this an
 * existing directory" and never throw. `paneCwdLinked` is the optional second signal: `false`
 * means "the pane's process is sitting on an unlinked directory" (see `lsofCwdLinked`), and
 * `undefined` means nobody asked or the answer was not evidence.
 */
export function classifyPaneCwd(
  reported: string,
  dirExists: (path: string) => boolean,
  platform: NodeJS.Platform = process.platform,
  paneCwdLinked?: boolean
): PaneCwdVerdict {
  // An explicit answer about the pane PROCESS's own directory outranks every string rule below:
  // sitting on an unlinked directory IS the failure this classifies, and on darwin the string
  // cannot see it (measured — see the module docblock).
  if (paneCwdLinked === false) return 'stale'
  // Deliberately NOT trimmed: a path may legally end in spaces, and the one suffix we match is
  // exact. Only a trailing newline is the transport's, and the caller already removed it.
  if (reported === '') {
    // darwin: kept as a fallback, not as the primary signal — tmux answering nothing for a live
    // pane on the one platform whose osdep always has a cwd reader is trouble either way.
    // Elsewhere empty is "tmux could not say", which is not evidence of anything.
    return platform === 'darwin' ? 'stale' : 'unknown'
  }
  if (reported.endsWith(DELETED_SUFFIX)) return 'stale'
  // Only judge an absolute path: anything else is not a directory answer at all.
  if (!reported.startsWith('/')) return 'unknown'
  // A path tmux still resolves cleanly but that is gone from disk: deleted, not yet re-created.
  // (The recreated-same-path case never lands here — on Linux it keeps the " (deleted)" suffix
  // above, and on darwin it arrives as `paneCwdLinked === false` from the probe.)
  return dirExists(reported) ? 'ok' : 'stale'
}

/**
 * Is the directory a pane process holds as its cwd still LINKED at the name the kernel gives it?
 *
 * `stdout` is the output of `lsof -a -p <pane pid> -d cwd -FDin` — the `-F` field format, one
 * letter per line: `D<device, hex>`, `i<inode>`, `n<path>`. `statDir` answers with the device and
 * inode of the directory that is on disk at a path right now, or `undefined` when there is none;
 * it must never throw.
 *
 * `false` only ever comes from a POSITIVE mismatch (the name resolves to a different directory
 * than the one the process holds — i.e. deleted and re-created). Anything unreadable, unparsable
 * or unresolvable answers `undefined`: the caller's string rules already judge "the path is
 * simply gone", and a mangled parse must not put a banner on screen.
 */
export function lsofCwdLinked(
  stdout: string,
  statDir: (path: string) => { dev: number; ino: number } | undefined
): boolean | undefined {
  let dev: number | undefined
  let ino: number | undefined
  let name: string | undefined
  for (const line of stdout.split('\n')) {
    const value = line.slice(1)
    if (line[0] === 'D') dev = Number.parseInt(value, 16)
    else if (line[0] === 'i') ino = Number(value)
    // The path field is last in a record and may contain anything except a newline — taken raw,
    // never trimmed, for the same reason `classifyPaneCwd` does not trim.
    else if (line[0] === 'n') name = value
  }
  if (ino === undefined || !Number.isFinite(ino) || !name?.startsWith('/')) return undefined
  const now = statDir(name)
  if (!now) return undefined
  if (dev !== undefined && Number.isFinite(dev) && dev !== now.dev) return false
  return ino === now.ino
}
