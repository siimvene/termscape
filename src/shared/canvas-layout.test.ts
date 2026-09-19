import { describe, it, expect } from 'vitest'
import {
  CANVAS_LAYOUTS_CAP,
  CANVAS_LAYOUT_NAME_MAX,
  findLayoutByName,
  pruneLayoutViewports,
  sanitizeLayoutViewports,
  sanitizeLayouts,
  type CanvasLayout,
  type CanvasLayoutNode
} from './canvas-layout'

const layoutNode = (over: Partial<CanvasLayoutNode> = {}): CanvasLayoutNode => ({
  id: 'term-abc', x: 10, y: 20, width: 400, height: 300, ...over
})
const layout = (over: Partial<CanvasLayout> = {}): CanvasLayout => ({
  id: 'lay-1', name: 'Ultrawide', createdAt: 1000, updatedAt: 2000, nodes: [layoutNode()], ...over
})

describe('sanitizeLayouts admits a well-formed list', () => {
  it('keeps every known field and normalizes the optional ones', () => {
    const admitted = sanitizeLayouts([
      layout({
        window: { width: 3440, height: 1440 },
        nodes: [layoutNode({ collapsed: true, parentId: 'grp-1' })]
      })
    ])
    expect(admitted).toEqual([{
      id: 'lay-1', name: 'Ultrawide', createdAt: 1000, updatedAt: 2000,
      window: { width: 3440, height: 1440 },
      nodes: [{ id: 'term-abc', x: 10, y: 20, width: 400, height: 300, collapsed: true, parentId: 'grp-1' }]
    }])
  })

  it('drops unknown fields on the layout and on its nodes', () => {
    const admitted = sanitizeLayouts([
      { ...layout({ nodes: [{ ...layoutNode(), cwd: '/etc' } as never] }), initialCommand: 'rm -rf /' }
    ])
    expect(admitted![0]).not.toHaveProperty('initialCommand')
    expect(admitted![0].nodes[0]).not.toHaveProperty('cwd')
  })

  it('keeps `collapsed` only when it is literally true, `parentId` only when a non-empty string', () => {
    const admitted = sanitizeLayouts([
      layout({ nodes: [layoutNode({ collapsed: 'yes' as never, parentId: '' })] })
    ])
    expect(admitted![0].nodes[0]).toEqual({ id: 'term-abc', x: 10, y: 20, width: 400, height: 300 })
  })
})

describe('sanitizeLayouts drops rather than repairs', () => {
  it('refuses anything that is not an array', () => {
    for (const bad of [undefined, null, 0, 'layouts', {}, { 0: layout() }]) {
      expect(sanitizeLayouts(bad)).toBeUndefined()
    }
  })

  it('drops a layout that is not an object', () => {
    expect(sanitizeLayouts(['x', 42, null, [layout()]])).toBeUndefined()
  })

  it('drops a layout with a non-string id or name', () => {
    expect(sanitizeLayouts([layout({ id: 7 as never })])).toBeUndefined()
    expect(sanitizeLayouts([layout({ id: '' })])).toBeUndefined()
    expect(sanitizeLayouts([layout({ name: 7 as never })])).toBeUndefined()
  })

  it('drops a layout whose timestamps are not finite numbers', () => {
    expect(sanitizeLayouts([layout({ createdAt: NaN })])).toBeUndefined()
    expect(sanitizeLayouts([layout({ updatedAt: Infinity })])).toBeUndefined()
    expect(sanitizeLayouts([layout({ createdAt: '1000' as never })])).toBeUndefined()
  })

  it('drops a layout whose nodes are not an array', () => {
    expect(sanitizeLayouts([layout({ nodes: {} as never })])).toBeUndefined()
    expect(sanitizeLayouts([layout({ nodes: undefined as never })])).toBeUndefined()
  })

  it('drops the WHOLE layout when any one node entry is malformed', () => {
    // A repaired layout silently no longer describes the arrangement it is named after.
    const withBadNode = (bad: unknown) => sanitizeLayouts([
      layout({ nodes: [layoutNode(), bad as CanvasLayoutNode, layoutNode({ id: 'term-z' })] })
    ])
    expect(withBadNode(null)).toBeUndefined()
    expect(withBadNode('term-b')).toBeUndefined()
    expect(withBadNode(layoutNode({ id: 42 as never }))).toBeUndefined()
    expect(withBadNode(layoutNode({ id: '' }))).toBeUndefined()
  })

  it('drops a layout with a non-finite coordinate or size - the React Flow crash', () => {
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      expect(sanitizeLayouts([layout({ nodes: [layoutNode({ [key]: NaN })] })])).toBeUndefined()
      expect(sanitizeLayouts([layout({ nodes: [layoutNode({ [key]: Infinity })] })])).toBeUndefined()
      expect(sanitizeLayouts([layout({ nodes: [layoutNode({ [key]: null as never })] })])).toBeUndefined()
      expect(sanitizeLayouts([layout({ nodes: [layoutNode({ [key]: '10' as never })] })])).toBeUndefined()
    }
  })

  it('drops a bad layout without taking the good ones with it', () => {
    const admitted = sanitizeLayouts([layout(), layout({ id: 'lay-2', createdAt: NaN }), layout({ id: 'lay-3' })])
    expect(admitted?.map((l) => l.id)).toEqual(['lay-1', 'lay-3'])
  })
})

describe('sanitizeLayouts names and caps', () => {
  it('trims the name and drops a layout whose trimmed name is empty', () => {
    expect(sanitizeLayouts([layout({ name: '  Laptop  ' })])![0].name).toBe('Laptop')
    expect(sanitizeLayouts([layout({ name: '   ' })])).toBeUndefined()
    expect(sanitizeLayouts([layout({ name: '' })])).toBeUndefined()
  })

  it('caps the name at CANVAS_LAYOUT_NAME_MAX', () => {
    const admitted = sanitizeLayouts([layout({ name: 'x'.repeat(CANVAS_LAYOUT_NAME_MAX + 40) })])
    expect(admitted![0].name).toHaveLength(CANVAS_LAYOUT_NAME_MAX)
  })

  it('caps the list at CANVAS_LAYOUTS_CAP, keeping the first N', () => {
    const many = Array.from({ length: CANVAS_LAYOUTS_CAP + 5 }, (_, i) => layout({ id: `lay-${i}` }))
    const admitted = sanitizeLayouts(many)
    expect(admitted).toHaveLength(CANVAS_LAYOUTS_CAP)
    expect(admitted![0].id).toBe('lay-0')
    expect(admitted![CANVAS_LAYOUTS_CAP - 1].id).toBe(`lay-${CANVAS_LAYOUTS_CAP - 1}`)
  })
})

describe('sanitizeLayouts window', () => {
  it('admits it only when both numbers are finite and positive', () => {
    const win = (w: unknown) => sanitizeLayouts([layout({ window: w as never })])![0].window
    expect(win({ width: 1440, height: 900 })).toEqual({ width: 1440, height: 900 })
    expect(win({ width: 0, height: 900 })).toBeUndefined()
    expect(win({ width: -1, height: 900 })).toBeUndefined()
    expect(win({ width: NaN, height: 900 })).toBeUndefined()
    expect(win({ width: 1440 })).toBeUndefined()
    expect(win('3440x1440')).toBeUndefined()
    expect(win(null)).toBeUndefined()
  })

  it('a bad window never takes the layout with it', () => {
    const admitted = sanitizeLayouts([layout({ window: { width: NaN, height: 0 } })])
    expect(admitted).toHaveLength(1)
    expect(admitted![0].nodes).toHaveLength(1)
  })
})

describe('sanitizeLayouts returns undefined, never []', () => {
  it('for an empty list and for a list where nothing survives', () => {
    expect(sanitizeLayouts([])).toBeUndefined()
    expect(sanitizeLayouts([layout({ name: '  ' }), 'junk'])).toBeUndefined()
  })

  it('a layout with no nodes is still a layout (an empty canvas has an arrangement)', () => {
    expect(sanitizeLayouts([layout({ nodes: [] })])![0].nodes).toEqual([])
  })
})

describe('sanitizeLayoutViewports', () => {
  it('keeps well-formed entries and normalizes to exactly x/y/zoom', () => {
    const views = sanitizeLayoutViewports({ 'lay-1': { x: 1, y: 2, zoom: 0.5, extra: 9 } })
    expect(views).toEqual({ 'lay-1': { x: 1, y: 2, zoom: 0.5 } })
  })

  it('drops entries whose key is empty or whose numbers are not finite', () => {
    expect(sanitizeLayoutViewports({ '': { x: 1, y: 2, zoom: 1 } })).toBeUndefined()
    expect(sanitizeLayoutViewports({ 'lay-1': { x: NaN, y: 2, zoom: 1 } })).toBeUndefined()
    expect(sanitizeLayoutViewports({ 'lay-1': { x: 1, y: 2, zoom: Infinity } })).toBeUndefined()
    expect(sanitizeLayoutViewports({ 'lay-1': { x: 1, y: 2 } })).toBeUndefined()
    expect(sanitizeLayoutViewports({ 'lay-1': 'centered' })).toBeUndefined()
  })

  it('drops a bad entry without taking the good ones with it', () => {
    const views = sanitizeLayoutViewports({
      'lay-1': { x: 1, y: 2, zoom: 1 },
      'lay-2': { x: NaN, y: 0, zoom: 1 }
    })
    expect(views).toEqual({ 'lay-1': { x: 1, y: 2, zoom: 1 } })
  })

  it('refuses anything that is not a plain object, and answers undefined when empty', () => {
    for (const bad of [undefined, null, 0, 'views', [], [{ x: 1, y: 2, zoom: 1 }]]) {
      expect(sanitizeLayoutViewports(bad)).toBeUndefined()
    }
    expect(sanitizeLayoutViewports({})).toBeUndefined()
  })
})

describe('pruneLayoutViewports', () => {
  it('drops keys naming no live layout', () => {
    const views = { 'lay-1': { x: 1, y: 2, zoom: 1 }, 'lay-gone': { x: 3, y: 4, zoom: 2 } }
    expect(pruneLayoutViewports(views, [layout({ id: 'lay-1' })])).toEqual({
      'lay-1': { x: 1, y: 2, zoom: 1 }
    })
  })

  it('answers undefined when nothing survives, or when there are no layouts at all', () => {
    const views = { 'lay-gone': { x: 3, y: 4, zoom: 2 } }
    expect(pruneLayoutViewports(views, [layout({ id: 'lay-1' })])).toBeUndefined()
    expect(pruneLayoutViewports(views, undefined)).toBeUndefined()
    expect(pruneLayoutViewports(views, [])).toBeUndefined()
    expect(pruneLayoutViewports(undefined, [layout()])).toBeUndefined()
  })

  it('keeps every entry that still names a live layout', () => {
    const views = { 'lay-1': { x: 1, y: 2, zoom: 1 }, 'lay-2': { x: 3, y: 4, zoom: 2 } }
    expect(pruneLayoutViewports(views, [layout({ id: 'lay-1' }), layout({ id: 'lay-2' })])).toEqual(views)
  })
})

describe('findLayoutByName', () => {
  const layouts = [layout({ id: 'lay-1', name: 'Ultrawide' }), layout({ id: 'lay-2', name: 'Laptop' })]

  it('matches ignoring case and surrounding space', () => {
    expect(findLayoutByName(layouts, '  ULTRAwide ')?.id).toBe('lay-1')
    expect(findLayoutByName(layouts, 'laptop')?.id).toBe('lay-2')
  })

  it('answers undefined for a name nothing carries, an empty needle or no list', () => {
    expect(findLayoutByName(layouts, 'Vertical')).toBeUndefined()
    expect(findLayoutByName(layouts, '   ')).toBeUndefined()
    expect(findLayoutByName(undefined, 'Ultrawide')).toBeUndefined()
  })

  // The ask must normalize exactly the way the save does, or an over-long name matches nothing,
  // passes the ask, and is then stored under the capped name it collides with.
  it('caps the needle the way a save caps the stored name', () => {
    const capped = 'a'.repeat(CANVAS_LAYOUT_NAME_MAX)
    expect(findLayoutByName([layout({ name: capped })], `${capped}bbbb`)?.name).toBe(capped)
  })
})
