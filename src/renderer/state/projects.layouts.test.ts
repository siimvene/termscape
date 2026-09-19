import { describe, it, expect, beforeEach } from 'vitest'
import { CANVAS_LAYOUTS_CAP, CANVAS_LAYOUT_NAME_MAX, type CanvasLayout } from '@shared/canvas-layout'
import { useProjects } from './projects'

const layout = (over: Partial<CanvasLayout> = {}): CanvasLayout => ({
  id: 'lay-1',
  name: 'Ultrawide',
  createdAt: 1000,
  updatedAt: 1000,
  nodes: [{ id: 'term-a', x: 10, y: 20, width: 400, height: 300 }],
  ...over
})

const view = (x: number) => ({ x, y: 0, zoom: 1 })

const seed = (over: Record<string, unknown> = {}) => {
  useProjects.getState().hydrate({
    version: 2,
    activeProjectId: 'p1',
    projects: [{
      id: 'p1', name: 'x', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], ...over
    }]
  })
}

const stored = () => useProjects.getState().getProject('p1')

beforeEach(() => seed())

describe('saveLayout', () => {
  it('writes the shared layout and this machine camera in one go', () => {
    const result = useProjects.getState().saveLayout('p1', layout(), view(5), 4000)
    expect(result).toBe('saved')
    expect(stored()?.layouts).toEqual([{ ...layout(), createdAt: 4000, updatedAt: 4000 }])
    expect(stored()?.layoutViewports).toEqual({ 'lay-1': view(5) })
  })

  it('replaces by id, keeping createdAt and bumping updatedAt', () => {
    useProjects.getState().saveLayout('p1', layout(), view(5), 4000)
    const result = useProjects.getState().saveLayout(
      'p1',
      layout({ createdAt: 9999, nodes: [{ id: 'term-a', x: 99, y: 0, width: 1, height: 1 }] }),
      view(6),
      7000
    )
    expect(result).toBe('saved')
    expect(stored()?.layouts).toHaveLength(1)
    expect(stored()?.layouts?.[0].createdAt).toBe(4000)
    expect(stored()?.layouts?.[0].updatedAt).toBe(7000)
    expect(stored()?.layouts?.[0].nodes[0].x).toBe(99)
    expect(stored()?.layoutViewports).toEqual({ 'lay-1': view(6) })
  })

  it('trims and caps the name', () => {
    const long = 'a'.repeat(CANVAS_LAYOUT_NAME_MAX + 10)
    useProjects.getState().saveLayout('p1', layout({ name: `  ${long}  ` }), view(0), 1)
    expect(stored()?.layouts?.[0].name).toBe('a'.repeat(CANVAS_LAYOUT_NAME_MAX))
  })

  it('refuses a name that is empty once trimmed, without mutating', () => {
    const result = useProjects.getState().saveLayout('p1', layout({ name: '   ' }), view(0), 1)
    expect(result).toBe('invalid-name')
    expect(stored()?.layouts).toBeUndefined()
  })

  it('refuses an unknown project instead of creating a stub', () => {
    const result = useProjects.getState().saveLayout('nope', layout(), view(0), 1)
    expect(result).toBe('unknown-project')
    expect(useProjects.getState().projects).toHaveLength(1)
  })

  // The store is not the only writer of `layouts` - a git pull delivers them too - so the cap can
  // be reached by work this user never did, and a Save must say so rather than evict a teammate's.
  it('refuses a new layout at the cap but still allows a replace', () => {
    const full = Array.from({ length: CANVAS_LAYOUTS_CAP }, (_, i) =>
      layout({ id: `lay-${i}`, name: `L${i}` }))
    seed({ layouts: full })

    const refused = useProjects.getState().saveLayout('p1', layout({ id: 'lay-new' }), view(1), 5000)
    expect(refused).toBe('cap-reached')
    expect(stored()?.layouts).toHaveLength(CANVAS_LAYOUTS_CAP)
    expect(stored()?.layoutViewports).toBeUndefined()

    const replaced = useProjects.getState().saveLayout(
      'p1', layout({ id: 'lay-3', name: 'Renamed' }), view(2), 6000
    )
    expect(replaced).toBe('saved')
    expect(stored()?.layouts).toHaveLength(CANVAS_LAYOUTS_CAP)
    expect(stored()?.layouts?.find((l) => l.id === 'lay-3')?.name).toBe('Renamed')
  })
})

describe('renameLayout', () => {
  beforeEach(() => {
    useProjects.getState().saveLayout('p1', layout(), view(5), 4000)
  })

  it('renames and bumps updatedAt, keeping createdAt', () => {
    useProjects.getState().renameLayout('p1', 'lay-1', '  Laptop  ', 8000)
    expect(stored()?.layouts?.[0].name).toBe('Laptop')
    expect(stored()?.layouts?.[0].createdAt).toBe(4000)
    expect(stored()?.layouts?.[0].updatedAt).toBe(8000)
  })

  it('caps the name at CANVAS_LAYOUT_NAME_MAX', () => {
    useProjects.getState().renameLayout('p1', 'lay-1', 'b'.repeat(CANVAS_LAYOUT_NAME_MAX + 5), 8000)
    expect(stored()?.layouts?.[0].name).toBe('b'.repeat(CANVAS_LAYOUT_NAME_MAX))
  })

  it('refuses an empty name and leaves the layout untouched', () => {
    useProjects.getState().renameLayout('p1', 'lay-1', '   ', 8000)
    expect(stored()?.layouts?.[0].name).toBe('Ultrawide')
    expect(stored()?.layouts?.[0].updatedAt).toBe(4000)
  })

  it('is a no-op for an unknown project or layout id', () => {
    useProjects.getState().renameLayout('nope', 'lay-1', 'Laptop', 8000)
    useProjects.getState().renameLayout('p1', 'lay-gone', 'Laptop', 8000)
    expect(stored()?.layouts?.[0].name).toBe('Ultrawide')
  })
})

describe('deleteLayout', () => {
  it('drops the layout AND its machine-local camera', () => {
    useProjects.getState().saveLayout('p1', layout(), view(5), 4000)
    useProjects.getState().saveLayout('p1', layout({ id: 'lay-2', name: 'Laptop' }), view(6), 4000)

    useProjects.getState().deleteLayout('p1', 'lay-1')
    expect(stored()?.layouts?.map((l) => l.id)).toEqual(['lay-2'])
    expect(stored()?.layoutViewports).toEqual({ 'lay-2': view(6) })

    useProjects.getState().deleteLayout('p1', 'lay-2')
    expect(stored()?.layouts).toBeUndefined()
    expect(stored()?.layoutViewports).toBeUndefined()
  })

  it('is a no-op for an unknown project or layout id', () => {
    useProjects.getState().saveLayout('p1', layout(), view(5), 4000)
    useProjects.getState().deleteLayout('nope', 'lay-1')
    useProjects.getState().deleteLayout('p1', 'lay-gone')
    expect(stored()?.layouts).toHaveLength(1)
    expect(stored()?.layoutViewports).toEqual({ 'lay-1': view(5) })
  })
})

describe('recordLayoutViewport', () => {
  it('writes the machine-local half only, leaving the shared layout byte-identical', () => {
    useProjects.getState().saveLayout('p1', layout(), view(5), 4000)
    const before = stored()?.layouts
    useProjects.getState().recordLayoutViewport('p1', 'lay-1', view(42))
    expect(stored()?.layoutViewports).toEqual({ 'lay-1': view(42) })
    expect(stored()?.layouts).toEqual(before)
  })

  it('refuses a layout id nothing names rather than creating an orphan camera', () => {
    useProjects.getState().recordLayoutViewport('p1', 'lay-gone', view(42))
    useProjects.getState().recordLayoutViewport('nope', 'lay-1', view(42))
    expect(stored()?.layoutViewports).toBeUndefined()
  })
})

// The layout dialog and the palette schedule no canvas save of their own, so without this seam a
// saved layout is lost on restart - the same gap the capability setters close.
describe('layout writes schedule a workspace save', () => {
  it('rings on a save that landed and stays silent on one that was refused', async () => {
    const { registerWorkspaceDirty } = await import('./workspaceDirty')
    let dirtied = 0
    const unregister = registerWorkspaceDirty(() => dirtied++)
    try {
      useProjects.getState().saveLayout('p1', layout(), view(5), 4000)
      expect(dirtied).toBe(1)
      useProjects.getState().saveLayout('p1', layout({ id: 'x', name: ' ' }), view(5), 4000)
      useProjects.getState().renameLayout('p1', 'lay-gone', 'Laptop', 5000)
      useProjects.getState().deleteLayout('p1', 'lay-gone')
      expect(dirtied).toBe(1)
      useProjects.getState().deleteLayout('p1', 'lay-1')
      expect(dirtied).toBe(2)
    } finally {
      unregister()
    }
  })
})
