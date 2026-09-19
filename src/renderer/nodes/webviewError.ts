/**
 * What a `did-fail-load` from a `<webview>` guest means, in words a user can act on.
 *
 * Chromium renders its own error page inside the guest for a failed main-frame navigation. That
 * page is another product's chrome sitting in the middle of ours, it names the failure only as an
 * `ERR_` symbol, and it offers no way back into the node. So the surfaces cover it with their own
 * plate, and this module is the one place that decides what the plate says.
 *
 * Shared by the canvas `WebNode` and the `BrowserSurface` (browser node + kanban card modal), so
 * one failure cannot be described two ways depending on which view the user is looking at.
 */

/** `ERR_ABORTED`: a navigation something replaced or canceled, which is not a failure to report. */
export const ERR_ABORTED = -3

/** A main-frame load failure, ready to render. */
export interface WebviewLoadFailure {
  /** Chromium's net error code (negative; see `net_error_list.h`). */
  code: number
  /** Chromium's own symbol for it, e.g. `ERR_CONNECTION_REFUSED`. Shown so a bug report can carry it. */
  raw: string
  /** The URL the navigation was aiming at; empty when the event carried none. */
  url: string
  /** One sentence naming what went wrong. */
  message: string
  /** A second line naming what to check, or empty when there is nothing useful to add. */
  hint: string
  /** Whether re-running this exact navigation could plausibly succeed. */
  retryable: boolean
}

interface Explanation {
  message: string
  hint?: string
  /** Omitted means true: most failures are worth another attempt. */
  retryable?: boolean
}

/**
 * The codes a user of this app actually meets. Anything outside the table degrades to the generic
 * sentence plus Chromium's own symbol, which is honest: a wrong explanation is worse than none.
 */
const BY_CODE: Record<number, Explanation> = {
  [-2]: { message: 'The page could not be loaded.' },
  [-6]: { message: 'That file is not there.', hint: 'It may have been moved or deleted.' },
  [-7]: { message: 'The server took too long to answer.', hint: 'It may be overloaded, or a firewall may be dropping the connection.' },
  [-20]: { message: 'Something on this machine blocked the request.', hint: 'A content blocker, an extension or a proxy.' },
  [-21]: { message: 'The network changed while the page was loading.' },
  [-100]: { message: 'The server closed the connection.' },
  [-101]: { message: 'The server reset the connection.' },
  [-102]: { message: 'Nothing is listening at that address.', hint: 'If this is a dev server, it may not be running yet.' },
  [-104]: { message: 'The connection could not be made.' },
  [-105]: { message: 'That host name could not be resolved.', hint: 'Check the spelling, and whether this machine is online.' },
  [-106]: { message: 'This machine is offline.' },
  [-109]: { message: 'That address could not be reached.' },
  [-118]: { message: 'The connection timed out.', hint: 'The host may be unreachable from this network.' },
  [-137]: { message: 'That host name could not be resolved.', hint: 'Check the spelling, and whether this machine is online.' },
  [-200]: { message: 'The certificate does not match this address.' },
  [-201]: { message: 'The certificate has expired, or is not valid yet.' },
  [-202]: { message: 'The certificate is not from a trusted authority.', hint: 'Usual for a self-signed certificate on a local server.' },
  [-300]: { message: 'That is not a valid address.', retryable: false },
  [-301]: { message: 'That address uses a scheme this view does not open.', retryable: false },
  [-302]: { message: 'That address uses a scheme this view does not open.', retryable: false },
  [-310]: { message: 'The server redirected too many times.' },
  [-324]: { message: 'The server answered with nothing.' },
  [-501]: { message: 'The secure connection could not be established.' }
}

/**
 * Whether a `did-fail-load` is worth showing at all.
 *
 * A subframe failure leaves a working page on screen, and covering it with a plate would hide the
 * content the user came for over an ad that did not load. `ERR_ABORTED` is what a navigation the
 * user or the app replaced looks like, and what a download reports.
 */
export function isReportableFailure(isMainFrame: boolean, code: number): boolean {
  return isMainFrame && code !== ERR_ABORTED
}

/**
 * Turn the event's fields into something renderable. `description` is Chromium's own symbol and is
 * carried through even when the code is known, because it is what a search or a bug report needs.
 */
export function describeLoadFailure(code: number, description: string, url: string): WebviewLoadFailure {
  const known = BY_CODE[code]
  return {
    code,
    raw: description.trim() || `Error ${code}`,
    url: url.trim(),
    message: known?.message ?? 'The page could not be loaded.',
    hint: known?.hint ?? '',
    retryable: known?.retryable ?? true
  }
}
