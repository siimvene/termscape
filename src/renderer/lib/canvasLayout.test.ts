import { describe, it, expect } from 'vitest'
import type { CanvasLayout } from '@shared/canvas-layout'
import { COLLAPSED_HEIGHT, rootPosition, type CanvasNode } from '../state/workspace'
import { applyLayout, captureLayout } from './canvasLayout'

// Minimal node stub: only the fields capture/apply read. Sizes are written to both `width`/`height`
// and `style`, which is the shape `nodeStatesToFlow` produces for a node loaded from disk.
const n = (
  id: string,
  x: number,
  y: number,
  w = 100,
  h = 50,
  extra: Partial<CanvasNode> = {}
): CanvasNode =>
  ({
    id,
    type: 'terminal',
    position: { x, y },
    width: w,
    height: h,
    style: { width: w, height: h },
    data: { title: id, color: '#fff', group: null },
    ...extra
  }) as CanvasNode

const group = (
  id: string,
  x: number,
  y: number,
  w = 400,
  h = 300,
  extra: Partial<CanvasNode> = {}
): CanvasNode => n(id, x, y, w, h, { type: 'group', ...extra })

const child = (parentId: string, node: CanvasNode): CanvasNode =>
  ({ ...node, parentId, extent: 'parent' }) as CanvasNode

const layoutOf = (nodes: CanvasLayout['nodes']): CanvasLayout => ({
  id: 'l1',
  name: 'Ultrawide',
  createdAt: 1,
  updatedAt: 1,
  nodes
})

const byId = (nodes: CanvasNode[], id: string): CanvasNode => nodes.find((node) => node.id === id)!

describe('captureLayout', () => {
  it('records every node in ROOT space, with its size and collapse state', () => {
    const nodes = [
      group('g1', 100, 100, 400, 300),
      child('g1', n('kid', 20, 30, 120, 60)),
      n('solo', 700, 800, 200, 90)
    ]
    const layout = captureLayout(nodes, { id: 'l1', name: 'Ultrawide', now: 42 })
    expect(layout.createdAt).toBe(42)
    expect(layout.updatedAt).toBe(42)
    expect(layout.nodes).toEqual([
      { id: 'g1', x: 100, y: 100, width: 400, height: 300 },
      { id: 'kid', x: 120, y: 130, width: 120, height: 60, parentId: 'g1' },
      { id: 'solo', x: 700, y: 800, width: 200, height: 90 }
    ])
  })

  it('stores the EXPANDED height of a collapsed node, not the chrome height', () => {
    const collapsed = n('a', 0, 0, 100, COLLAPSED_HEIGHT, {
      data: { title: 'a', color: '#fff', group: null, collapsed: true, expandedHeight: 260 }
    } as Partial<CanvasNode>)
    const layout = captureLayout([collapsed], { id: 'l1', name: 'x', now: 1 })
    expect(layout.nodes).toEqual([
      { id: 'a', x: 0, y: 0, width: 100, height: 260, collapsed: true }
    ])
  })

  it('prefers React Flow measurements over the written size', () => {
    const measured = n('a', 0, 0, 100, 50, { measured: { width: 333, height: 222 } })
    expect(captureLayout([measured], { id: 'l1', name: 'x', now: 1 }).nodes[0]).toMatchObject({
      width: 333,
      height: 222
    })
  })

  it('skips ephemeral kinds, whose ids nothing can ever resolve again', () => {
    const nodes = [n('a', 0, 0), n('sub', 10, 10, 100, 50, { type: 'subagent' }), n('loop', 20, 20, 100, 50, { type: 'loop' })]
    expect(captureLayout(nodes, { id: 'l1', name: 'x', now: 1 }).nodes.map((e) => e.id)).toEqual(['a'])
  })

  it('skips a node whose size cannot be established rather than guessing one', () => {
    const sizeless = { id: 'a', type: 'terminal', position: { x: 0, y: 0 }, data: { title: 'a', color: '#fff', group: null } } as CanvasNode
    expect(captureLayout([sizeless], { id: 'l1', name: 'x', now: 1 }).nodes).toEqual([])
  })

  it('trims and caps the name so the layout survives its own sanitizer', () => {
    const long = captureLayout([], { id: 'l1', name: `  ${'x'.repeat(90)}  `, now: 1 })
    expect(long.name).toHaveLength(60)
    expect(long.name.startsWith('x')).toBe(true)
  })

  it('carries the author window only when one is given', () => {
    expect(captureLayout([], { id: 'l1', name: 'x', now: 1 }).window).toBeUndefined()
    expect(
      captureLayout([], { id: 'l1', name: 'x', now: 1, window: { width: 3440, height: 1440 } }).window
    ).toEqual({ width: 3440, height: 1440 })
  })
})

describe('applyLayout', () => {
  it('rule 1: a node the layout does not know is left exactly where it is', () => {
    const nodes = [n('a', 0, 0), n('newcomer', 500, 600, 120, 70)]
    const out = applyLayout(nodes, layoutOf([{ id: 'a', x: 900, y: 900, width: 100, height: 50 }]))
    expect(byId(out.nodes, 'newcomer')).toBe(nodes[1]) // same object: not moved, not tidied
    expect(out.extra).toBe(1)
  })

  it('rule 1: an ephemeral node is not reported as extra, since nothing could address it', () => {
    const nodes = [n('a', 0, 0), n('sub', 10, 10, 100, 50, { type: 'subagent' })]
    const out = applyLayout(nodes, layoutOf([{ id: 'a', x: 5, y: 5, width: 100, height: 50 }]))
    expect(out.extra).toBe(0)
  })

  it('rule 2: an entry whose node is gone is counted and never recreated', () => {
    const nodes = [n('a', 0, 0)]
    const out = applyLayout(
      nodes,
      layoutOf([
        { id: 'a', x: 10, y: 10, width: 100, height: 50 },
        { id: 'ghost', x: 0, y: 0, width: 100, height: 50 }
      ])
    )
    expect(out.nodes.map((node) => node.id)).toEqual(['a'])
    expect(out).toMatchObject({ moved: 1, missing: 1, extra: 0 })
  })

  it('rule 3: a frame the layout addresses gets its saved rect and is NOT re-fitted', () => {
    const nodes = [group('g1', 0, 0, 400, 300), child('g1', n('kid', 20, 20, 100, 50))]
    const out = applyLayout(
      nodes,
      layoutOf([
        { id: 'g1', x: 10, y: 10, width: 400, height: 300 },
        { id: 'kid', x: 500, y: 500, width: 100, height: 50, parentId: 'g1' }
      ])
    )
    const g1 = byId(out.nodes, 'g1')
    // A re-fit would have shrunk the frame around the child that just moved 500px away.
    expect(g1.position).toEqual({ x: 10, y: 10 })
    expect([g1.width, g1.height]).toEqual([400, 300])
    expect(rootPosition(byId(out.nodes, 'kid'), out.nodes)).toEqual({ x: 500, y: 500 })
  })

  it('rule 3 exception: a frame grows around an out-of-layout child instead of letting it clamp', () => {
    // `newcomer` was created after the layout was saved and sits outside g1's saved rect. Restoring
    // g1 to that rect would put the child outside its own parent extent, and React Flow would clamp
    // it - a node the layout never mentioned, moved, with nothing on screen to explain it.
    const nodes = [
      group('g1', 0, 0, 400, 300),
      child('g1', n('kid', 20, 20, 100, 50)),
      child('g1', n('newcomer', 600, 700, 100, 50))
    ]
    const out = applyLayout(
      nodes,
      layoutOf([
        { id: 'g1', x: 0, y: 0, width: 400, height: 300 },
        { id: 'kid', x: 20, y: 20, width: 100, height: 50, parentId: 'g1' }
      ])
    )
    const g1 = byId(out.nodes, 'g1')
    const frame = { ...rootPosition(g1, out.nodes), width: g1.width as number, height: g1.height as number }
    // The unaddressed node did not move an inch.
    expect(rootPosition(byId(out.nodes, 'newcomer'), out.nodes)).toEqual({ x: 600, y: 700 })
    // And the addressed one still landed on its saved rect.
    expect(rootPosition(byId(out.nodes, 'kid'), out.nodes)).toEqual({ x: 20, y: 20 })
    // The frame grew outward only: the saved rect is the floor, never re-centered or shrunk.
    expect(frame.x).toBeLessThanOrEqual(0)
    expect(frame.y).toBeLessThanOrEqual(0)
    expect(frame.x + frame.width).toBeGreaterThanOrEqual(600 + 100 + 28)
    expect(frame.y + frame.height).toBeGreaterThanOrEqual(700 + 50 + 28)
  })

  it('rule 3 exception: a frame nothing forces open lands on exactly its saved rect', () => {
    const nodes = [group('g1', 90, 90, 400, 300), child('g1', n('kid', 20, 20, 100, 50))]
    const out = applyLayout(
      nodes,
      layoutOf([
        { id: 'g1', x: 5, y: 6, width: 400, height: 300 },
        { id: 'kid', x: 25, y: 26, width: 100, height: 50, parentId: 'g1' }
      ])
    )
    const g1 = byId(out.nodes, 'g1')
    expect(rootPosition(g1, out.nodes)).toEqual({ x: 5, y: 6 })
    expect([g1.width, g1.height]).toEqual([400, 300])
  })

  it('a restore applied twice changes nothing the second time', () => {
    const nodes = [
      group('g_outer', 0, 0, 600, 500),
      child('g_outer', group('g_inner', 50, 50, 300, 200)),
      child('g_inner', n('kid', 20, 20, 100, 50)),
      child('g_inner', n('newcomer', 400, 500, 100, 50)),
      n('solo', 900, 900, 100, 50)
    ]
    const layout = layoutOf([
      { id: 'g_inner', x: 40, y: 40, width: 300, height: 200, parentId: 'g_outer' },
      { id: 'kid', x: 60, y: 60, width: 100, height: 50, parentId: 'g_inner' }
    ])
    const once = applyLayout(nodes, layout)
    const twice = applyLayout(once.nodes, layout)
    expect(twice.nodes).toEqual(once.nodes)
    expect(twice).toMatchObject({ moved: once.moved, missing: once.missing, extra: once.extra })
  })

  it('an out-of-layout child holds its canvas position when its frame moves under it', () => {
    const nodes = [group('g1', 0, 0, 400, 300), child('g1', n('newcomer', 20, 20, 100, 50))]
    const out = applyLayout(
      nodes,
      layoutOf([{ id: 'g1', x: 500, y: 500, width: 400, height: 300 }])
    )
    expect(rootPosition(byId(out.nodes, 'newcomer'), out.nodes)).toEqual({ x: 20, y: 20 })
  })

  it('rule 3: a frame the layout does NOT mention is re-fitted around its moved child', () => {
    const nodes = [group('g1', 0, 0, 400, 300), child('g1', n('kid', 20, 20, 100, 50))]
    const out = applyLayout(
      nodes,
      layoutOf([{ id: 'kid', x: 200, y: 300, width: 100, height: 50 }])
    )
    const g1 = byId(out.nodes, 'g1')
    // groupBox: pad 28 all round, plus a 34px label header above.
    expect(g1.position).toEqual({ x: 172, y: 238 })
    expect([g1.width, g1.height]).toEqual([156, 140])
    // The child keeps the root position the layout asked for, whatever the frame did.
    expect(rootPosition(byId(out.nodes, 'kid'), out.nodes)).toEqual({ x: 200, y: 300 })
  })

  it('rule 4: nested frames resolve against target origins, so the result is order-independent', () => {
    // g_outer > g_inner > kid, with only g_inner and kid in the layout. g_outer must end up
    // hugging the pair, and neither placed node may be measured against a frame the other moved.
    const nodes = [
      group('g_outer', 0, 0, 600, 500),
      child('g_outer', group('g_inner', 50, 50, 300, 200)),
      child('g_inner', n('kid', 20, 20, 100, 50))
    ]
    const layout = layoutOf([
      { id: 'g_inner', x: 400, y: 400, width: 300, height: 200, parentId: 'g_outer' },
      { id: 'kid', x: 460, y: 470, width: 100, height: 50, parentId: 'g_inner' }
    ])
    const out = applyLayout(nodes, layout)
    expect(rootPosition(byId(out.nodes, 'g_inner'), out.nodes)).toEqual({ x: 400, y: 400 })
    expect(rootPosition(byId(out.nodes, 'kid'), out.nodes)).toEqual({ x: 460, y: 470 })
    // kid's parent IS in the layout, so its relative position comes from the two saved rects.
    expect(byId(out.nodes, 'kid').position).toEqual({ x: 60, y: 70 })

    const reversed = applyLayout(nodes, layoutOf([...layout.nodes].reverse()))
    expect(reversed.nodes).toEqual(out.nodes)
  })

  it('rule 4: an out-of-layout frame between two placed nodes does not shift either of them', () => {
    const nodes = [
      group('g_outer', 0, 0, 600, 500),
      child('g_outer', group('g_inner', 50, 50, 300, 200)),
      child('g_inner', n('kid', 20, 20, 100, 50)),
      n('solo', 900, 900, 100, 50)
    ]
    const out = applyLayout(
      nodes,
      layoutOf([
        { id: 'kid', x: 250, y: 260, width: 100, height: 50 },
        { id: 'solo', x: 10, y: 20, width: 100, height: 50 }
      ])
    )
    expect(rootPosition(byId(out.nodes, 'kid'), out.nodes)).toEqual({ x: 250, y: 260 })
    expect(byId(out.nodes, 'solo').position).toEqual({ x: 10, y: 20 })
    // Both un-addressed frames hugged the child again, innermost first.
    const inner = byId(out.nodes, 'g_inner')
    const outer = byId(out.nodes, 'g_outer')
    expect([inner.width, inner.height]).toEqual([156, 140])
    const innerRoot = rootPosition(inner, out.nodes)
    const outerRoot = rootPosition(outer, out.nodes)
    expect(outerRoot.x).toBeLessThanOrEqual(innerRoot.x)
    expect(outerRoot.y).toBeLessThanOrEqual(innerRoot.y)
    expect(outer.width as number).toBeGreaterThanOrEqual(inner.width as number)
  })

  it('rule 5: a collapsed entry restores the chrome height and keeps the expanded one honest', () => {
    const nodes = [n('a', 0, 0, 100, 300, { data: { title: 'a', color: '#fff', group: null, expandedHeight: 300 } } as Partial<CanvasNode>)]
    const out = applyLayout(
      nodes,
      layoutOf([{ id: 'a', x: 0, y: 0, width: 100, height: 260, collapsed: true }])
    )
    const a = byId(out.nodes, 'a')
    expect(a.height).toBe(COLLAPSED_HEIGHT)
    expect(a.style?.height).toBe(COLLAPSED_HEIGHT)
    expect(a.data.collapsed).toBe(true)
    expect(a.data.expandedHeight).toBe(260)
  })

  it('rule 5: an expanded entry un-collapses a currently collapsed node at the stored height', () => {
    const nodes = [
      n('a', 0, 0, 100, COLLAPSED_HEIGHT, {
        data: { title: 'a', color: '#fff', group: null, collapsed: true, expandedHeight: 90 }
      } as Partial<CanvasNode>)
    ]
    const out = applyLayout(nodes, layoutOf([{ id: 'a', x: 0, y: 0, width: 100, height: 400 }]))
    const a = byId(out.nodes, 'a')
    expect(a.data.collapsed).toBe(false)
    expect(a.height).toBe(400)
    expect(a.style?.height).toBe(400)
    expect(a.data.expandedHeight).toBe(400)
  })

  it('rule 6: a maximized node keeps its restore rect', () => {
    const premaxRect = { x: 1, y: 2, width: 3, height: 4 }
    const nodes = [n('a', 0, 0, 100, 50, { data: { title: 'a', color: '#fff', group: null, premaxRect } } as Partial<CanvasNode>)]
    const out = applyLayout(nodes, layoutOf([{ id: 'a', x: 9, y: 9, width: 100, height: 50 }]))
    expect(byId(out.nodes, 'a').data.premaxRect).toEqual(premaxRect)
  })

  it('rule 7: `measured` is cleared on every node the transform touches', () => {
    const nodes = [
      n('a', 0, 0, 100, 50, { measured: { width: 111, height: 222 } }),
      n('b', 0, 0, 100, 50, { measured: { width: 333, height: 444 } })
    ]
    const out = applyLayout(nodes, layoutOf([{ id: 'a', x: 5, y: 5, width: 100, height: 50 }]))
    expect(byId(out.nodes, 'a').measured).toBeUndefined()
    // The untouched node keeps its own measurement; nothing else was rewritten.
    expect(byId(out.nodes, 'b').measured).toEqual({ width: 333, height: 444 })
  })

  it('rule 8: nothing outside geometry is touched, and nothing is reparented', () => {
    const data = {
      title: 'agent',
      color: '#ff0000',
      group: 'g',
      tags: ['x'],
      cwd: '/repo',
      agentId: 'claude',
      accountId: 'acc-1',
      pendingLaunch: { after: ['dep'], command: 'claude' },
      icon: { type: 'emoji', value: '🚀' }
    }
    const nodes = [group('g1', 0, 0, 400, 300), child('g1', n('kid', 20, 20, 100, 50, { data } as Partial<CanvasNode>))]
    const out = applyLayout(
      nodes,
      layoutOf([
        // A recorded parentId naming a different frame must change nothing structural.
        { id: 'kid', x: 40, y: 40, width: 100, height: 50, parentId: 'some-other-frame' }
      ])
    )
    const kid = byId(out.nodes, 'kid')
    expect(kid.parentId).toBe('g1')
    expect(kid.extent).toBe('parent')
    expect(kid.type).toBe('terminal')
    expect(kid.id).toBe('kid')
    for (const [key, value] of Object.entries(data)) {
      expect(kid.data[key as keyof typeof data]).toEqual(value)
    }
  })

  it('round trip: capture then apply changes no geometry', () => {
    const nodes = [
      group('g_outer', 10, 20, 600, 500),
      child('g_outer', group('g_inner', 50, 60, 300, 200)),
      child('g_inner', n('kid', 20, 30, 100, 50)),
      n('solo', 700, 800, 200, 90),
      n('folded', 900, 100, 150, COLLAPSED_HEIGHT, {
        data: { title: 'folded', color: '#fff', group: null, collapsed: true, expandedHeight: 310 }
      } as Partial<CanvasNode>)
    ]
    const out = applyLayout(nodes, captureLayout(nodes, { id: 'l1', name: 'same', now: 1 }))
    for (const before of nodes) {
      const after = byId(out.nodes, before.id)
      expect(after.position).toEqual(before.position)
      expect(after.width).toBe(before.width)
      expect(after.height).toBe(before.height)
      expect(after.data.collapsed ?? false).toBe(before.data.collapsed ?? false)
    }
    expect(out).toMatchObject({ moved: 5, missing: 0, extra: 0 })
  })

  it('counts moved / missing / extra exactly, so the toast cannot drift from what happened', () => {
    const nodes = [n('a', 0, 0), n('b', 0, 0), n('newcomer', 0, 0)]
    const out = applyLayout(
      nodes,
      layoutOf([
        { id: 'a', x: 1, y: 1, width: 100, height: 50 },
        { id: 'b', x: 2, y: 2, width: 100, height: 50 },
        { id: 'gone', x: 3, y: 3, width: 100, height: 50 }
      ])
    )
    expect(out).toMatchObject({ moved: 2, missing: 1, extra: 1 })
  })

  it('counts a duplicated entry id once, so the report describes nodes and not file lines', () => {
    const nodes = [n('a', 0, 0)]
    const out = applyLayout(
      nodes,
      layoutOf([
        { id: 'a', x: 1, y: 1, width: 100, height: 50 },
        { id: 'a', x: 900, y: 900, width: 100, height: 50 }
      ])
    )
    expect(out).toMatchObject({ moved: 1, missing: 0, extra: 0 })
    expect(byId(out.nodes, 'a').position).toEqual({ x: 1, y: 1 })
  })

  it('a layout addressing nothing live hands back the SAME array, so no save is triggered', () => {
    const nodes = [n('a', 0, 0)]
    const out = applyLayout(nodes, layoutOf([{ id: 'ghost', x: 0, y: 0, width: 100, height: 50 }]))
    expect(out.nodes).toBe(nodes)
    expect(out).toMatchObject({ moved: 0, missing: 1, extra: 1 })
  })
})
