// Copies a Claude session's transcript from one managed-account root to another, so the account
// switcher can move an idle conversation between identities and resume it under the new account.
//
// The account switch flips a terminal node's `data.accountId` and cold-restores `claude --resume
// <sessionId>` under the target account's config dir — but that resume reads its transcript from
// the TARGET account's `projects` tree (`transcriptRootFor`). Without this copy the session file
// still lives under the SOURCE root and the resume starts a blank conversation. This service is
// the file-level half: validate, resolve the source strictly by sessionId, and mirror the
// transcript (plus the session's subagents sibling tree) into the target root.
//
// Read/copy only, and injectable (`AccountTranscriptRoots`) so the vitest test never touches the
// real `$HOME` — the shells feed `os.homedir()` + the CorePlatform `userDataDir`.
import fs from 'fs'
import path from 'path'
import { isSafeAccountId, transcriptRootFor } from './claude-accounts-core'
import { SESSION_ID_RE, encodeTranscriptDir } from './transcript-reader'
import { writeFileAtomic } from './fs-atomic'

/** `undefined` accountId = the system `~/.claude` root, exactly like `transcriptRootFor`. */
export type CopySessionTranscriptResult =
  | { ok: true; copied: number }
  | { ok: false; reason: 'not-found' | 'invalid' | 'error' | 'target-unavailable' }

/** Filesystem roots, injected so the test can point at a temp tree. Mirrors the impure wrapper in
 *  transcript-reader.ts: `homeDir` = `os.homedir()`, `userDataDir` = the CorePlatform data dir. */
export interface AccountTranscriptRoots {
  homeDir: string
  userDataDir: string
}

/** Resolve the `projects` root for an account (or the system default when undefined). Reuses
 *  `transcriptRootFor`, whose id validation is already guaranteed by the caller's `isSafeAccountId`
 *  gate below — so a bad id can never build a path here. */
function projectsRoot(roots: AccountTranscriptRoots, accountId: string | undefined): string {
  return transcriptRootFor(roots.homeDir, roots.userDataDir, accountId)
}

/** The project subdir (under a `projects` root) that holds `<sessionId>.jsonl`. Prefers the exact
 *  cwd-encoded dir (`encodeTranscriptDir`, the same encoding Claude uses); falls back to scanning
 *  the root for the session file — STRICTLY by sessionId, never the newest transcript. Returns the
 *  bare dir NAME so the copy can place the file under the same subdir on the target root. */
async function findProjectDir(
  root: string,
  cwd: string,
  sessionId: string
): Promise<string | undefined> {
  const file = `${sessionId}.jsonl`
  if (cwd) {
    const encoded = encodeTranscriptDir(cwd)
    try {
      await fs.promises.access(path.join(root, encoded, file))
      return encoded
    } catch {
      /* fall through to the scan */
    }
  }
  let dirs: string[]
  try {
    dirs = await fs.promises.readdir(root)
  } catch {
    return undefined
  }
  for (const d of dirs) {
    try {
      await fs.promises.access(path.join(root, d, file))
      return d
    } catch {
      /* keep looking */
    }
  }
  return undefined
}

/** Recursively copy `src` into `dst` (files via the atomic helper — the guard test refuses bare
 *  renames), returning the number of files copied. A missing `src` copies nothing (0). */
async function copyTree(src: string, dst: string): Promise<number> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(src, { withFileTypes: true })
  } catch {
    return 0
  }
  await fs.promises.mkdir(dst, { recursive: true })
  let copied = 0
  for (const e of entries) {
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) copied += await copyTree(s, d)
    else if (e.isFile()) {
      const data = await fs.promises.readFile(s, 'utf8')
      await writeFileAtomic(d, data)
      copied++
    }
  }
  return copied
}

/**
 * Copy a Claude session's transcript from `fromAccountId`'s root to `toAccountId`'s root (either
 * side `undefined` = the system `~/.claude` root). Also mirrors the session's subagents sibling
 * tree (`<projectDir>/<sessionId>/`, the directory subagent tails read) when present. `copied`
 * counts every file written — the transcript plus each subagent file.
 *
 * Both account ids are validated with the same rule as `accountConfigDir` (a forged id can never
 * traverse), and the sessionId with `SESSION_ID_RE` (no `/` or `.`, so it can never escape its
 * project dir) BEFORE any path is built.
 */
export async function copySessionTranscript(
  sessionId: string,
  fromAccountId: string | undefined,
  toAccountId: string | undefined,
  cwd: string,
  roots: AccountTranscriptRoots
): Promise<CopySessionTranscriptResult> {
  // Explicit typeof gates BEFORE the regexes: these args arrive off the wire (the Server
  // Edition exposes this handler to any authenticated client), and RegExp.test coerces —
  // test(null) tests the string "null", which matches, silently widening "undefined = system
  // root" to "null = system root" (review finding).
  const validId = (v: unknown): v is string | undefined =>
    v === undefined || (typeof v === 'string' && isSafeAccountId(v))
  if (!validId(fromAccountId) || !validId(toAccountId)) return { ok: false, reason: 'invalid' }
  if (typeof sessionId !== 'string' || !sessionId || !SESSION_ID_RE.test(sessionId))
    return { ok: false, reason: 'invalid' }

  try {
    let sourceRoot = projectsRoot(roots, fromAccountId)
    const targetRoot = projectsRoot(roots, toAccountId)

    // A managed TARGET dir must already hold a login: the mkdir below would otherwise
    // MANUFACTURE the config dir, defeating pty-manager's missing-dir → system fallback — the
    // respawn would launch inside a credential-less dir and hit a login wall (review finding).
    // The system root (undefined) needs no check; `~/.claude` is not ours to gate.
    if (toAccountId !== undefined) {
      const accountDir = path.dirname(targetRoot) // <userData>/claude-accounts/<id>
      try {
        await fs.promises.access(path.join(accountDir, '.claude.json'))
      } catch {
        return { ok: false, reason: 'target-unavailable' }
      }
    }

    let projectDir = await findProjectDir(sourceRoot, cwd, sessionId)
    // A node whose original spawn FELL BACK to the system account (missing dir at spawn time)
    // carries accountId=X while its transcript lives under the SYSTEM root — the one node you
    // most want to move off a broken account. Fall back to the system root before giving up;
    // still strictly by sessionId, so this can never adopt a stranger's transcript.
    if (!projectDir && fromAccountId !== undefined) {
      const systemRoot = projectsRoot(roots, undefined)
      projectDir = await findProjectDir(systemRoot, cwd, sessionId)
      if (projectDir) sourceRoot = systemRoot
    }
    if (!projectDir) return { ok: false, reason: 'not-found' }

    const file = `${sessionId}.jsonl`
    const sourceFile = path.join(sourceRoot, projectDir, file)
    const targetFile = path.join(targetRoot, projectDir, file)
    let data: string
    try {
      data = await fs.promises.readFile(sourceFile, 'utf8')
    } catch {
      return { ok: false, reason: 'not-found' }
    }
    await fs.promises.mkdir(path.dirname(targetFile), { recursive: true })
    await writeFileAtomic(targetFile, data)
    let copied = 1

    // The session's sibling tree (`<projectDir>/<sessionId>/`) holds the subagent transcripts a
    // subagent tail streams — mirror whatever exists so resumed subagents still resolve.
    copied += await copyTree(
      path.join(sourceRoot, projectDir, sessionId),
      path.join(targetRoot, projectDir, sessionId)
    )
    return { ok: true, copied }
  } catch {
    return { ok: false, reason: 'error' }
  }
}
