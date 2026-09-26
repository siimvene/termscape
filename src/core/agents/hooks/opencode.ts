// opencode hook service. Unlike claude/gemini (JSON settings merge) and codex (hooks.json +
// trust hash), opencode's hook seam is its PLUGIN system: a JS module in
// ~/.config/opencode/plugins/ whose exported hooks fire on session/tool/permission events.
// nodeterm owns one whole plugin file (marker-gated — a user's own file is never touched).
// opencode loads plugins on EVERY CLI command, so the plugin is env-gated: without the
// NODETERM_* env of a nodeterm-spawned session it returns {} and does nothing.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseEndpointEnv } from '../hook-endpoint-parse'
import { buildPluginHookClient } from './plugin-hook-client'

export const PLUGIN_MARKER = '// nodeterm managed plugin — do not edit (reinstalled at app launch)'

/** opencode is XDG-respecting: its config dir is $XDG_CONFIG_HOME/opencode when the env var
 *  is set (Linux/Server Edition users do this), else ~/.config/opencode. */
export function opencodeConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  return xdg && path.isAbsolute(xdg)
    ? path.join(xdg, 'opencode')
    : path.join(os.homedir(), '.config', 'opencode')
}

export function pluginPath(): string {
  return path.join(opencodeConfigDir(), 'plugins', 'nodeterm-status.js')
}

/** The managed plugin body. Mirrors the managed POSIX script's wire contract exactly
 *  (see managed-script.ts + hook-server.ts):
 *  - gate on NODETERM_NODE_ID (absent outside nodeterm-spawned sessions → no-op `{}`);
 *  - per POST, re-read the NODETERM_HOOK_ENDPOINT FILE (KEY=VALUE lines) for the LIVE
 *    port/token — tmux sessions outlive the app, so env-baked coords go stale after a
 *    restart (the restart handoff); fall back to the env vars;
 *  - POST application/x-www-form-urlencoded `nodeId` + `version` + `payload` (JSON) with
 *    the x-nodeterm-hook-token header to http://127.0.0.1:<port>/hook/opencode.
 *  Bus events (session.created/idle/error, message.updated, permission.updated/replied)
 *  reach a plugin ONLY through the `event` catch-all hook as { event: { type, properties } }
 *  — opencode never calls a hook keyed by the event name itself, so per-event-name exports
 *  are dead code (the bug that made every status silently missing). `tool.execute.before`
 *  is the exception: it IS a real named plugin hook. The event NAME posted is the contract
 *  with normalizeOpencode (permission.updated is posted as `permission.asked`);
 *  sessionID/role are extracted defensively per the SDK payload shapes. message.updated
 *  forwards ONLY user messages (turn start) so assistant token streaming never floods the
 *  hook server — and only ONCE per messageID: measured on 1.18.3 (TUI), the user message
 *  record is updated again after session.idle (title/bookkeeping), and re-forwarding that
 *  as a turn start resurrected `working` right after `done` (newTurn bypasses the
 *  done-holdoff by design), pinning the node on RUNNING forever.
 *  Transport: an SSH host advertises a UNIX SOCKET (NODETERM_HOOK_SOCK, no PORT line in the
 *  endpoint file) — the socket wins over TCP, like the POSIX script's `curl --unix-socket`
 *  branch. opencode runs on Bun, whose fetch takes a `unix` option; the node:http
 *  socketPath fallback covers any non-Bun runtime (and is what the tests exercise). */
export function buildOpencodePlugin(): string {
  return `${PLUGIN_MARKER}
import fs from 'node:fs'
import http from 'node:http'

// The SAME quote-aware parser every TS consumer of the endpoint file uses, embedded verbatim
// (this plugin runs standalone under Bun/node — it cannot import from the app). Values are
// posixQuote'd since #351; a quote-blind read would present a token wrapped in literal quotes,
// which the hook server's constant-time bearer check rejects on every POST.
const parseEndpointEnv = ${parseEndpointEnv.toString()}

export const NodetermStatus = async () => {
  const nodeId = process.env.NODETERM_NODE_ID
  if (!nodeId) return {}
${buildPluginHookClient('/hook/opencode')}
  const seenUserMsgs = new Set()
  return {
    event: async (input) => {
      const ev = input && input.event
      if (!ev || !ev.type) return
      const p = ev.properties || {}
      const info = p.info || {}
      switch (ev.type) {
        case 'session.created':
          return post('session.created', { sessionID: info.id || p.sessionID })
        case 'session.idle':
        case 'session.error':
          return post(ev.type, { sessionID: p.sessionID })
        case 'permission.updated':
          return post('permission.asked', { sessionID: p.sessionID })
        case 'permission.replied':
          return post('permission.replied', { sessionID: p.sessionID })
        // The question (elicitation) dialog blocks the turn WITHOUT idling the session —
        // unforwarded, the badge sat on RUNNING while the TUI waited for an answer.
        case 'question.asked':
        case 'question.replied':
        case 'question.rejected':
          return post(ev.type, { sessionID: p.sessionID })
        case 'message.updated': {
          if ((info.role || p.role) !== 'user') return
          if (info.id) {
            if (seenUserMsgs.has(info.id)) return
            seenUserMsgs.add(info.id)
            if (seenUserMsgs.size > 500) {
              for (const first of seenUserMsgs) { seenUserMsgs.delete(first); break }
            }
          }
          return post('message.updated', { sessionID: info.sessionID || p.sessionID, role: 'user' })
        }
      }
    },
    'tool.execute.before': async (input) =>
      post('tool.execute.before', { sessionID: input && input.sessionID })
  }
}
`
}

export function installOpencodeHooks(): void {
  const p = pluginPath()
  try {
    const existing = fs.readFileSync(p, 'utf8')
    if (!existing.startsWith(PLUGIN_MARKER)) return // a user's own file — never touch it
  } catch {
    /* absent — plant it */
  }
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, buildOpencodePlugin(), 'utf8')
}

export function removeOpencodeHooks(): void {
  const p = pluginPath()
  try {
    if (fs.readFileSync(p, 'utf8').startsWith(PLUGIN_MARKER)) fs.rmSync(p, { force: true })
  } catch {
    /* absent — nothing to remove */
  }
}
