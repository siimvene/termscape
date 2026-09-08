import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for the contract "a canvas-control call never switches the user's view"
 * (2026-09-08) — the same class of test as `control-open-project.source.test.ts`, for the same
 * reason: the handler lives inside a 13,000-line React component's IPC listener with no unit seam,
 * and the property pinned here is a property of the SOURCE (what the handler never calls). The
 * behavioural halves are proven elsewhere: the verb membership in `controlRouting.test.ts`, the
 * store primitives it composes (`commitCanvas`, `armForColdOpen`, `nodeStatesToFlow`) in their own
 * suites.
 *
 * Why it matters: routing is by SOURCE, and before this contract every verb outside a short list
 * TRAVELLED to the source's project first. An agent finishing a task in a background project and
 * tidying up after itself (opening a reviewer, filing its kanban card, closing its stations)
 * yanked the human's view away from whatever they were doing — "sometimes, not always", which is
 * exactly which sessions happened to issue a live-canvas verb.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8')

/** The whole agent-control listener: from its `api.onAgentControl(` registration to the sessions
 *  sidebar section that follows it. */
function controlHandler(): string {
  const start = src.indexOf('api.onAgentControl(')
  const end = src.indexOf('// ---- sessions sidebar actions ----', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

/** The `browser` verb's resolve round-trip listener. */
function browserResolve(): string {
  const start = src.indexOf('api.onBrowserControlResolve(')
  expect(start).toBeGreaterThan(-1)
  const rest = src.slice(start)
  const end = rest.indexOf('}, [])')
  expect(end).toBeGreaterThan(-1)
  return rest.slice(0, end)
}

describe('canvas control never switches the active project (source pins)', () => {
  it('the control handler calls no project-switching action', () => {
    const body = controlHandler()
    for (const forbidden of [
      'travelToProject',
      'switchProject(',
      'reopenProject(',
      'useProjects.getState().setActive(',
      'pendingFocusRef',
      'focusNodeById(',
      'goToNode('
    ]) {
      expect(body, forbidden).not.toContain(forbidden)
    }
  })

  it('a non-active source is answered from a store-backed surface, and only LIVE_ONLY verbs are refused', () => {
    const body = controlHandler()
    expect(body).toContain('const storeSurfaceFor = (projectId: string): ControlSurface')
    // The refusal is gated on the routing module's set — one membership, stated once.
    expect(body).toMatch(/if \(needsLiveCanvas\(verb\)\) \{\s*\n\s*const owner = /)
    expect(body).toContain('surface = storeSurfaceFor(route.projectId)')
    // The only wait left is the active project's own boot hydrate.
    expect(body).toMatch(/if \(route\.kind === 'active'\) \{[\s\S]*?waitForCanvasNode/)
  })

  it('every verb body reads and writes through the surface, never the live refs directly', () => {
    // From the surface selection to the end of the handler: the dispatch may not reach around the
    // surface to React Flow, or a verb would silently act on the ACTIVE canvas for an off-screen
    // source (the pre-2026-09-08 shape, with a travel in front of it).
    const body = controlHandler()
    const from = body.indexOf('let surface: ControlSurface = liveSurface')
    expect(from).toBeGreaterThan(-1)
    const dispatch = body.slice(from)
    for (const direct of ['setNodes((', 'setControlEdges(', 'setLinkEdges(', 'controlEdgesRef.current', 'linkEdgesRef.current']) {
      // `surface.setNodes(` is the sanctioned spelling; a bare `setNodes(` is a reach-around.
      const bare = dispatch.split(direct).length - 1
      const viaSurface = dispatch.split(`surface.${direct}`).length - 1
      expect(bare - viaSurface, direct).toBe(0)
    }
    // `nodesRef.current` may appear only in the active-route hydrate wait, never in a verb.
    const reads = dispatch.split('nodesRef.current').length - 1
    expect(reads, 'nodesRef.current reads after surface selection').toBeLessThanOrEqual(1)
  })

  it('a store-side write persists through `persist`, never a bare `writeDisk`', () => {
    // `writeDisk` clears `dirty` when no edit raced the save; a background save that skipped
    // `commitActiveToStore` wrote the user's ACTIVE canvas stale and cancelled the autosave that
    // would have fixed it (consort CRITICAL, 2026-09-08).
    const body = controlHandler()
    expect(body).toContain('markDirty: () => void persist()')
    const from = body.indexOf('let surface: ControlSurface = liveSurface')
    expect(body.slice(from)).not.toContain('void writeDisk()')
    const del = src.indexOf('const deleteStoredNodes = useCallback(')
    expect(del).toBeGreaterThan(-1)
    const delBody = src.slice(del, src.indexOf('/** `canvas.deleteSelection`', del))
    expect(delBody).toContain('void persist()')
    expect(delBody).not.toContain('void writeDisk()')
  })

  it('the browser resolve round-trip refuses an off-screen source instead of travelling', () => {
    const body = browserResolve()
    expect(body).not.toContain('travelToProject')
    expect(body).toContain("liveOnlyRefusal('browser'")
  })

  it('travelToProjectRef is gone from the component entirely', () => {
    expect(src).not.toContain('travelToProjectRef')
  })
})
