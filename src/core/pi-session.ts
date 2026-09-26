// pi's leg of the raw hook listener — ONE definition both shells call (src/main/index.ts and
// src/server/agent-status.ts), because a rule written twice drifts (agents.md rule 10/11).
//
// pi is the one agent whose hook payload STATES its context usage: nodeterm's own extension
// (core/agents/hooks/pi.ts) forwards `ctx.getContextUsage()` — `{ tokens, contextWindow, percent }`,
// where `percent` is already 0–100 (measured on 0.84.1: 1244 of 272000 tokens reported 0.457) — on
// every event. So the meter needs no transcript tail and no inferred window: the numbers are pi's
// own (agents.md rule 6). What the listener still has to learn from the payload is the session's
// transcript PATH, which the title reader and the context-link / transfer readers resolve through.
import type { ContextWindowUsage } from '../shared/types'

interface PiContextField {
  tokens?: unknown
  contextWindow?: unknown
  percent?: unknown
}
interface PiRawPayload {
  event?: unknown
  sessionId?: unknown
  sessionFile?: unknown
  model?: unknown
  context?: PiContextField
}

const finiteNonNegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** The meter payload for one pi hook event, or null when the event states no usable usage.
 *  pi reports `percent: null` while it does not know the token count yet; that is NOT a zero. */
export function piContextUsage(payload: Record<string, unknown>, now = Date.now()): ContextWindowUsage | null {
  const p = payload as PiRawPayload
  const sessionId = typeof p.sessionId === 'string' && p.sessionId ? p.sessionId : null
  const c = p.context
  if (!sessionId || !c) return null
  if (!finiteNonNegative(c.tokens) || !finiteNonNegative(c.contextWindow) || c.contextWindow === 0) return null
  if (!finiteNonNegative(c.percent)) return null
  return {
    sessionId,
    usedTokens: c.tokens,
    windowTokens: c.contextWindow,
    usedPercent: Math.min(100, c.percent),
    model: typeof p.model === 'string' && p.model ? p.model : null,
    updatedAt: now
  }
}

export interface PiSessionTracker {
  /** Feed one raw pi hook payload. Pushes a meter update when the stated usage changed, records the
   *  jailed transcript path when `trackPath` allows it, and forgets the session on shutdown.
   *  Returns the payload's session id (for the caller's node↔session association). */
  observe(payload: Record<string, unknown>, opts: { trackPath: boolean }): string | undefined
  /** The transcript path the hooks reported for this session, if any (title / link / transfer). */
  pathFor(sessionId: string): string | undefined
  untrack(sessionId: string): void
}

export function createPiSessionTracker(deps: {
  send: (usage: ContextWindowUsage) => void
  /** The shell's transcript jail: returns the path only when it resolves under an allowed root. */
  safePath: (p: string | undefined) => string | undefined
}): PiSessionTracker {
  const paths = new Map<string, string>()
  const last = new Map<string, string>() // sessionId → "used|window|model", the change gate
  return {
    observe(payload, opts) {
      const p = payload as PiRawPayload
      const sessionId = typeof p.sessionId === 'string' && p.sessionId ? p.sessionId : undefined
      if (!sessionId) return undefined
      if (p.event === 'session_shutdown') {
        paths.delete(sessionId)
        last.delete(sessionId)
        return sessionId
      }
      if (opts.trackPath) {
        const safe = deps.safePath(typeof p.sessionFile === 'string' ? p.sessionFile : undefined)
        if (safe) paths.set(sessionId, safe)
      }
      const usage = piContextUsage(payload)
      if (usage) {
        const key = `${usage.usedTokens}|${usage.windowTokens}|${usage.model ?? ''}`
        if (last.get(sessionId) !== key) {
          last.set(sessionId, key)
          deps.send(usage)
        }
      }
      return sessionId
    },
    pathFor: (sessionId) => paths.get(sessionId),
    untrack(sessionId) {
      paths.delete(sessionId)
      last.delete(sessionId)
    }
  }
}
