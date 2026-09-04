// The Claude usage failure taxonomy, shared by the LOCAL reader (usage-service.ts) and the REMOTE
// one (remote-claude-usage.ts). Its own module because usage-service imports the remote reader:
// the remote reader classifying through usage-service would be a cycle, and a second copy of the
// table would be the drift that let remote rows fall back to "No usage data." while local rows
// already said "Sign-in expired" — the very gap a user spent an evening on.
import type { ClaudeUsage } from '../../shared/types'

/**
 * The failure taxonomy for one non-ok HTTP response, in one place. `status` keeps its four
 * existing meanings (the mirror and the pill's hide rule read it); `cause` is the new detail.
 *
 * 401/403 stay 'unavailable' — a refused credential still means "no subscription windows to
 * show, hide the pill" — but they now carry `unauthorized`, which is what separates an expired
 * login from an account that was never signed in (both were 'unavailable' and nothing else).
 */
export function classifyUsageResponseStatus(httpStatus: number): {
  status: ClaudeUsage['status']
  cause: NonNullable<ClaudeUsage['cause']>
  httpStatus: number
} {
  if (httpStatus === 401 || httpStatus === 403)
    return { status: 'unavailable', cause: 'unauthorized', httpStatus }
  if (httpStatus === 429) return { status: 'error', cause: 'rate-limited', httpStatus }
  if (httpStatus >= 500) return { status: 'error', cause: 'server-error', httpStatus }
  // Every other non-ok code (a 400, a 404 from a moved endpoint, a captive portal's 302 body):
  // real, observed, and not a class we can name — so say only what we saw, the number itself.
  return { status: 'error', cause: 'http', httpStatus }
}

/**
 * The failure taxonomy for a THROWN request. Only our own abort can be attributed to slowness;
 * everything else is 'network', which claims no more than "the request did not complete".
 * `parse` never arrives here — the body read is caught separately, because an ok response with
 * an unreadable body is a different fact from a request that never landed.
 */
export function classifyUsageThrow(err: unknown): NonNullable<ClaudeUsage['cause']> {
  const name = (err as { name?: string } | null)?.name
  return name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : 'network'
}
