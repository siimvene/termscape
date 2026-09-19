// `/codex-thread/bind` takes a caller-supplied thread id and that id becomes a PATH SEGMENT under
// the record store (and a field inside the record signature). The route used to gate it with its
// own inline `/^[A-Za-z0-9._-]+$/` — a rule that accepts `.` and `..`, which is exactly the hole
// `isSafeNodeId` was written to close for node ids.
//
// The route now shares ONE predicate with the store (`isSafeThreadId`), so an id the store would
// refuse can never reach it through the route, and vice versa. These tests spin the real hook
// server and post real bodies; the handler is a spy, so "refused" means the handler never ran.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hookServer } from './hook-server'
import { nodeAuthToken } from './node-auth-token'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import { codexThreadIdentityRoot, type CodexThreadAgent } from '../codex-identity-proxy'

const SECRET = Buffer.alloc(32, 3)
// Another instance's secret ⇒ another instance's kid ⇒ the `legacy` failover verdict.
const OTHER_SECRET = Buffer.alloc(32, 5)
const NODE = 'node-thread-route'

// The exact trap rows: `.` and `..` are path segments the charset accepts, `../x` and `a/b` carry a
// separator, empty is no segment at all, and 129 chars is over the bound.
const UNSAFE_THREAD_IDS = ['.', '..', '../x', 'a/b', '', 'x'.repeat(129)]

let dir = ''
let bound: { nodeId: string; threadId: string; agent?: CodexThreadAgent }[] = []
let identityEvents: { nodeId: string; mode: string; reason?: string }[] = []

function bind(threadId: string, agentId?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${hookServer.getPort()}/codex-thread/bind`, {
    method: 'POST',
    headers: {
      'X-Nodeterm-Hook-Token': hookServer.getToken(),
      'X-Nodeterm-Node-Token': nodeAuthToken(SECRET, NODE),
      'content-type': 'application/x-www-form-urlencoded'
    },
    body:
      `nodeId=${encodeURIComponent(NODE)}&threadId=${encodeURIComponent(threadId)}` +
      (agentId === undefined ? '' : `&agentId=${encodeURIComponent(agentId)}`)
  })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'codex-thread-route-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  await hookServer.start()
  hookServer.setNodeAuthSecret(SECRET)
  hookServer.setCodexThreadBindHandler(async ({ nodeId, threadId, agent }) => {
    bound.push({ nodeId, threadId, agent })
  })
  hookServer.setCodexIdentityListener((e) => {
    identityEvents.push(e)
  })
})

afterAll(() => {
  hookServer.clearNodeAuthSecretForTests()
  hookServer.stop()
  resetPlatformForTests()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  bound = []
  identityEvents = []
})

describe('/codex-thread/bind refuses a path-unsafe thread id', () => {
  it('400s every trap row, never calls the handler, and writes no record', async () => {
    for (const threadId of UNSAFE_THREAD_IDS) {
      const res = await bind(threadId)
      expect(res.status, JSON.stringify(threadId)).toBe(400)
    }
    expect(bound).toEqual([])
    // Nothing anywhere: not in the store, and — the `..` row — not in the store's parent either.
    // (`sock/` is the hook server's own unix-socket listener dir, issue #367 — always present,
    // never a record.)
    expect(existsSync(codexThreadIdentityRoot())).toBe(false)
    expect(readdirSync(dir).sort()).toEqual(['hook-endpoint.env', 'sock'])
  })

  it('still binds a thread id the app-server would actually mint', async () => {
    const res = await bind('0199b4b7-8d4e-7a4e-9a2f-3c9d0f1a2b3c')
    expect(res.status).toBe(204)
    expect(bound).toEqual([{ nodeId: NODE, threadId: '0199b4b7-8d4e-7a4e-9a2f-3c9d0f1a2b3c' }])
  })
})

/**
 * `/codex-thread/fallback` is the launcher saying "I gave up, I am running plain codex". It grants
 * nothing, and only `forged` is refused there — the same rule /hook/* follows, and the one
 * docs/node-identity.md's per-route table states.
 *
 * The route shipped refusing anything that was not `verified`, which made it the one place in the
 * series that 403s a CROSS-INSTANCE token. Invariant 3: a foreign kid is `legacy` and is never
 * refused anywhere. The refusal also bought nothing — a hostile sibling wanting to flag another
 * node as fallen back just omits the header, which was always accepted.
 */
describe('/codex-thread/fallback refuses only a forged token', () => {
  const fallback = (token?: string): Promise<Response> => {
    const headers: Record<string, string> = {
      'X-Nodeterm-Hook-Token': hookServer.getToken(),
      'content-type': 'application/x-www-form-urlencoded'
    }
    if (token !== undefined) headers['X-Nodeterm-Node-Token'] = token
    return fetch(`http://127.0.0.1:${hookServer.getPort()}/codex-thread/fallback`, {
      method: 'POST',
      headers,
      body: `nodeId=${encodeURIComponent(NODE)}&reason=node-token-unavailable`
    })
  }

  it('accepts a tokenless report — the case it exists for', async () => {
    expect((await fallback()).status).toBe(204)
    expect(identityEvents).toEqual([{ nodeId: NODE, mode: 'plain', reason: 'node-token-unavailable' }])
  })

  it('accepts this instance’s own token', async () => {
    expect((await fallback(nodeAuthToken(SECRET, NODE))).status).toBe(204)
    expect(identityEvents).toHaveLength(1)
  })

  it('accepts ANOTHER instance’s token — a foreign kid is never refused, anywhere', async () => {
    // The regression this test exists for. Two desktops sharing one remote host account is the
    // documented failover; the loser's sessions present a foreign kid on every route, and its
    // fallback reports were the one thing that went dark.
    expect((await fallback(nodeAuthToken(OTHER_SECRET, NODE))).status).toBe(204)
    expect(identityEvents).toEqual([{ nodeId: NODE, mode: 'plain', reason: 'node-token-unavailable' }])
  })

  it('accepts an invented kid too, for the same reason — it is unjudgeable, not hostile', async () => {
    expect((await fallback('AAAAAAAA.BBBBBBBBBBBB')).status).toBe(204)
    expect(identityEvents).toHaveLength(1)
  })

  it('403s OUR kid with a mac minted for another node — the one attack signal', async () => {
    expect((await fallback(nodeAuthToken(SECRET, 'some-other-node'))).status).toBe(403)
    expect(identityEvents).toEqual([])
  })
})

// The route decides the CANVAS-CONTROL GRANT; it never accepts one.
//
// The agent id is echoed by the pane because the pane is the only durable holder of it — a tmux
// session outlives the app, so a bind after a restart is the common case and nothing server-side
// still remembers what agent a node runs. That echo is not a capability claim: reaching this route
// takes a token this instance minted FOR THIS NODE, so the caller IS the node, and the record it
// shapes is re-exported only into that node's own tool shells. What must not be echoed is the
// grant, and it is not: the route runs `canControlCanvas` itself, the same predicate in the same
// process that `buildPtyEnv` used to gate the pane, so there is exactly ONE decider.
describe('/codex-thread/bind derives the grant from the agent id it is given', () => {
  it('grants canvas control for codex, which is unconditionally capable', async () => {
    expect((await bind('thread-ok', 'codex')).status).toBe(204)
    expect(bound[0].agent).toEqual({ agentId: 'codex', canvasControl: true })
  })

  it('WITHHOLDS the grant for a custom agent that inherits nothing', async () => {
    // The narrowing the whole change is for: a claimed id cannot manufacture a grant the capability
    // table refuses. With no base resolver registered, `custom:abc` resolves to itself and is not in
    // CANVAS_CONTROL_CAPABLE — so the record says so, and the prelude will export no grant.
    expect((await bind('thread-custom', 'custom:abc')).status).toBe(204)
    expect(bound[0].agent).toEqual({ agentId: 'custom:abc', canvasControl: false })
  })

  it('writes a PRE-AGENT record when no agent id is sent', async () => {
    // An older launcher, or a pane whose NODETERM_AGENT_ID did not survive. `undefined` here is what
    // makes the record carry no agent line, which reads back with the documented implied values —
    // the behaviour that shipped before this field existed.
    expect((await bind('thread-bare')).status).toBe(204)
    expect(bound[0].agent).toBeUndefined()
  })

  it('treats an agent id outside the alphabet as absent, not as a reason to refuse the bind', async () => {
    // Degrade to nothing, never to something wrong — and never to a dead node: the thread binding is
    // what keeps the session attached to its canvas node, and losing that over a label would be a
    // far worse failure than an unlabelled record.
    expect((await bind('thread-bad-agent', 'bad id')).status).toBe(204)
    expect(bound[0].agent).toBeUndefined()
  })
})
