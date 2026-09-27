// The two transcript READ channels — the ⌘M chat view (`chat:read-transcript`) and the find-bar's
// full-transcript index (`claude:read-transcript`) — registered through the CorePlatform seam so
// BOTH shells serve them.
//
// This lived inline in `src/main/index.ts`, which is exactly the failure mode the seam exists to
// prevent: the Server Edition had no handler at all, its bridge stub rejected, and the chat panel
// (which never caught the rejection) presented every browser session as an empty conversation.
//
// The remote (SSH-project) leg stays an injected dep: it needs a ControlMaster, which only the
// Electron shell has. Absent deps ⇒ local-only, which is the correct and complete answer on the
// server — it runs ON the host whose transcripts it is reading.
import fsp from 'node:fs/promises'
import { IPC } from '../shared/ipc'
import type { ChatTranscriptResult, TranscriptLine, TranscriptPresence } from '../shared/types'
import { CHAT_PAGE_MAX_BYTES, normalizeChatPage, type ChatTranscriptPage } from '../shared/chat-page'
import { platform } from './platform'
import { chatMessagesFromGrok } from './grok-chat'
import { locateGrok } from './handoff/locate'
import {
  parseChatMessages,
  parseChatWindow,
  parseTranscriptLines,
  readChatWindow,
  readCappedTail,
  readChatMessages,
  readTranscriptLines,
  resolveTranscriptPath,
  transcriptPresence,
  transcriptPathForCwd,
  SESSION_ID_RE
} from './transcript-reader'

/** What a read is asked for. `nodeId` is only meaningful to the remote leg. */
export interface TranscriptQuery {
  sessionId: string | undefined
  cwd: string | undefined
  accountId: string | undefined
  nodeId: string | undefined
}

export interface TranscriptIpcDeps {
  /** Transcript path a live context tail already knows for this session (hook-fed — authoritative
   *  when present). Optional: the sessionId scan below finds any transcript in a standard root. */
  pathFor?(sessionId: string): string | undefined
  /**
   * Tail text of a REMOTE node's transcript, or null when this is not a remote session (or it
   * could not be resolved). Electron-only — the server has no SSH-project manager.
   */
  readRemote?(q: TranscriptQuery): Promise<string | null>
  /**
   * Does the transcript exist on the HOST — or `null` when this is not a remote session, which is
   * the signal to take the local path below. Same `null` convention as `readRemote`.
   *
   * It must return `'unknown'` (not `null`) for a remote session it failed to ask, or the local
   * resolver would run against THIS machine's disk for a session that only ever existed on the
   * host and report `absent` — the one answer that destroys a resume. Electron-only.
   */
  remoteExists?(q: TranscriptQuery): Promise<TranscriptPresence | null>
  /**
   * ONE page of a REMOTE node's transcript — a ranged read on the host, so a paged ⌘M open moves
   * a window over ssh instead of the legacy 5 MB tail. `null` = not a remote session (same
   * convention as `readRemote`); `{ok:false}` = it IS remote and the host could not be read, which
   * must end as not-found rather than fall through to THIS machine's disk. `data` is the file's
   * bytes from absolute offset `start` (one lookbehind byte included — see `parseChatWindow`).
   * Electron-only.
   */
  readRemotePage?(q: TranscriptQuery, page: ChatTranscriptPage): Promise<RemoteTranscriptPage | null>
}

export type RemoteTranscriptPage = { ok: true; data: Buffer; start: number } | { ok: false }

/** How much a window with no complete line grows per re-read. ×4 reaches the 5 MB cap from the
 *  default 256 KB tail in three extra reads, and from the 64 KB minimum in four. */
const CHAT_PAGE_GROWTH = 4

/** A window read: its bytes from absolute offset `start` (lookbehind byte included), or `null` when
 *  the read failed — which ends the whole page as not-found. */
type WindowRead = (page: ChatTranscriptPage) => Promise<{ data: Buffer; start: number } | null>

/**
 * Parse the window `first` (already read for `page`), GROWING it while it holds no complete line.
 *
 * A record bigger than the window — in practice a `type:user` line carrying a pasted screenshot or
 * an image tool_result, measured at 181 lines above 512 KB in 30 days on one host — used to leave
 * the window empty, and the cursor then pointed INTO that record, so the next older read ended
 * mid-line, failed to parse and the record vanished: screenshot prompts gone, tools missing their
 * results. The legacy 5 MB read showed them. So the same `before` is re-read with a bigger window
 * (×`CHAT_PAGE_GROWTH`) up to `CHAT_PAGE_MAX_BYTES`, the legacy cap — no paged read ever costs more
 * than an unpaged one did, and only a line longer than 5 MB (which the legacy read could not show
 * either) is skipped. Shared by the local and the remote leg, so both page identically.
 *
 * A failed re-read is NOT answered with the skip: dropping a record because the host blinked is the
 * very bug this exists to fix. It is a failed read, and the caller's retry path handles it.
 */
async function parseGrowingWindow(
  page: ChatTranscriptPage,
  first: { data: Buffer; start: number },
  read: WindowRead
): Promise<ChatTranscriptResult> {
  let w = first
  let maxBytes = page.maxBytes
  for (;;) {
    const { noCompleteLine, ...parsed } = parseChatWindow(w.data, w.start)
    if (!noCompleteLine || w.start === 0 || maxBytes >= CHAT_PAGE_MAX_BYTES) return { found: true, ...parsed }
    maxBytes = Math.min(CHAT_PAGE_MAX_BYTES, maxBytes * CHAT_PAGE_GROWTH)
    const next = await read({ before: page.before, maxBytes })
    if (!next) return notFoundPage()
    w = next
  }
}

const notFoundPage = (): ChatTranscriptResult => ({
  messages: [],
  found: false,
  olderCursor: null,
  unmatchedResults: []
})

/**
 * A paged chat read (`chat:read-transcript` with its trailing `page` argument). Kept apart from the
 * legacy branch so the unpaged result stays byte-for-byte what it was.
 *
 * Remote first, as in the legacy path, and a remote failure is TERMINAL: a remote session's
 * transcript lives on the host, so falling through to the local resolver would answer from the
 * wrong machine. The remote leg is `readRemotePage` ONLY: a shell that can read a remote transcript
 * must inject it (the desktop does), because paging with only the legacy `readRemote` would read a
 * remote session's LOCAL namesake. (A `readRemote`-only fallback lived here with no caller; it was
 * removed rather than kept untested.)
 */
async function readChatPage(
  q: TranscriptQuery,
  page: ChatTranscriptPage,
  deps: TranscriptIpcDeps
): Promise<ChatTranscriptResult> {
  const readRemotePage = deps.readRemotePage
  if (readRemotePage) {
    const remote = await readRemotePage(q, page)
    if (remote !== null) {
      if (!remote.ok) return notFoundPage()
      // A growth re-read that suddenly says "not remote" (null) is a failed read too — never a
      // reason to go read THIS machine's disk halfway through a remote page.
      return parseGrowingWindow(page, remote, async (p) => {
        const r = await readRemotePage(q, p)
        return r && r.ok ? r : null
      })
    }
  }
  const p = await resolveTranscript(q, deps.pathFor)
  if (!p) return notFoundPage()
  const w = await readChatWindow(p, page)
  // Resolved but unreadable (deleted between resolve and read): not-found, like a failed remote.
  if (!w) return notFoundPage()
  return parseGrowingWindow(page, w, async (pg) => (await readChatWindow(p, pg)) ?? null)
}

/**
 * Resolve a session's transcript path: the exact session file when a (valid) sessionId is known,
 * else the node's cwd — durable, and needing no live hook event. `accountId` scopes BOTH legs to
 * the same root: dropping it on the fallback sent a managed-account node to the system root, where
 * it found nothing or adopted an unrelated session's newest transcript.
 */
export async function resolveTranscript(
  q: Pick<TranscriptQuery, 'sessionId' | 'cwd' | 'accountId'>,
  pathFor?: (sessionId: string) => string | undefined
): Promise<string | undefined> {
  let p: string | undefined
  if (q.sessionId && SESSION_ID_RE.test(q.sessionId)) {
    p = pathFor?.(q.sessionId) ?? (await resolveTranscriptPath(q.sessionId, q.accountId))
  }
  if (!p && q.cwd) p = await transcriptPathForCwd(q.cwd, q.accountId)
  return p
}

export function registerTranscriptIpc(deps: TranscriptIpcDeps = {}): void {
  const remoteText = (q: TranscriptQuery): Promise<string | null> =>
    deps.readRemote ? deps.readRemote(q) : Promise.resolve(null)

  platform().handle(
    IPC.claudeReadTranscript,
    async (
      sessionId: string | undefined,
      cwd: string | undefined,
      accountId: string | undefined,
      nodeId: string | undefined
    ): Promise<TranscriptLine[]> => {
      const remote = await remoteText({ sessionId, cwd, accountId, nodeId })
      if (remote !== null) return parseTranscriptLines(remote)
      const p = await resolveTranscript({ sessionId, cwd, accountId }, deps.pathFor)
      return p ? readTranscriptLines(p) : []
    }
  )

  platform().handle(
    IPC.transcriptExists,
    async (
      sessionId: string | undefined,
      accountId: string | undefined,
      nodeId: string | undefined
    ): Promise<TranscriptPresence> => {
      if (!sessionId) return 'unknown'
      // Remote first, and its `'unknown'` is TERMINAL. Falling through to the local resolver for
      // a remote session whose host we could not reach would search this machine for a file that
      // only ever existed on the other one, and answer `absent` about it.
      const remote = deps.remoteExists ? await deps.remoteExists({ sessionId, cwd: undefined, accountId, nodeId }) : null
      if (remote !== null) return remote
      // A live context tail's own path is the authoritative hint — but it is a HINT, so it is
      // verified rather than trusted: the file it names can have been deleted since.
      const hinted = deps.pathFor?.(sessionId)
      if (hinted) {
        try {
          await fsp.access(hinted)
          return 'present'
        } catch {
          /* fall through to the scan */
        }
      }
      return transcriptPresence(sessionId, accountId)
    }
  )

  platform().handle(
    IPC.chatReadTranscript,
    async (
      sessionId: string | undefined,
      cwd: string | undefined,
      accountId: string | undefined,
      nodeId: string | undefined,
      agentId: string | undefined,
      rawPage?: unknown
    ): Promise<ChatTranscriptResult> => {
      // Validated FIRST: it arrived over IPC / the WS bridge, and `before` reaches a remote shell
      // line. `null` = no page asked for = the legacy read below, byte for byte.
      const page = normalizeChatPage(rawPage)
      // Routed by agent BEFORE anything claude-shaped runs. `resolveTranscript` below falls back to
      // the newest claude transcript for the cwd when its sessionId leg misses, and a grok id always
      // misses — so reaching that fallback with a grok node would answer with a stranger's
      // conversation. The remote leg is claude-only too (its reader tails claude's file), so a grok
      // node is served locally or not at all rather than being handed the wrong host's claude log.
      if (agentId === 'grok') {
        const gp = sessionId ? await locateGrok(sessionId) : undefined
        // Grok does NOT page: its history is small and its reader has no byte-offset keys, so a
        // paged request gets the whole (capped) read with `olderCursor: null` — "nothing older to
        // fetch" — and no carried results. Keys are absent; the panel falls back to its own.
        const paging = page ? { olderCursor: null, unmatchedResults: [] } : {}
        if (!gp) return { messages: [], found: false, ...paging }
        const buf = await readCappedTail(gp)
        return buf === undefined
          ? { messages: [], found: false, ...paging }
          : { messages: chatMessagesFromGrok(buf), found: true, ...paging }
      }
      if (page) return readChatPage({ sessionId, cwd, accountId, nodeId }, page, deps)
      const remote = await remoteText({ sessionId, cwd, accountId, nodeId })
      // A resolved-but-unreadable remote file is NOT "no conversation yet" — the read failed
      // (master down, transcript gone), and the panel must be able to say so.
      if (remote !== null) return { messages: parseChatMessages(remote.split('\n')), found: !!remote }
      const p = await resolveTranscript({ sessionId, cwd, accountId }, deps.pathFor)
      return p
        ? { messages: await readChatMessages(p), found: true }
        : { messages: [], found: false }
    }
  )
}
