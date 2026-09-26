// pi hook service. pi (`@earendil-works/pi-coding-agent`) has no hook FILE: its seam is the
// EXTENSION API — a JS module whose default export receives `pi` and subscribes with
// `pi.on(event, handler)`. pi auto-discovers user extensions in `<agentDir>/extensions/`
// (MEASURED on 0.84.1, core/package-manager.js: `join(globalBaseDir, "extensions")`), where
// agentDir is `$PI_CODING_AGENT_DIR` or `~/.pi/agent`. So, like opencode's plugin and grok's hook
// file, nodeterm owns ONE whole file there and rewrites it; a user's own file of the same name is
// never touched (marker-gated). pi loads extensions on every run, so the extension is env-gated:
// outside a nodeterm-spawned session (no NODETERM_NODE_ID) it subscribes to nothing.
//
// The events and the context fields were measured with a probe extension on 0.84.1
// (docs/pi-agent.md): every handler's ctx carries `cwd`, `sessionManager.getSessionId()` /
// `getSessionFile()` and `getContextUsage()` → `{ tokens, contextWindow, percent }`, so the
// envelope below is complete without reading pi's transcript — and the meter's numbers are pi's
// OWN, never inferred. The wire contract (endpoint file, per-node token, socket-or-TCP) is the one
// shared plugin client in plugin-hook-client.ts; `normalizePi` reads the payload.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseEndpointEnv } from '../hook-endpoint-parse'
import { buildPluginHookClient } from './plugin-hook-client'
import { writeManagedHookFileAtomic } from './install-helper'

export const PI_EXTENSION_MARKER = '// nodeterm managed pi extension — do not edit (reinstalled at app launch)'
// `.js`, never `.mjs`: pi's auto-discovery (`collectAutoExtensionEntries`, package-manager.js)
// accepts only `*.ts` and `*.js` files. MEASURED on 0.84.1: the same ESM module as `.mjs` in a
// fresh agent dir was never loaded (no event, no error), and as `.js` it loaded and reported
// session_start + session_shutdown. `-e <path>` accepts `.mjs`, which is what made that easy to miss.
export const PI_EXTENSION_FILE = 'nodeterm-status.js'

/** pi's agent dir: `$PI_CODING_AGENT_DIR` when set to an absolute path, else `~/.pi/agent`
 *  (pi's own resolution — config.js `CONFIG_DIR_NAME` `.pi` + `agent`). A managed pi account is
 *  exactly a different value of this variable, which is why the installer takes it as a parameter. */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.PI_CODING_AGENT_DIR
  return v && path.isAbsolute(v) ? v : path.join(os.homedir(), '.pi', 'agent')
}

export function piExtensionPath(agentDir: string = piAgentDir()): string {
  return path.join(agentDir, 'extensions', PI_EXTENSION_FILE)
}

const REMOTE_HOME_MAX = 4096

/** Same shape as `isSafeRemoteCopilotHome` (hooks/copilot.ts) / `isSafeRemoteGrokHome`
 *  (grok-paths.ts): validates a HOST-REPORTED `$PI_CODING_AGENT_DIR` before it is interpolated
 *  into a remote command line. A host-reported string is data, not truth — refuse anything
 *  untrimmed, relative, carrying a backslash, control characters, or over length, and the caller
 *  falls back to `<remoteHome>/.pi/agent`. */
export function isSafeRemotePiHome(value: string | undefined): boolean {
  const v = value?.trim()
  if (!v || v !== value || !v.startsWith('/') || v.includes('\\') || v.length > REMOTE_HOME_MAX) {
    return false
  }
  return !Array.from(v).some((ch) => {
    const code = ch.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

/** The managed extension body. Events forwarded (and why):
 *  - session_start / session_shutdown — session lifecycle (shutdown is AWAITED: `/quit` exits the
 *    process right after it, and a lost end is a node that never learns its CLI is gone);
 *  - agent_start — the turn really started (`input` is not used: it also fires for slash commands
 *    like `/name` that run no agent, which would strand the node on RUNNING);
 *  - tool_execution_start — mid-turn liveness;
 *  - turn_end — carries fresh context usage between tool round-trips (normalizer ignores it);
 *  - agent_settled — pi's single final end-of-turn signal, with the last assistant message's
 *    stopReason (pi's closed StopReason union) and text, AWAITED for the same reason as shutdown;
 *  - session_info_changed — the session name (`/name`), for the node title.
 *  Assistant text is tracked from message_end; nothing else is forwarded, so token streaming never
 *  reaches the hook server. */
export function buildPiExtension(): string {
  return `${PI_EXTENSION_MARKER}
import fs from 'node:fs'
import http from 'node:http'

// The SAME quote-aware endpoint-file parser every TS consumer uses, embedded verbatim (this module
// runs inside pi and cannot import from the app).
const parseEndpointEnv = ${parseEndpointEnv.toString()}

export default function nodetermStatus(pi) {
  const nodeId = process.env.NODETERM_NODE_ID
  if (!nodeId) return
${buildPluginHookClient('/hook/pi')}
  const call = (fn) => { try { return fn() } catch { return undefined } }
  // The model id of the latest assistant message (message_end carries provider + model).
  let lastModel
  const envelope = (ctx, extra) => {
    const sm = call(() => ctx && ctx.sessionManager)
    const usage = call(() => ctx && ctx.getContextUsage && ctx.getContextUsage())
    return {
      sessionId: call(() => sm && sm.getSessionId && sm.getSessionId()),
      sessionFile: call(() => sm && sm.getSessionFile && sm.getSessionFile()),
      cwd: call(() => ctx && ctx.cwd),
      ...(lastModel ? { model: lastModel } : {}),
      ...(usage && typeof usage.contextWindow === 'number'
        ? { context: { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent } }
        : {}),
      ...extra
    }
  }
  let lastStopReason
  let lastText
  const textOf = (message) => {
    const parts = Array.isArray(message && message.content) ? message.content : []
    const text = parts.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\\n').trim()
    return text ? text.slice(0, 500) : undefined
  }
  // Every handler is guarded HERE, once: a status report must never throw into pi's agent loop,
  // whatever shape pi hands us. An awaited handler's rejection is swallowed the same way.
  const on = (name, handler) => {
    try {
      pi.on(name, (ev, ctx) => {
        try {
          const r = handler(ev, ctx)
          return r && typeof r.then === 'function' ? r.then(() => undefined, () => undefined) : undefined
        } catch {
          return undefined
        }
      })
    } catch {}
  }
  on('session_start', (ev, ctx) => post('session_start', envelope(ctx, { reason: ev && ev.reason })))
  on('agent_start', (ev, ctx) => {
    lastStopReason = undefined
    lastText = undefined
    post('agent_start', envelope(ctx))
  })
  on('tool_execution_start', (ev, ctx) => post('tool_execution_start', envelope(ctx, { toolName: ev && ev.toolName })))
  on('message_end', (ev) => {
    const m = ev && ev.message
    if (!m || m.role !== 'assistant') return
    lastStopReason = typeof m.stopReason === 'string' ? m.stopReason : undefined
    lastText = textOf(m) || lastText
    if (typeof m.model === 'string' && m.model) lastModel = m.model
  })
  on('turn_end', (ev, ctx) => post('turn_end', envelope(ctx)))
  on('agent_settled', (ev, ctx) => postAndWait('agent_settled', envelope(ctx, { stopReason: lastStopReason, lastMessage: lastText })))
  on('session_info_changed', (ev, ctx) => post('session_info_changed', envelope(ctx, { name: ev && ev.name })))
  on('session_shutdown', (ev, ctx) => postAndWait('session_shutdown', envelope(ctx)))
}
`
}

/** Plant (or refresh) the managed extension in `agentDir`. A file of the same name WITHOUT our
 *  marker is a user's own and is left alone. Throws only on an unexpected write failure — the
 *  installer registry catches and warns. */
export function installPiExtensionInto(agentDir: string): void {
  const p = piExtensionPath(agentDir)
  try {
    const existing = fs.readFileSync(p, 'utf8')
    if (!existing.startsWith(PI_EXTENSION_MARKER)) return // a user's own file — never touch it
  } catch {
    /* absent — plant it */
  }
  fs.mkdirSync(path.dirname(p), { recursive: true })
  // Atomic: pi reads extensions at startup and on `/reload`, so a session starting mid-write must
  // never load a truncated module.
  writeManagedHookFileAtomic(p, buildPiExtension())
}

export function removePiExtensionFrom(agentDir: string): void {
  const p = piExtensionPath(agentDir)
  try {
    if (fs.readFileSync(p, 'utf8').startsWith(PI_EXTENSION_MARKER)) fs.rmSync(p, { force: true })
  } catch {
    /* absent — nothing to remove */
  }
}

/** The system pi home. Managed pi account dirs are installed by their own lifecycle. */
export function installPiHooks(): void {
  installPiExtensionInto(piAgentDir())
}

export function removePiHooks(): void {
  removePiExtensionFrom(piAgentDir())
}
