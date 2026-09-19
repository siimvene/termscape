import { describe, it, expect, beforeEach } from 'vitest'
import { useProjects } from './projects'
import type { BridgeLink } from '@shared/types'

const link = (source: string, target: string, prefix = 'bridge'): BridgeLink => ({
  id: `${prefix}-${source}-${target}`,
  source,
  target
})

beforeEach(() => {
  useProjects.getState().hydrate({ version: 2, activeProjectId: '', projects: [] })
})

/**
 * `appendCanvasLinks` is the EDGE counterpart of `applyNodeMutation`, and it exists for the same
 * reason: React Flow holds only the active project's edges, so a cold open (canvas control's
 * `open-*` answered out of a non-active project's serialized nodes) has nowhere else to put the
 * opener's rope and the fan-in bridge it owes. Without it a spawned team would be a write-only
 * fan-out — the thing the `link` work exists to have ended.
 */
describe('appendCanvasLinks', () => {
  it('appends bridges and ropes to a project that is not active', () => {
    const p = useProjects.getState().addProject('p')
    useProjects.getState().appendCanvasLinks(p.id, {
      bridges: [link('a', 'b')],
      ropes: [link('a', 'b', 'ctrl')]
    })
    const got = useProjects.getState().getProject(p.id)
    expect(got?.bridges).toEqual([link('a', 'b')])
    expect(got?.ropes).toEqual([link('a', 'b', 'ctrl')])
  })

  it('keeps what is already there', () => {
    const p = useProjects.getState().addProject('p')
    useProjects
      .getState()
      .commitCanvas(p.id, [], { x: 0, y: 0, zoom: 1 }, [link('x', 'y')], [link('x', 'y', 'ctrl')])
    useProjects.getState().appendCanvasLinks(p.id, { bridges: [link('a', 'b')] })
    const got = useProjects.getState().getProject(p.id)
    expect(got?.bridges?.map((e) => e.id)).toEqual(['bridge-x-y', 'bridge-a-b'])
    expect(got?.ropes?.map((e) => e.id)).toEqual(['ctrl-x-y'])
  })

  it('dedupes by ENDPOINT PAIR, in either direction — one relationship, one edge', () => {
    // `planBridges` mints `bridge-<source>-<target>` and a rope is `ctrl-<source>-<target>`, so id
    // equality alone would let a repeated open stack duplicate arrows between the same two nodes.
    const p = useProjects.getState().addProject('p')
    useProjects.getState().appendCanvasLinks(p.id, { bridges: [link('a', 'b')] })
    useProjects.getState().appendCanvasLinks(p.id, { bridges: [link('b', 'a', 'other')] })
    expect(useProjects.getState().getProject(p.id)?.bridges).toEqual([link('a', 'b')])
  })

  it('dedupes WITHIN one call too', () => {
    const p = useProjects.getState().addProject('p')
    useProjects
      .getState()
      .appendCanvasLinks(p.id, { bridges: [link('a', 'b'), link('a', 'b'), link('a', 'c')] })
    expect(useProjects.getState().getProject(p.id)?.bridges?.map((e) => e.id)).toEqual([
      'bridge-a-b',
      'bridge-a-c'
    ])
  })

  it('keeps ropes and bridges in SEPARATE arrays — a rope and the bridge it covers coexist', () => {
    // `hiddenLinkIds` hides the bridge under the rope at render time; they are two facts (lineage
    // vs readable context) and collapsing them here would lose the link when the rope is deleted.
    const p = useProjects.getState().addProject('p')
    useProjects.getState().appendCanvasLinks(p.id, {
      bridges: [link('a', 'b')],
      ropes: [link('a', 'b', 'ctrl')]
    })
    expect(useProjects.getState().getProject(p.id)?.bridges).toHaveLength(1)
    expect(useProjects.getState().getProject(p.id)?.ropes).toHaveLength(1)
  })

  it('leaves the field ABSENT when nothing is appended', () => {
    // A project that never had bridges must not gain an empty array — the shared project.json is
    // committed, and an empty key is a diff for everyone on the repo.
    const p = useProjects.getState().addProject('p')
    useProjects.getState().appendCanvasLinks(p.id, { ropes: [link('a', 'b', 'ctrl')] })
    expect(useProjects.getState().getProject(p.id)?.bridges).toBeUndefined()
  })

  it('is a no-op for an unknown project', () => {
    const before = useProjects.getState().projects
    useProjects.getState().appendCanvasLinks('nope', { bridges: [link('a', 'b')] })
    expect(useProjects.getState().projects).toEqual(before)
  })
})
