// pi's leg of the raw hook listener — ONE definition both shells call (src/main/index.ts and
// src/server/agent-status.ts), because a rule written twice drifts (agents.md rule 10/11).
//
// pi is the one agent whose hook payload STATES its context usage: nodeterm's own extension
// (core/agents/hooks/pi.ts) forwards `ctx.getContextUsage()` — `{ tokens, contextWindow, percent }`,
// where `percent` is already 0–100 (measured on 0.84.1: 1244 of 272000 tokens reported 0.457) — on
// every event. So the meter needs no transcript tail and no inferred window: the numbers are pi's
// own (agents.md rule 6). What the listener still has to learn from the payload is the session's
// transcript PATH, which the title reader and the context-link / transfer readers resolve through.
//
// The two readers below (`pickPiTitle`, `linesFromPi`) are pure parsers over pi's session JSONL —
// `<agentDir>/sessions/<encoded cwd>/<ISO-timestamp>_<sessionId>.jsonl` (handoff/locate.ts's
// `locatePi` finds the file; these two turn its bytes into a title and a conversation). Measured
// shape (pi 0.84.1, a REAL transcript from a `--name`-flagged `-p` run, pinned verbatim as
// `__fixtures__/pi/session.jsonl`):
//   {"type":"session","version":3,"id":…,"timestamp":…,"cwd":…}
//   {"type":"session_info","id":…,"parentId":…,"timestamp":…,"name":"Fixture title"}
//   {"type":"model_change","id":…,"parentId":…,"timestamp":…,"provider":"openai-codex","modelId":…}
//   {"type":"thinking_level_change","id":…,"parentId":…,"timestamp":…,"thinkingLevel":"off"}
//   {"type":"message","id":…,"parentId":…,"timestamp":…,"message":{"role":"user","content":[{"type":"text","text":…}],…}}
//   {"type":"message",…,"message":{"role":"assistant","content":[{"type":"toolCall","id":…,"name":"bash","arguments":{"command":"ls"}}],…}}
//   {"type":"message",…,"message":{"role":"toolResult","toolCallId":…,"toolName":"bash","content":[{"type":"text","text":"sessions\n"}],"isError":false,…}}
//   {"type":"message",…,"message":{"role":"assistant","content":[{"type":"text","text":"done",…}],…}}
// `arguments` is already a parsed object (unlike codex's stringified JSON) and `content` is always
// an array of `{type:"text",text}` / `{type:"toolCall",…}` parts — never a bare string.
import type { ContextWindowUsage } from '../shared/types'
import { latestJsonLineWhere } from './gemini-session'

const PI_TOOL_ARG_MAX = 200
const PI_TOOL_RESULT_MAX = 500

/** `arguments`/`input`-shaped tool call payload -> the one field worth showing, same field
 *  priority every other renderer in this codebase uses (context-link-render.ts's `toolArg`),
 *  kept as its own copy here because pi's `arguments` arrives as an object, never a JSON string. */
function piToolArg(args: unknown): string {
  const i = args as Record<string, unknown> | undefined
  if (!i || typeof i !== 'object') return ''
  const a = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.description ?? i.prompt
  return typeof a === 'string' ? ` ${a.slice(0, PI_TOOL_ARG_MAX)}` : ''
}

/** pi message content: always an array of `{type:'text',text}` / `{type:'toolCall',…}` parts. */
function piFlatText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  return content
    .map((c) => {
      const part = c as { type?: string; text?: string }
      return part && part.type === 'text' && typeof part.text === 'string' ? part.text : ''
    })
    .filter(Boolean)
    .join('\n')
}

interface PiToolCallPart {
  type?: string
  text?: string
  id?: string
  name?: string
  arguments?: unknown
}

/**
 * The latest session name pi has given the conversation (`/name`, or `--name` at launch) —
 * routed through `core/agent-session-name.ts` (`TITLE_READ_CAPABLE`). Read-only: pi has no
 * transcript field a node title writes back to.
 *
 * `session_info` can appear more than once (a mid-session `/name` writes a fresh one with the
 * same `type`), so the backward scan's "newest line wins" is exactly the rule: the latest record
 * is the name pi currently shows. Null when no line carries one — a session never named, or every
 * line before the tail this was read from.
 */
export function pickPiTitle(text: string | string[]): string | null {
  return latestJsonLineWhere(text, '"session_info"', (o) => {
    if (o.type !== 'session_info') return null
    const name = (o as { name?: unknown }).name
    return typeof name === 'string' && name.trim() ? name.trim() : null
  })
}

/**
 * One pi session record -> 0..n display strings, in the exact shape
 * `linesFromClaude`/`linesFromCodex` produce (`role: text`, `  $ tool arg`, `  = result`) so
 * `context-link-render.ts`'s callers need no per-agent branching on the string shape. Only
 * `{type:'message'}` records render anything — `session`/`session_info`/`model_change`/
 * `thinking_level_change` and any future record type are conversation-free by construction and
 * fall through to nothing, which is also what a torn/unparseable line renders: costing only
 * itself, never the lines around it.
 */
function linesFromPiLine(raw: string): string[] {
  let o: { type?: string; message?: Record<string, unknown> } | undefined
  try {
    o = JSON.parse(raw)
  } catch {
    return []
  }
  if (!o || typeof o !== 'object' || o.type !== 'message' || !o.message) return []
  const m = o.message as { role?: string; content?: unknown; toolName?: string }
  const res: string[] = []
  if (m.role === 'user') {
    const t = piFlatText(m.content)
    if (t) res.push(`user: ${t}`)
  } else if (m.role === 'assistant') {
    const content = Array.isArray(m.content) ? (m.content as PiToolCallPart[]) : []
    for (const c of content) {
      if (c.type === 'text' && typeof c.text === 'string' && c.text) res.push(`assistant: ${c.text}`)
      else if (c.type === 'toolCall') res.push(`  $ ${c.name || 'tool'}${piToolArg(c.arguments)}`)
    }
  } else if (m.role === 'toolResult') {
    const s = piFlatText(m.content).split('\n').slice(0, 3).join(' ').slice(0, PI_TOOL_RESULT_MAX)
    if (s) res.push(`  = ${s}`)
  }
  return res
}

/** A whole pi session JSONL -> display strings, one call per line so a torn last line (the file
 *  can be read mid-write) costs only that line. Accepts an array of already-split lines too, the
 *  same convenience `latestJsonLineWhere` offers. */
export function linesFromPi(text: string | string[]): string[] {
  const lines = Array.isArray(text) ? text : text.split('\n')
  const res: string[] = []
  for (const raw of lines) {
    const t = raw.trim()
    if (t) res.push(...linesFromPiLine(t))
  }
  return res
}

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
