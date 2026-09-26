import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PI_EXTENSION_MARKER,
  buildPiExtension,
  installPiExtensionInto,
  isSafeRemotePiHome,
  piAgentDir,
  piExtensionPath,
  removePiExtensionFrom
} from './pi'
import { normalizePi } from '../../../shared/agents/normalize'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-pi-'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('pi agent dir + extension path', () => {
  it('honours an absolute PI_CODING_AGENT_DIR, else ~/.pi/agent', () => {
    expect(piAgentDir({ PI_CODING_AGENT_DIR: '/x/acct' })).toBe('/x/acct')
    expect(piAgentDir({ PI_CODING_AGENT_DIR: 'relative/dir' })).toBe(path.join(os.homedir(), '.pi', 'agent'))
    expect(piAgentDir({})).toBe(path.join(os.homedir(), '.pi', 'agent'))
    // `.js` on purpose: pi's auto-discovery ignores `.mjs` (measured; see PI_EXTENSION_FILE).
    expect(piExtensionPath('/x/acct')).toBe('/x/acct/extensions/nodeterm-status.js')
  })
})

describe('isSafeRemotePiHome', () => {
  it('accepts only absolute, shell-safe remote $PI_CODING_AGENT_DIR values', () => {
    expect(isSafeRemotePiHome('/opt/pi home')).toBe(true)
    for (const value of [
      'relative/path',
      ' /opt/pi',
      '/bad\\path',
      '/bad\npath',
      ''
    ]) {
      expect(isSafeRemotePiHome(value), JSON.stringify(value)).toBe(false)
    }
  })
})

describe('pi extension install', () => {
  it('plants the managed extension, and re-install is idempotent', () => {
    installPiExtensionInto(tmp)
    const p = piExtensionPath(tmp)
    const first = fs.readFileSync(p, 'utf8')
    expect(first.startsWith(PI_EXTENSION_MARKER)).toBe(true)
    installPiExtensionInto(tmp)
    expect(fs.readFileSync(p, 'utf8')).toBe(first)
  })

  it('never touches a user-owned file of the same name, and remove leaves it alone too', () => {
    const p = piExtensionPath(tmp)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '// my own extension\nexport default () => {}\n')
    installPiExtensionInto(tmp)
    expect(fs.readFileSync(p, 'utf8')).toBe('// my own extension\nexport default () => {}\n')
    removePiExtensionFrom(tmp)
    expect(fs.existsSync(p)).toBe(true)
  })

  it('remove deletes only our own file', () => {
    installPiExtensionInto(tmp)
    removePiExtensionFrom(tmp)
    expect(fs.existsSync(piExtensionPath(tmp))).toBe(false)
  })
})

type Handler = (ev: unknown, ctx: unknown) => unknown
async function loadExtension(): Promise<Map<string, Handler>> {
  const file = path.join(tmp, `ext-${Math.random().toString(36).slice(2)}.mjs`)
  fs.writeFileSync(file, buildPiExtension())
  const mod = await import(/* @vite-ignore */ `file://${file}`)
  const handlers = new Map<string, Handler>()
  mod.default({ on: (name: string, h: Handler) => handlers.set(name, h) })
  return handlers
}

const ctx = {
  cwd: '/work/repo',
  sessionManager: {
    getSessionId: () => 'sid-1',
    getSessionFile: () => '/home/u/.pi/agent/sessions/--work-repo--/2026_sid-1.jsonl'
  },
  getContextUsage: () => ({ tokens: 1244, contextWindow: 272000, percent: 0.457 })
}

describe('generated pi extension (executed)', () => {
  it('subscribes to nothing outside a nodeterm session (no NODETERM_NODE_ID)', async () => {
    vi.stubEnv('NODETERM_NODE_ID', '')
    const handlers = await loadExtension()
    expect(handlers.size).toBe(0)
  })

  it('posts the envelope to /hook/pi, and awaits the turn end with pi’s own stopReason + text', async () => {
    const received: Array<{ url: string; token: string; body: string }> = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c))
      req.on('end', () => {
        received.push({ url: req.url ?? '', token: String(req.headers['x-nodeterm-hook-token']), body })
        res.end('ok')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    try {
      vi.stubEnv('NODETERM_NODE_ID', 'node-pi')
      vi.stubEnv('NODETERM_HOOK_PORT', String(port))
      vi.stubEnv('NODETERM_HOOK_TOKEN', 'tok')
      vi.stubEnv('NODETERM_HOOK_SOCK', '')
      vi.stubEnv('NODETERM_HOOK_ENDPOINT', '')
      const h = await loadExtension()
      for (const name of ['session_start', 'agent_start', 'tool_execution_start', 'message_end', 'turn_end',
        'agent_settled', 'session_info_changed', 'session_shutdown']) {
        expect(h.has(name), name).toBe(true)
      }
      h.get('session_start')!({ type: 'session_start', reason: 'startup' }, ctx)
      h.get('agent_start')!({ type: 'agent_start' }, ctx)
      h.get('message_end')!({ message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'DONE' }] } }, ctx)
      // agent_settled returns the awaited POST: by the time it resolves, the server has the event.
      await h.get('agent_settled')!({ type: 'agent_settled' }, ctx)
      await vi.waitFor(() => expect(received.length).toBe(3))

      const payloads = received.map((r) => {
        expect(r.url).toBe('/hook/pi')
        expect(r.token).toBe('tok')
        const params = new URLSearchParams(r.body)
        expect(params.get('nodeId')).toBe('node-pi')
        return JSON.parse(params.get('payload') ?? '{}')
      })
      const byEvent = Object.fromEntries(payloads.map((p) => [p.event, p]))
      expect(byEvent.session_start).toMatchObject({
        sessionId: 'sid-1',
        sessionFile: ctx.sessionManager.getSessionFile(),
        cwd: '/work/repo',
        reason: 'startup',
        context: { tokens: 1244, contextWindow: 272000, percent: 0.457 }
      })
      expect(byEvent.agent_settled).toMatchObject({ stopReason: 'stop', lastMessage: 'DONE' })

      // The payloads round-trip through the normalizer the hook server will run.
      const env = (payload: Record<string, unknown>) => ({ nodeId: 'node-pi', agentId: 'pi', payload })
      expect(normalizePi(env(byEvent.session_start))).toMatchObject({ kind: 'session', sessionPhase: 'start', sessionId: 'sid-1' })
      expect(normalizePi(env(byEvent.agent_start))).toMatchObject({ state: 'working', newTurn: true })
      expect(normalizePi(env(byEvent.agent_settled))).toMatchObject({ state: 'done', lastMessage: 'DONE' })
    } finally {
      server.close()
    }
  })

  it('a handler never throws into pi, even with a hostile ctx', async () => {
    vi.stubEnv('NODETERM_NODE_ID', 'node-pi')
    vi.stubEnv('NODETERM_HOOK_PORT', '')
    vi.stubEnv('NODETERM_HOOK_TOKEN', '')
    const h = await loadExtension()
    const bad = { get sessionManager(): never { throw new Error('boom') }, getContextUsage: () => { throw new Error('boom') } }
    expect(() => h.get('agent_start')!({}, bad)).not.toThrow()
    await expect(h.get('session_shutdown')!({}, bad)).resolves.toBeUndefined()
  })

  it('a handler never throws into pi, even with a hostile EVENT (the on() wrapper itself)', async () => {
    // Every ctx read goes through `call()` inside `envelope`, so the case above cannot tell whether
    // the try/catch in the `on()` wrapper exists. Event payload reads (`ev.message`, `.content`,
    // `.toolName`, `.name`) are NOT wrapped individually — the wrapper is their only guard.
    vi.stubEnv('NODETERM_NODE_ID', 'node-pi')
    vi.stubEnv('NODETERM_HOOK_PORT', '')
    vi.stubEnv('NODETERM_HOOK_TOKEN', '')
    const h = await loadExtension()
    const boom = (): never => {
      throw new Error('boom')
    }
    expect(() => h.get('message_end')!({ get message() { return boom() } }, ctx)).not.toThrow()
    expect(() =>
      h.get('message_end')!({ message: { role: 'assistant', get content() { return boom() } } }, ctx)
    ).not.toThrow()
    expect(() => h.get('tool_execution_start')!({ get toolName() { return boom() } }, ctx)).not.toThrow()
    expect(() => h.get('session_info_changed')!({ get name() { return boom() } }, ctx)).not.toThrow()
    expect(() => h.get('session_start')!({ get reason() { return boom() } }, ctx)).not.toThrow()
  })
})
