// Per-agent transcript file locators. Each resolves an on-disk transcript path from the
// sessionId captured via hooks. Filesystem + home-dir access only — lives in core so both
// the handoff feature (src/main) and context-link (src/core) can use it.
import { grokSessionDirFor } from '../grok-session'
import { GROK_CHAT_HISTORY_FILE } from '../agents/grok-paths'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveTranscriptPath } from '../transcript-reader'
import { piAgentDir } from '../agents/hooks/pi'
import { piAccountDirFor } from '../pi-config-dir'
import { platform } from '../platform'

// claude: ~/.claude/projects/<proj>/<sessionId>.jsonl — already implemented (searches all
// project dirs for the exact <sessionId>.jsonl). `accountId` scopes to a managed account's
// transcript root (default `~/.claude`).
export function locateClaude(sessionId: string, accountId?: string): Promise<string | undefined> {
  return resolveTranscriptPath(sessionId, accountId)
}

// codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl — walk the tree and
// match a .jsonl filename containing the sessionId. Managed accounts are Claude-only, so the
// codex/gemini locators ignore accountId (present only to satisfy the shared Locator type).
export async function locateCodex(sessionId: string): Promise<string | undefined> {
  const root = path.join(os.homedir(), '.codex', 'sessions')
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile() && e.name.endsWith('.jsonl') && e.name.includes(sessionId)) return p
    }
  }
  return undefined
}

// gemini: ~/.gemini/tmp/<proj>/chats/session-*.jsonl — find the file whose first-line
// header sessionId equals the requested sessionId.
/**
 * grok's transcript, from the session directory a hook told us about — DERIVED, never searched.
 *
 * Two things here are load-bearing and neither is obvious:
 *
 * 1. The file is `chat_history.jsonl`, NOT the `updates.jsonl` that grok's own hook payloads
 *    advertise as their transcript path. Both are siblings in the same session directory, and
 *    only the first holds the conversation `linesFromGrok` can read. Routing this through the
 *    advertised path fails SILENTLY — a real file is opened, no line parses, and the linked agent
 *    is handed an empty transcript with nothing logged. `grok-context-link.test.ts` pins it.
 * 2. The directory comes from `grokSessionDirFor`, the hook-fed map, and there is deliberately no
 *    fallback that scans grok's sessions tree. A scan keyed on anything weaker than the session id
 *    is how one node ends up reading another node's conversation — the same trap claude's
 *    cwd-newest fallback set for codex. No hook yet ⇒ no transcript yet, which degrades to nothing
 *    rather than to somebody else's.
 */
export async function locateGrok(sessionId: string): Promise<string | undefined> {
  const dir = grokSessionDirFor(sessionId)
  if (!dir) return undefined
  const p = path.join(dir, GROK_CHAT_HISTORY_FILE)
  try {
    await fs.promises.access(p, fs.constants.R_OK)
    return p
  } catch {
    return undefined
  }
}

/**
 * pi: `<agentDir>/sessions/<encoded cwd>/<ISO-timestamp>_<sessionId>.jsonl` — walk the tree and
 * match a `.jsonl` filename ENDING WITH `_<sessionId>.jsonl`. Strict by construction: a session id
 * is a UUIDv7, so no other filename can end with `_` + one, and this never widens into a `.includes`
 * scan the way codex's locator does (that one is safe only because codex's ids are never a suffix
 * of one another either, but there is no reason to take the looser rule twice).
 *
 * `accountId` scopes the walk to a managed pi account's own agent dir
 * (`<userData>/pi-accounts/<id>/sessions`, mirroring claude's managed-account root) instead of the
 * system one (`piAgentDir()/sessions`, honoring `$PI_CODING_AGENT_DIR`) — never both, and never a
 * home-wide scan (the same tree also holds `auth.json`, which is exactly why
 * `isSafeLocalTranscriptPath` only ever admits the `sessions` leaf).
 */
export async function locatePi(sessionId: string, accountId?: string): Promise<string | undefined> {
  if (!sessionId) return undefined
  let root: string
  if (accountId) {
    // The id is asserted (`isSafeAccountId`) exactly as claude's `accountConfigDir` asserts its
    // own: it reaches here from a relay-reachable handler (handoff:build) and from context-link
    // node data, and a traversing value would walk any directory literally named `sessions`.
    try {
      root = path.join(piAccountDirFor(platform().userDataDir, accountId), 'sessions')
    } catch {
      return undefined
    }
  } else {
    root = path.join(piAgentDir(), 'sessions')
  }
  const suffix = `_${sessionId}.jsonl`
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile() && e.name.endsWith(suffix)) return p
    }
  }
  return undefined
}

export async function locateGemini(sessionId: string): Promise<string | undefined> {
  const tmp = path.join(os.homedir(), '.gemini', 'tmp')
  let projects: string[]
  try {
    projects = await fs.promises.readdir(tmp)
  } catch {
    return undefined
  }
  for (const proj of projects) {
    const chats = path.join(tmp, proj, 'chats')
    let files: string[]
    try {
      files = await fs.promises.readdir(chats)
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const p = path.join(chats, f)
      try {
        const head = (await fs.promises.readFile(p, 'utf8')).split('\n', 1)[0]
        const o = JSON.parse(head) as { sessionId?: string }
        if (o.sessionId === sessionId) return p
      } catch {
        /* keep looking */
      }
    }
  }
  return undefined
}
