import { describe, it, expect } from 'vitest'
import {
  routeControlSource,
  needsLiveCanvas,
  liveOnlyRefusal,
  LIVE_ONLY_VERBS,
  canColdOpen,
  answersOffCanvas,
  answersFromStoredNodes,
  offScreenDisposition,
  offScreenRefusal,
  controlVerbSetsForTests,
  storedNodeListing,
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
  //
  // NOTE the semantics kept in the merge: this `needsLiveCanvas` is the NARROW predicate the
  // dispatch gates on (TRUE only for LIVE_ONLY_VERBS), NOT the shared module's broader
  // "needs some canvas" one. The shared four-set classification (canColdOpen/answersOffCanvas/
  // answersFromStoredNodes/offScreenDisposition) is exercised in the describes below.
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

describe('canColdOpen — an OPEN is answered out of the store, not by moving the user', () => {
  it('is true for the node-opening verbs AND for verify/spawn-team, which also cold-arm nodes', () => {
    expect(canColdOpen('open-terminal')).toBe(true)
    expect(canColdOpen('open-claude')).toBe(true)
    expect(canColdOpen('open-agent')).toBe(true)
    // `verify`/`spawn-team` CREATE session nodes too, and this fork arms them for cold open through
    // the store surface (Canvas.tsx's `ControlSurface` arms every un-armed node it commits). So the
    // help calls them "answered off screen (queued)", not "refused".
    expect(canColdOpen('verify')).toBe(true)
    expect(canColdOpen('spawn-team')).toBe(true)
  })

  it('is false for every verb that acts on nodes which already exist', () => {
    // These reach a pane, a store writer, the board, or the serialized nodes' geometry — none
    // CREATES a session, so none cold-opens. (The layout verbs are answered off screen all the
    // same; they are `stored-node`, not `cold-open` — see the disposition table below.)
    for (const verb of [
      'write',
      'close',
      'group',
      'ungroup',
      'move',
      'arrange',
      'align',
      'link',
      'rename',
      'color',
      'open-worktree',
      'open-browser',
      'browser',
      'show-image',
      'show-video',
      'show-web',
      'board',
      'assign'
    ]) {
      expect(canColdOpen(verb), verb).toBe(false)
    }
  })

  it('answers the four DISPLAY verbs off canvas, and nothing else', () => {
    for (const verb of ['show-image', 'show-video', 'show-web', 'open-browser']) {
      expect(answersOffCanvas(verb), verb).toBe(true)
    }
    for (const verb of [
      'open-terminal',
      'open-claude',
      'open-agent',
      'list',
      'send',
      'reply',
      'sticky',
      'open-project',
      'write',
      'close',
      'group',
      'ungroup',
      'move',
      'arrange',
      'align',
      'link',
      'rename',
      'color',
      'verify',
      'spawn-team',
      'open-worktree',
      'board',
      'assign'
    ]) {
      expect(answersOffCanvas(verb), verb).toBe(false)
    }
  })

  it('keeps `browser` on the travelling path — it NAVIGATES a mounted guest', () => {
    // The one pair worth stating side by side. `open-browser` places a node, which a serialized
    // canvas can hold; `browser` drives an Electron <webview> guest that exists only while its
    // project is on screen. Adding it here would answer "navigated" about a guest that is not
    // there. `browser` is the one display-family verb that is ALSO live-only.
    expect(answersOffCanvas('open-browser')).toBe(true)
    expect(answersOffCanvas('browser')).toBe(false)
    expect(needsLiveCanvas('browser')).toBe(true)
    expect(needsLiveCanvas('open-browser')).toBe(false)
  })

  // (The shared module's broader "these still NEED some canvas" needsLiveCanvas assertions for the
  // display and cold-open verbs were dropped in the merge: the fork's NARROW `needsLiveCanvas` is
  // the one the dispatch gates on — FALSE for a store-answerable open/display verb — so those
  // assertions inverted against it. The off-screen answerability they meant to pin lives in
  // `canColdOpen` (true for the three opens) and `answersOffCanvas` (true for the four display
  // verbs) above, and the dropped shared expectation is recorded in the CONTROL merge notes.)
  it('the three cold-open verbs are also NOT live-only — the store answers them off screen', () => {
    for (const verb of ['open-terminal', 'open-claude', 'open-agent']) {
      expect(canColdOpen(verb), verb).toBe(true)
      expect(needsLiveCanvas(verb), verb).toBe(false)
    }
  })

  it('the three sets are DISJOINT', () => {
    const { storeAnswered, coldOpenable, offCanvas } = controlVerbSetsForTests()
    expect(storeAnswered.filter((v) => coldOpenable.includes(v))).toEqual([])
    expect(storeAnswered.filter((v) => offCanvas.includes(v))).toEqual([])
    expect(coldOpenable.filter((v) => offCanvas.includes(v))).toEqual([])
    // …and none is empty, so the assertions above cannot pass vacuously.
    expect(storeAnswered.length).toBeGreaterThan(0)
    expect(coldOpenable.length).toBeGreaterThan(0)
    expect(offCanvas.length).toBeGreaterThan(0)
  })

  it('does NOT change which project answers — routing is still by source (cecb4dfe stands)', () => {
    // The regression this fix must not cause: cecb4dfe made an agent OUTSIDE the active project
    // answerable at all (before it, the active canvas had never heard of the node and reported
    // "not a control-capable agent"). Cold-opening changes only HOW the owning project is
    // written to, never WHETHER it is found.
    const projects = [P('p-active', [{ id: 'a1' }]), P('p-other', [{ id: 'b1' }])]
    expect(routeControlSource(projects, 'p-active', 'b1')).toEqual({
      kind: 'switch',
      projectId: 'p-other'
    })
  })
})

describe('sourceIsControlCapable', () => {
  it('does not relabel a plain terminal node as Claude', () => {
    expect(sourceIsControlCapable(undefined)).toBe(false)
    expect(sourceIsControlCapable('')).toBe(false)
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

describe('storedNodeListing', () => {
  it('renders serialized nodes in the same shape the live canvas answers `list` with', () => {
    expect(
      storedNodeListing([
        { id: 'term-b-1', kind: 'terminal', title: 'Claude Code' },
        { id: 'sticky-b-2', kind: 'sticky' },
        { id: 'term-b-3' }
      ])
    ).toEqual([
      { id: 'term-b-1', kind: 'terminal', title: 'Claude Code' },
      { id: 'sticky-b-2', kind: 'sticky', title: '' },
      { id: 'term-b-3', kind: 'terminal', title: '' }
    ])
  })
})

describe('the off-screen disposition table (the verbs that used to travel)', () => {
  it('the verbs that act on existing nodes are answered from the store, not by travelling', () => {
    // The field report: the user was typing in another project, a background agent issued a
    // `close`, and the app switched their tab. These reach a pane, a store writer, the board file,
    // or the serialized nodes' geometry (the layout verbs) — none of them needs React Flow — so
    // none of them has any business moving a camera to get there.
    for (const v of [
      'write',
      'close',
      'rename',
      'color',
      'link',
      'board',
      'assign',
      'group',
      'ungroup',
      'move',
      'arrange',
      'align'
    ]) {
      expect(answersFromStoredNodes(v), v).toBe(true)
      expect(offScreenDisposition(v), v).toEqual({ kind: 'stored-node' })
    }
  })

  it('only the four live-only verbs refuse, and each says WHY in its own words', () => {
    // A refusal an agent can act on beats hijacking the human's screen. The reasons are per verb
    // because the caller's next move differs: an `open-worktree` can wait for the human, a `branch`
    // cannot happen at all until that terminal is mounted. This fork refuses exactly the four verbs
    // with NO serialized counterpart; everything else is answered off screen (above).
    const why = (v: string) => {
      const d = offScreenDisposition(v)
      expect(d.kind, v).toBe('refuse')
      return d.kind === 'refuse' ? d.why : ''
    }
    expect(why('branch')).toMatch(/parks the original/)
    expect(why('open-worktree')).toMatch(/worktree store/)
    expect(why('close-worktree')).toMatch(/worktree store/)
    expect(why('browser')).toMatch(/webview/)
    // The layout and panel verbs upstream refused are ANSWERED here, not refused.
    expect(offScreenDisposition('arrange').kind).toBe('stored-node')
    expect(offScreenDisposition('group').kind).toBe('stored-node')
    expect(offScreenDisposition('move').kind).toBe('stored-node')
    expect(offScreenDisposition('verify').kind).toBe('cold-open')
    expect(offScreenDisposition('spawn-team').kind).toBe('cold-open')
  })

  it('an unknown verb refuses — the fail-closed direction', () => {
    // Someone adds a verb to main's table and forgets this file. It must not fall through to
    // anything that could act, and it certainly must not travel.
    expect(offScreenDisposition('teleport-everything')).toEqual({
      kind: 'refuse',
      why: 'it needs the live canvas'
    })
  })

  it('the three answering paths keep their own kinds', () => {
    expect(offScreenDisposition('list')).toEqual({ kind: 'store-answered' })
    expect(offScreenDisposition('send')).toEqual({ kind: 'store-answered' })
    expect(offScreenDisposition('notify')).toEqual({ kind: 'store-answered' })
    expect(offScreenDisposition('open-claude')).toEqual({ kind: 'cold-open' })
    expect(offScreenDisposition('show-web')).toEqual({ kind: 'off-canvas' })
    // `open-browser` PLACES a node (off canvas); `browser` DRIVES one (refuses). The pair is the
    // easiest thing in the table to collapse by accident.
    expect(offScreenDisposition('open-browser')).toEqual({ kind: 'off-canvas' })
    expect(offScreenDisposition('browser').kind).toBe('refuse')
  })

  it('the refusal sentence names the project, the reason and the fact that nothing happened', () => {
    const msg = offScreenRefusal('open-worktree', 'web-app')
    expect(msg.startsWith('open-worktree: project "web-app" is not on screen')).toBe(true)
    expect(msg).toContain('worktree store')
    expect(msg).toContain('Open that project and run this again')
    expect(msg).toContain('nothing was changed')
  })

  it('a verb that is ANSWERED off screen still gets a sane sentence if someone asks for one', () => {
    // `offScreenRefusal` is only called on the refusing branch, but it must not produce nonsense
    // (or throw) if a future caller reaches for it on another verb.
    expect(offScreenRefusal('write', 'web-app')).toContain('write:')
  })

  it('the four sets are disjoint, so the dispatch order cannot silently decide', () => {
    const { storeAnswered, coldOpenable, offCanvas, storedNode } = controlVerbSetsForTests()
    const all = [...storeAnswered, ...coldOpenable, ...offCanvas, ...storedNode]
    expect(new Set(all).size).toBe(all.length)
    // …and NONE of the four store-/cold-/off-canvas-answerable sets is live-only: the fork's NARROW
    // `needsLiveCanvas` is FALSE for every verb the store surface can answer off screen, TRUE only
    // for LIVE_ONLY_VERBS. (The shared module's broader needsLiveCanvas — TRUE for these too — is
    // NOT re-exported here; see the needsLiveCanvas describe above and the CONTROL merge notes.)
    for (const v of all) expect(needsLiveCanvas(v), v).toBe(false)
  })
})
