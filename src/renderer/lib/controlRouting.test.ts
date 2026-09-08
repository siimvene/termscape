import { describe, it, expect } from 'vitest'
import {
  routeControlSource,
  needsLiveCanvas,
  liveOnlyRefusal,
  LIVE_ONLY_VERBS,
  sourceIsControlCapable,
  answerBrowserResolve,
  type ControlProject,
  type BrowserResolveProject
} from './controlRouting'

const P = (
  id: string,
  nodes: { id: string; kind?: string; title?: string; agentId?: string }[],
  extra: Partial<ControlProject> = {}
): ControlProject => ({ id, nodes, ...extra })

describe('routeControlSource', () => {
  const projects = [
    P('p-active', [{ id: 'term-a-1' }]),
    P('p-open', [{ id: 'term-b-1' }, { id: 'term-b-2' }]),
    P('p-closed', [{ id: 'term-c-1' }], { closed: true }),
    P('p-gone', [{ id: 'term-d-1' }], { closed: true, unavailable: true })
  ]

  it('routes a node on the active canvas to the live canvas', () => {
    expect(routeControlSource(projects, 'p-active', 'term-a-1')).toEqual({ kind: 'active' })
  })

  // THE BUG: after an app restart the app comes up on ONE project, but every other project's
  // tmux sessions are re-adopted and keep running. Their agents' control calls used to be
  // answered by the ACTIVE canvas, which has never heard of the source node — so they were
  // rejected as "not a control-capable agent". The owning project must be resolved instead.
  it('routes a node in another OPEN project to its own project (not a rejection)', () => {
    expect(routeControlSource(projects, 'p-active', 'term-b-2')).toEqual({
      kind: 'switch',
      projectId: 'p-open'
    })
  })

  it('routes a node in a CLOSED project to a reopen (its sessions still run)', () => {
    expect(routeControlSource(projects, 'p-active', 'term-c-1')).toEqual({
      kind: 'reopen',
      projectId: 'p-closed'
    })
  })

  it('blocks a project whose files are unreadable', () => {
    expect(routeControlSource(projects, 'p-active', 'term-d-1')).toEqual({
      kind: 'blocked',
      projectId: 'p-gone'
    })
  })

  it('reports an unknown node as unknown, not as a capability failure', () => {
    expect(routeControlSource(projects, 'p-active', 'term-nope-9')).toEqual({ kind: 'unknown' })
  })

  it('treats the active project as live even when the store lags the live canvas', () => {
    // A node just created on the live canvas is not committed to the store yet: the caller only
    // consults the router when the live canvas MISSED it, so an active-project id must not be
    // reported as travel-worthy.
    expect(routeControlSource(projects, 'p-open', 'term-b-1')).toEqual({ kind: 'active' })
  })
})

describe("needsLiveCanvas — a control call never switches the user's view", () => {
  // THE BUG (2026-09-08): routing is by SOURCE, and every verb outside a short store-answered list
  // used to TRAVEL to the source's project first. So an agent finishing a task in a background
  // project and tidying up after itself — opening its review node, filing its kanban card,
  // closing its stations — yanked the human's view away from whatever they were working on. The
  // contract is now inverted: everything is answered from the owning project's serialized store,
  // and only the verbs with NO store representation are refused (never travelled to).
  it('is false for every node-creating, node-editing and node-reading verb', () => {
    for (const verb of [
      'list',
      'open-terminal',
      'open-claude',
      'open-agent',
      'spawn-team',
      'verify',
      'show-image',
      'show-video',
      'show-web',
      'open-browser',
      'group',
      'ungroup',
      'move',
      'arrange',
      'align',
      'link',
      'rename',
      'sticky',
      'write',
      'close',
      'board',
      'assign'
    ]) {
      expect(needsLiveCanvas(verb), verb).toBe(false)
    }
  })

  it('is false for send, reply and open-project too — they are dispatched before routing', () => {
    // Routing here is by SOURCE, so what this stops is a trip to the SENDER's project — which an
    // off-canvas orchestrator would otherwise trigger on every message it sent (G5). Never
    // travelling to the TARGET's project is a different guarantee, and it belongs to
    // `resolveDeliveryScope`.
    expect(needsLiveCanvas('send')).toBe(false)
    expect(needsLiveCanvas('reply')).toBe(false)
    expect(needsLiveCanvas('open-project')).toBe(false)
  })

  it('is true ONLY for the verbs with no store representation', () => {
    // open-worktree / close-worktree: the worktree registry and the project-setup runs are bound
    // to the ACTIVE project's checkout. branch: restarts a RUNNING pane through the live node.
    // browser: drives a <webview> guest that exists only while its node is mounted.
    expect([...LIVE_ONLY_VERBS].sort()).toEqual(['branch', 'browser', 'close-worktree', 'open-worktree'])
    for (const verb of LIVE_ONLY_VERBS) expect(needsLiveCanvas(verb), verb).toBe(true)
  })

  it('a live-only verb from a background project gets a named, terminal refusal that says the view will not switch', () => {
    const msg = liveOnlyRefusal('open-worktree', 'kvart')
    expect(msg).toContain('open-worktree')
    expect(msg).toContain('"kvart"')
    expect(msg).toContain('not on screen')
    expect(msg).toContain("never switches on an agent's behalf")
  })
})

describe('sourceIsControlCapable', () => {
  it('defaults a plain terminal node (no agentId) to claude, mirroring the spawn-time env', () => {
    expect(sourceIsControlCapable(undefined)).toBe(true)
    expect(sourceIsControlCapable('')).toBe(true)
  })

  it('accepts every canvas-control-capable agent', () => {
    for (const id of ['claude', 'codex', 'gemini', 'opencode', 'grok']) {
      expect(sourceIsControlCapable(id)).toBe(true)
    }
  })

  it('rejects an agent that never gets NODETERM_CANVAS_CONTROL', () => {
    expect(sourceIsControlCapable('cursor')).toBe(false)
  })
})

describe('the `browser` verb needs the LIVE canvas', () => {
  it('needsLiveCanvas(browser) is true, and open-browser (which only CREATES a node) is store-answerable', () => {
    // `browser` drives a real <webview> that only exists on the live canvas; it is NOT
    // store-answerable. `open-browser` merely places a node, which the store can hold.
    expect(needsLiveCanvas('browser')).toBe(true)
    expect(needsLiveCanvas('open-browser')).toBe(false)
  })
})

describe('answerBrowserResolve — the renderer answers ONLY what it alone knows', () => {
  const proj = (over: Partial<BrowserResolveProject> = {}): BrowserResolveProject => ({
    id: 'proj-1',
    cwd: '/home/u/p',
    nodes: [{ id: 'claude-1', agentId: 'claude' }],
    ...over
  })

  it('a missing project or an off-canvas source is a named, non-CDP refusal', () => {
    expect(answerBrowserResolve(undefined, 'claude-1')).toEqual({
      ok: false,
      refusal: 'source node is not on an open canvas'
    })
    expect(answerBrowserResolve(proj(), 'ghost-9')).toEqual({
      ok: false,
      refusal: 'source node is not on an open canvas'
    })
  })

  it('reports project, cwd, source-capability and the LIVE per-project capability value', () => {
    // Switch on in the file AND kept on this machine ⇒ granted.
    const granted = proj({ agentBrowserControl: true, capabilityAck: { agentBrowserControl: 'kept' } })
    expect(answerBrowserResolve(granted, 'claude-1')).toEqual({
      ok: true,
      projectId: 'proj-1',
      projectCwd: '/home/u/p',
      sourceControlCapable: true,
      capabilityOn: true,
      sourceTitle: '',
      browserTitle: ''
    })
  })

  it('reports the source and browser node titles for the cookie trace (PR 9)', () => {
    const granted = proj({
      agentBrowserControl: true,
      capabilityAck: { agentBrowserControl: 'kept' },
      nodes: [
        { id: 'claude-1', agentId: 'claude', title: 'Research agent' },
        { id: 'browser-3', title: 'GitHub' }
      ]
    })
    expect(answerBrowserResolve(granted, 'claude-1', 'browser-3')).toMatchObject({
      ok: true,
      sourceTitle: 'Research agent',
      browserTitle: 'GitHub'
    })
    // An unknown browser node is an empty string (main falls back to the id), never a throw.
    expect(answerBrowserResolve(granted, 'claude-1', 'browser-nope')).toMatchObject({ browserTitle: '' })
  })

  it('a switch that is ON in the file but only PENDING (never kept) is not on — a pending notice is a refusal', () => {
    const pending = proj({ agentBrowserControl: true })
    expect(answerBrowserResolve(pending, 'claude-1')).toMatchObject({ ok: true, capabilityOn: false })
  })

  it('a DECLINED switch is off even when the file says true (C1: the hostile clone must not grant)', () => {
    const declined = proj({ agentBrowserControl: true, capabilityAck: { agentBrowserControl: 'declined' } })
    expect(answerBrowserResolve(declined, 'claude-1')).toMatchObject({ ok: true, capabilityOn: false })
  })

  it('a non-control-capable source is reported as such (main turns it into the refusal)', () => {
    const p = proj({ nodes: [{ id: 'x-1', agentId: 'cursor' }], agentBrowserControl: true, capabilityAck: { agentBrowserControl: 'kept' } })
    expect(answerBrowserResolve(p, 'x-1')).toMatchObject({ ok: true, sourceControlCapable: false })
  })
})
