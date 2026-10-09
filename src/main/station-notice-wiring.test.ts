// The station-failure notice is only as wired as its SHELLS make it, and no type can say so.
//
// The monitor (src/core/agents/station-notice.ts) is fed by `onAgentEvent`, the renderer's DROPPED
// reports arrive over `registerStationNoticeIpc`, and a recipient can only ever be resolved for a
// node whose `openedBy` the open verbs STAMPED. Every one of those is a call that is perfectly
// well-typed to leave out: a shell that forgets to feed the monitor compiles, passes the monitor's
// own suite (which drives it directly), and ships a feature that never fires. That is the class of
// hole `hook-verified-parity` guards, with the same remedy — pin the wiring at source level.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string): string =>
  readFileSync(join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n')

/** The body of `const <name> = (…) => { … }` up to its closing line at the declaration's indent. */
function arrowBody(source: string, decl: string, indent = '  '): string {
  const start = source.indexOf(decl)
  expect(start, `${decl} not found — this guard is looking at the wrong file`).toBeGreaterThan(-1)
  const end = source.indexOf(`\n${indent}}`, start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('both shells feed the station-failure monitor', () => {
  it('desktop: the hook stream reaches it, and its IPC is registered', () => {
    const src = read('main/index.ts')
    expect(arrowBody(src, 'const emitAgentStatus = ')).toContain('stationNotices.onAgentEvent(enriched)')
    expect(src).toContain('registerStationNoticeIpc(corePlatform, () => stationNotices)')
    expect(src).toContain('stationNotices.start()')
    // The recipient comes from MAIN's persisted canvases — never from the renderer.
    expect(src).toContain('stationRecipient(workspaceStore.persistedCanvases(), id)')
    // …and the pane leg is the messaging service with every gate, not a raw write.
    expect(src).toContain('deliverStationNotice(notice, messagingDeps)')
    // The question row's one fact, and the queued notice's final outcome — both optional-looking
    // hookups a shell can drop and still compile.
    expect(src).toContain('pendingQuestionOf: (id) => mirrorEntry(id)?.pendingQuestion?.toolUseId')
    expect(src).toContain(
      'messagingDeps.onQueuedResult = (req, outcome) => stationNotices.onQueuedResult(req, outcome)'
    )
  })

  it('Server Edition: the canvas-control runtime feeds it and asks its creator ledger', () => {
    const cc = read('server/canvas-control.ts')
    expect(arrowBody(cc, 'onAgentEvent: (event) => {', '    ')).toContain(
      'stationNotices.onAgentEvent(event)'
    )
    expect(cc).toContain('factory.openerOf(stationNodeId)')
    expect(cc).toContain('deliverStationNotice(notice, messaging)')
    expect(cc).toContain('pendingQuestionOf: (nodeId) => mirrorEntry(nodeId)?.pendingQuestion?.toolUseId')
    expect(cc).toContain(
      'messaging.onQueuedResult = (req, outcome) => stationNotices.onQueuedResult(req, outcome)'
    )
    const idx = read('server/index.ts')
    expect(idx).toContain('registerStationNoticeIpc(platform, () => canvasControl?.stationNotices ?? null)')
  })
})

describe('every canvas-control open path records the opener beside its rope', () => {
  const canvas = read('renderer/canvas/Canvas.tsx')

  // The fork runs every control verb against ONE `ControlSurface` — the live canvas, or the OWNING
  // project's store when the source is off screen (a control call never switches the view). So
  // upstream's separate off-canvas and cold-open writes do not exist here: every open path places
  // its node through `addAndConnect` → `connect`, on either surface, and that one site stamps.
  it('`connect` (addAndConnect, verify, spawn-team) stamps as it ropes, on either surface', () => {
    const body = arrowBody(canvas, 'const connect = (newId: string) => {', '      ')
    expect(body).toContain('surface.setNodes((ns) => stampOpenedBy(ns, newId, sourceNodeId))')
    expect(body).toContain('surface.addRope(sourceNodeId, newId, edgeColor)')
    // …and the opener rope keeps the `ctrl-<opener>-<node>` id on BOTH surfaces (the notice is
    // honoured only while the field and that rope agree).
    expect(canvas).toContain('setControlEdges((es) => [...es, ropeEdge(id ?? `ctrl-${source}-${target}`, source, target)])')
    expect(canvas).toContain('commit({ ropes: (cur) => [...cur, { id: id ?? `ctrl-${source}-${target}`, source, target }] })')
  })

  it('the off-screen (store surface) open stamps the node it ropes — through the same connect', () => {
    const add = arrowBody(canvas, 'const addAndConnect = (node: CanvasNode) => {', '      ')
    expect(add).toContain('surface.setNodes((ns) => [...ns, placed])')
    expect(add).toContain('connect(placed.id)')
    // No open path writes a roped node into a stored project around the surface (which is how a
    // node would reach the store unstamped): the only own-node store writes inside the dispatch are
    // the `--project` branch (no ropes cross projects) and the store surface's own commit.
    expect(canvas).not.toContain('appendCanvasLinks(')
    expect(canvas.match(/stampOpenedBy\(/g)).toHaveLength(1)
  })

  it('the renderer mirrors the list and reports DROPPED on the app api', () => {
    expect(canvas).toContain('installStationNoticeWiring(window.nodeTerminal)')
  })
})
