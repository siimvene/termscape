/**
 * The renderer half of the canvas-control `settings` verb: apply a change the user CONFIRMED.
 *
 * The one rule that lives here: a CLI change must land as exactly the state the Settings UI
 * produces, through exactly the setter the UI uses — never a hand-rolled write beside it. For a
 * project capability that is `setProjectCapability` (AgentsSection's switch): on writes the file's
 * literal `true` AND this machine's `'kept'` answer, off records `'declined'`. A bare flag write
 * here would leave the capability pending behind a clone notice about the user's own click, and a
 * write that skipped the ack would be a grant path that bypasses `projectCapabilityGrantedFor`'s
 * second half. `settingsVerb.test.ts` compares the two resulting projects field for field.
 *
 * Planning (allowlist, old → new, dialog wording) is the pure @shared/settings-verb; the dispatch
 * in Canvas.tsx raises the dialog and calls this from its confirm leg only.
 */
import type { SettingsChange } from '@shared/settings-verb'
import type { ProjectCapability } from '@shared/project-capabilities'
import type { Settings } from '@shared/types'
import { useProjects } from '../state/projects'
import { useSettings } from '../state/settings'

export interface SettingsChangeWriters {
  setProjectCapability(id: string, cap: ProjectCapability, on: boolean): void
  updateSettings(patch: Partial<Settings>): void
}

/** The production writers: the SAME store functions the Settings UI calls. */
export function liveSettingsWriters(): SettingsChangeWriters {
  return {
    setProjectCapability: (id, cap, on) => useProjects.getState().setProjectCapability(id, cap, on),
    updateSettings: (patch) => useSettings.getState().update(patch)
  }
}

export function applySettingsChange(
  change: SettingsChange,
  writers: SettingsChangeWriters = liveSettingsWriters()
): void {
  if (change.scope === 'project') {
    writers.setProjectCapability(change.projectId, change.capability, change.on)
    return
  }
  writers.updateSettings(change.patch)
}
