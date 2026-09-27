// @vitest-environment jsdom
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { create } from 'zustand'
import { afterEach, expect, it } from 'vitest'
import { useNodesEpoch } from './nodesEpoch'

// The field bug (2026-09-26): a project switch loaded project B, but a zustand store the load
// effect writes (worktrees reset, keep-alive pool, …) re-rendered Canvas at SyncLane BEFORE the
// DefaultLane `setNodes(flowB)` landed. That render mirrored the OLD `nodes` state into `nodesRef`
// while the epoch tag already said B — and the next commit wrote A's nodes into B's
// .nodeterm/project.json. These tests run real React (createRoot, no act batching) because the
// interleaving IS the bug: act() would flush both lanes together and hide it.

const useActive = create<{ id: string | null }>(() => ({ id: 'A' }))
const useOther = create<{ n: number }>(() => ({ n: 0 }))

interface Seen { nodes: string[]; epoch: string | null }
let seen: Seen[] = []
let root: ReturnType<typeof createRoot> | null = null

function Canvas() {
  const active = useActive((s) => s.id)
  useOther((s) => s.n)
  const [nodes, setNodes] = useState<string[]>([])
  const { nodesRef, nodesProjectIdRef, installEpoch } = useNodesEpoch(nodes)
  seen.push({ nodes: nodesRef.current, epoch: nodesProjectIdRef.current })
  useEffect(() => {
    if (!active) {
      installEpoch(null)
      useOther.setState((s) => ({ n: s.n + 1 }))
      return
    }
    const flow = [`${active}-node`]
    setNodes(flow)
    installEpoch(active, flow)
    // Canvas subscribes to stores its load effect writes; each write is a SyncLane re-render.
    useOther.setState((s) => ({ n: s.n + 1 }))
  }, [active, installEpoch])
  return null
}

const settle = () => new Promise((r) => setTimeout(r, 30))
async function until(ok: () => boolean) {
  for (let i = 0; i < 200 && !ok(); i++) await settle()
  expect(ok()).toBe(true)
}

async function mount() {
  useActive.setState({ id: 'A' })
  const el = document.createElement('div')
  root = createRoot(el)
  root.render(<Canvas />)
  await until(() => seen.at(-1)?.epoch === 'A' && seen.at(-1)?.nodes[0] === 'A-node')
  seen = []
}

afterEach(() => {
  root?.unmount()
  root = null
})

/** Every render must pair the nodes it mirrors with the project they belong to. */
function expectPaired() {
  for (const s of seen) {
    if (s.epoch !== null) expect(s.nodes).toEqual([`${s.epoch}-node`])
  }
}

it('never pairs the previous project nodes with the incoming project epoch', async () => {
  await mount()
  useActive.setState({ id: 'B' })
  await until(() => seen.at(-1)?.epoch === 'B')
  await settle()
  expectPaired()
  expect(seen.at(-1)).toEqual({ nodes: ['B-node'], epoch: 'B' })
})

it('keeps the tag cleared after a bail-out (welcome screen) instead of re-mirroring the old project', async () => {
  await mount()
  useActive.setState({ id: null })
  await until(() => seen.length > 1)
  await settle()
  expect(seen.at(-1)?.epoch).toBeNull()
})
