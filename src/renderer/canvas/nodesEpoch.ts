import { useCallback, useRef, useState, type MutableRefObject } from 'react'

/**
 * React Flow's live node array and the project it belongs to, mirrored into refs as ONE pair.
 *
 * `nodesProjectIdRef` is the epoch tag `canCommitCanvas` checks before any commit writes the
 * live canvas into a project. It used to be a plain ref written only by the load effect, while
 * `nodesRef` was re-mirrored from `nodes` STATE on every render. The load effect sets both refs
 * synchronously and calls `setNodes(flow)` — a DefaultLane update, because it is issued from a
 * passive effect — and then writes zustand stores Canvas subscribes to (worktrees reset, the
 * keep-alive pool, …). Each such write is a SyncLane re-render, and a SyncLane render SKIPS the
 * pending DefaultLane `setNodes`: it rendered the PREVIOUS project's nodes and mirrored them into
 * `nodesRef` while the tag already named the incoming project. Any commit in that window
 * (a switch/close handler, an autosave) passed the guard and wrote project A's nodes into project
 * B's `.nodeterm/project.json` — field report 2026-09-26: an SSH project's seven nodes replaced a
 * local project's eighteen.
 *
 * The fix is to carry the tag in React STATE beside the nodes. `setNodes(flow)` and the tag
 * update are issued together, so they share a lane: every render sees both or neither, and the
 * render-time mirror can no longer pair one project's nodes with another's id.
 */
export interface NodesEpoch<N> {
  nodesRef: MutableRefObject<N[]>
  nodesProjectIdRef: MutableRefObject<string | null>
  /**
   * Declare that `flow` — already handed to `setNodes` in the SAME tick — is `projectId`'s canvas,
   * or `null` for "no project's canvas is mounted" (a bail-out). Updates the refs synchronously, so
   * a commit before the next render already sees the new pair, and queues the tag state so every
   * later render agrees with it.
   */
  installEpoch: (projectId: string | null, flow?: N[]) => void
}

export function useNodesEpoch<N>(nodes: N[]): NodesEpoch<N> {
  const [nodesProjectId, setNodesProjectId] = useState<string | null>(null)
  const nodesRef = useRef<N[]>(nodes)
  const nodesProjectIdRef = useRef<string | null>(null)
  // Render-time mirror, as before — but of the PAIR. Both values come from the same render.
  nodesRef.current = nodes
  nodesProjectIdRef.current = nodesProjectId
  const installEpoch = useCallback((projectId: string | null, flow?: N[]) => {
    if (flow) nodesRef.current = flow
    nodesProjectIdRef.current = projectId
    setNodesProjectId(projectId)
  }, [])
  return { nodesRef, nodesProjectIdRef, installEpoch }
}
