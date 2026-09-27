// The paging contract of `chat:read-transcript` (the ⌘M ChatPanel). Shared so the renderer that
// ASKS for a window and the core that SERVES it agree on the same bounds.
//
// Why paging exists: the legacy read always parses the last 5 MB of a transcript, and on an SSH
// project it pulls those 5 MB over ssh — on every panel open AND every turn-end reload. The panel
// only ever shows the newest screenful first, so the first read is now a small window ending at
// the end of the file, and older history is fetched a window at a time as the user scrolls up.

/** Smallest window a caller may ask for. A tinier one would mostly be one partial line. */
export const CHAT_PAGE_MIN_BYTES = 64 * 1024
/** Largest window — the legacy read's cap, so no paged read can cost more than an unpaged one. */
export const CHAT_PAGE_MAX_BYTES = 5 * 1024 * 1024
/** Window size when the caller names none. */
export const CHAT_PAGE_DEFAULT_BYTES = 256 * 1024

/** What the renderer sends: a window of at most `maxBytes` ending at byte offset `before`
 *  (absent = end of file). Pass the previous result's `olderCursor` as `before` to page back. */
export interface ChatTranscriptPageRequest {
  before?: number
  maxBytes?: number
}

/** A validated page: `before: null` = end of file. */
export interface ChatTranscriptPage {
  before: number | null
  maxBytes: number
}

/**
 * Validate the page argument. It crosses IPC / the WS bridge, so it is untrusted, and `before` in
 * particular ends up on a remote shell command line (`transcriptPageCommand`) — the type is only a
 * compile-time promise.
 *
 * `undefined` / `null` ⇒ `null`: the caller did not ask for paging, and the legacy read runs
 * byte-for-byte. A bad `maxBytes` is harmless and takes the default (it is only a size); a bad
 * `before` THROWS rather than being coerced to "end of file", because silently answering with a
 * different window than the one asked for would splice the wrong history into the panel.
 */
export function normalizeChatPage(page: unknown): ChatTranscriptPage | null {
  if (page === undefined || page === null) return null
  if (typeof page !== 'object') throw new Error('Invalid transcript page')
  const { before, maxBytes } = page as { before?: unknown; maxBytes?: unknown }
  let b: number | null = null
  if (before !== undefined) {
    if (typeof before !== 'number' || !Number.isSafeInteger(before) || before < 0) {
      throw new Error('Invalid transcript page')
    }
    b = before
  }
  let m = CHAT_PAGE_DEFAULT_BYTES
  if (typeof maxBytes === 'number' && Number.isFinite(maxBytes)) {
    m = Math.min(CHAT_PAGE_MAX_BYTES, Math.max(CHAT_PAGE_MIN_BYTES, Math.floor(maxBytes)))
  }
  return { before: b, maxBytes: m }
}
