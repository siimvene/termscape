import type { PendingLaunch } from './types'

/**
 * `pendingLaunch` as it arrives from OUTSIDE this process — `.nodeterm/project.json` (git-shared,
 * therefore hostile input, like triggers and exec fields) or a canvas-sync peer. Rebuilt
 * known-fields-only; anything malformed becomes `undefined` (an inert node, never a crash in the
 * fire effect over `p.after.every`). Shape only: whether such a launch may AUTO-FIRE is decided
 * elsewhere (`renderer/lib/pendingLaunch.ts`, `wasArmedThisSession`) — a loaded launch never does.
 */
const isDepId = (d: unknown): boolean => typeof d === 'string' && d.length > 0 && d.length <= 200

export function sanitizePendingLaunch(v: unknown): PendingLaunch | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  if (typeof o.command !== 'string' || o.command.trim() === '') return undefined
  if (!Array.isArray(o.after) || !o.after.every(isDepId)) {
    return undefined
  }
  const out: PendingLaunch = { after: [...(o.after as string[])], command: o.command }
  if (typeof o.awaitSetupGroup === 'string' && o.awaitSetupGroup.length > 0) out.awaitSetupGroup = o.awaitSetupGroup
  // Upstream's delivery-state fields (v0.3.16: 783d166d, ef0f872b), carried in their exact declared
  // shapes. Dropping them is not the safe default: `attempted:false` is the proof a retained command
  // was never typed, and `manualOnly` / `executor:'server'` are what stop an uncertain or
  // server-owned launch from being replayed by this renderer.
  if (typeof o.attempted === 'boolean') out.attempted = o.attempted
  if (o.manualOnly === true) out.manualOnly = true
  if (o.executor === 'server') out.executor = 'server'
  if (Array.isArray(o.awaitWorking) && o.awaitWorking.every(isDepId)) out.awaitWorking = [...(o.awaitWorking as string[])]
  return out
}
