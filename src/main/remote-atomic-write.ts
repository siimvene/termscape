import { randomUUID } from 'crypto'
import { quoteRemotePath } from '../shared/ssh'

export interface RemoteAtomicWrite {
  command: string
  temporaryPath: string
}

export interface RemoteAtomicWriteOptions {
  /** Apply umask 077 before creating either the parent or the temp. */
  restrictPermissions?: boolean
  /** Belt-and-braces for credential files: enforce 0600 on the temp before it is published. */
  chmod600?: boolean
  /** False when the caller already created and permissioned the parent directory. */
  makeParent?: boolean
}

function remoteDirname(path: string): string {
  const end = path.replace(/\/+$/, '')
  const slash = end.lastIndexOf('/')
  if (slash < 0) return '.'
  if (slash === 0) return '/'
  return end.slice(0, slash)
}

/**
 * Build the remote-shell half of a stdin → sibling-temp → rename write.
 *
 * The UUID is minted locally for every call. A fixed `<target>.tmp` lets overlapping SSH clients
 * share one inode: one rename can publish the other writer's partial bytes, then the loser cannot
 * find the temp it still intends to rename. The nonce contains only shell-inert ASCII, while the
 * complete paths still go through quoteRemotePath so spaces, apostrophes, literal backslashes and
 * a leading `~/` keep their existing meanings.
 *
 * The cleanup preserves the write/move status. Unique temps do not self-heal on the next write,
 * so a normal cat/mv failure must remove the exact temp this invocation owns.
 */
export function remoteAtomicWrite(
  path: string,
  options: RemoteAtomicWriteOptions = {}
): RemoteAtomicWrite {
  const parentPath = remoteDirname(path)
  const temporaryLeaf = `.nodeterm-${randomUUID()}.tmp`
  // Keep the temp beside the target so mv remains one-filesystem atomic, but do not extend the
  // target leaf: a valid NAME_MAX-length filename plus `.UUID.tmp` cannot be created at all.
  const temporaryPath =
    parentPath === '/'
      ? `/${temporaryLeaf}`
      : parentPath === '.'
        ? temporaryLeaf
        : `${parentPath}/${temporaryLeaf}`
  const target = quoteRemotePath(path)
  const temporary = quoteRemotePath(temporaryPath)
  const prefix = options.restrictPermissions ? 'umask 077; ' : ''
  const parent = options.makeParent === false
    ? ''
    : `mkdir -p -- ${quoteRemotePath(parentPath)} && `
  // `chmod` is the ONE command here that must not take `--`. BSD chmod (every macOS SSH host)
  // accepts options only BEFORE the mode operand, so a trailing `--` is parsed as a FILENAME:
  // `chmod: --: No such file or directory`, exit 1 — and since this sits in the `&&` chain ahead
  // of `mv`, the publish never ran at all. GNU coreutils and busybox both accept it, and CI has no
  // macOS job, so these tests had never been green on a Mac. Both callers are credential writes
  // (the hook endpoint bearer and the per-node identity token in `remote-ssh/remote-hooks.ts`), so
  // on a macOS host the reverse hook tunnel was abandoned outright — no agent status, no context
  // meter, no subagent cards, no canvas control for remote nodes. Fail-closed, so nothing was
  // corrupted: the old file survives and the temp is cleaned.
  // `--` protected a path that could begin with `-`; `./` does the same job and is portable.
  // (mkdir/mv/rm keep their `--`: those parse it correctly everywhere.)
  const chmodOperand = temporaryPath.startsWith('-')
    ? quoteRemotePath(`./${temporaryPath}`)
    : temporary
  const protect = options.chmod600 ? ` && chmod 600 ${chmodOperand}` : ''
  const command =
    `${prefix}${parent}{ cat > ${temporary}${protect} && mv -f -- ${temporary} ${target}; ` +
    `nt_status=$?; ` +
    `rm -f -- ${temporary}; exit "$nt_status"; }`
  return { command, temporaryPath }
}
