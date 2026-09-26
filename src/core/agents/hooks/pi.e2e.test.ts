import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installPiExtensionInto } from './pi'
import { normalizePi } from '../../../shared/agents/normalize'

// The REAL pi binary, loading nodeterm's extension the way a canvas node will: auto-discovered from
// `$PI_CODING_AGENT_DIR/extensions/` (never passed with -e), inside a pty, in the interactive TUI,
// quit with a typed `/quit`. `--offline` and a fresh agent dir mean no credentials and no model call,
// so this runs anywhere pi is installed. Skipped when it is not (CI has no pi) and on Windows (the
// pty here is `script`).
const piOnPath = process.platform !== 'win32' && spawnSync('sh', ['-c', 'command -v pi'], { encoding: 'utf8' }).status === 0
const scriptOnPath = spawnSync('sh', ['-c', 'command -v script'], { encoding: 'utf8' }).status === 0

interface Capture { server: Server; port: number; posts: Array<{ nodeId: string | null; payload: Record<string, unknown> }> }
async function capture(): Promise<Capture> {
  const posts: Capture['posts'] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c))
    req.on('end', () => {
      const params = new URLSearchParams(body)
      if (req.url === '/hook/pi') posts.push({ nodeId: params.get('nodeId'), payload: JSON.parse(params.get('payload') ?? '{}') })
      res.end('ok')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: (server.address() as { port: number }).port, posts }
}

const sq = (a: string): string => `'${a.replace(/'/g, "'\\''")}'`

/** Run an interactive pi under a pty, type `/quit` once the TUI is up, resolve on exit.
 *  `script` must get a real PIPE on stdin: node's `stdio: 'pipe'` is a socketpair on macOS, where
 *  `script` dies with "tcgetattr/ioctl: Operation not supported on socket" before pi starts. So the
 *  typing happens inside an `sh` pipeline, the same shape as a hand-run check. */
function runPiAndQuit(env: NodeJS.ProcessEnv, sessionDir: string): Promise<number | null> {
  const pi = ['pi', '--offline', '--session-dir', sessionDir].map(sq).join(' ')
  const pty = process.platform === 'darwin' ? `script -q /dev/null ${pi}` : `script -qfec ${sq(pi)} /dev/null`
  const child = spawn('sh', ['-c', `( sleep 4; printf '/quit\\r'; sleep 4 ) | ${pty}`], {
    env,
    stdio: ['ignore', 'ignore', 'ignore']
  })
  const kill = setTimeout(() => child.kill('SIGKILL'), 20000)
  return new Promise((resolve) => {
    child.on('exit', (code) => {
      clearTimeout(kill)
      resolve(code)
    })
  })
}

describe.skipIf(!piOnPath || !scriptOnPath)('pi extension inside the real pi binary', () => {
  let tmp: string
  let agentDir: string
  let sessionDir: string
  let cap: Capture
  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-pi-e2e-'))
    agentDir = path.join(tmp, 'agent')
    sessionDir = path.join(tmp, 'sessions')
    fs.mkdirSync(sessionDir, { recursive: true })
    installPiExtensionInto(agentDir)
    cap = await capture()
  })
  afterEach(() => {
    cap.server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const baseEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir, TERM: 'xterm-256color' }
    for (const k of Object.keys(env)) if (k.startsWith('NODETERM_')) delete env[k]
    return env
  }

  it('an auto-discovered extension reports session start and a /quit shutdown, with pi’s own session id', async () => {
    const env = {
      ...baseEnv(),
      NODETERM_NODE_ID: 'node-e2e',
      NODETERM_HOOK_PORT: String(cap.port),
      NODETERM_HOOK_TOKEN: 'tok',
      NODETERM_HOOK_ENDPOINT: ''
    }
    await runPiAndQuit(env, sessionDir)
    const events = cap.posts.map((p) => p.payload.event)
    expect(events).toContain('session_start')
    expect(events).toContain('session_shutdown')
    expect(cap.posts.every((p) => p.nodeId === 'node-e2e')).toBe(true)

    const start = cap.posts.find((p) => p.payload.event === 'session_start')!.payload
    expect(typeof start.sessionId).toBe('string')
    // pi's own session file is named `<timestamp>_<sessionId>.jsonl`, in the directory we gave it.
    expect(String(start.sessionFile)).toContain(sessionDir)
    expect(String(start.sessionFile)).toContain(String(start.sessionId))
    const env2 = (payload: Record<string, unknown>) => ({ nodeId: 'node-e2e', agentId: 'pi', payload })
    expect(normalizePi(env2(start))).toMatchObject({ kind: 'session', sessionPhase: 'start' })
    const end = cap.posts.find((p) => p.payload.event === 'session_shutdown')!.payload
    expect(normalizePi(env2(end))).toMatchObject({ kind: 'session', sessionPhase: 'end', sessionId: start.sessionId })
  }, 30000)

  it('control: the same real run outside a nodeterm session posts nothing', async () => {
    await runPiAndQuit({ ...baseEnv(), NODETERM_HOOK_PORT: String(cap.port), NODETERM_HOOK_TOKEN: 'tok' }, sessionDir)
    // Only the node id is missing — the endpoint is valid — so an empty capture proves the env gate.
    expect(cap.posts).toEqual([])
  }, 30000)
})
