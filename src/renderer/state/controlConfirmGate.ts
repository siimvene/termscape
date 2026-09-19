import {
  decideControlConfirm,
  isWaivableVerb,
  pruneControlConfirmWaivers,
  sanitizeControlConfirmWaivers,
  type ControlConfirmDecision,
  type ControlConfirmWaivers
} from '@shared/control-confirm'
import { resolvePermissionModeWithSource } from '@shared/agents/config'

import { useProjects } from './projects'
import { useSettings } from './settings'
import { sessionWaivedVerbs } from './controlConfirm'

/**
 * Binds the pure `decideControlConfirm` to the live stores — the canvas-control confirm's
 * counterpart to `activePermissionMode`, and in its own module for the same reason that one is:
 * `projects.ts` imports `workspace.ts`, so a store that imports the projects store cannot live
 * anywhere those two can reach.
 *
 * The permission-mode half is where the git-shared-file trap is closed, and BOTH locks are applied
 * here: the machine-local `bypassMode` opt-in comes out of `settings.json`, and
 * `resolvePermissionModeWithSource` reports whether the resolved mode was the user's own GLOBAL
 * choice or an override that arrived in `.nodeterm/project.json` — which travels to everyone who
 * clones the repo. Only `'global'` can waive anything.
 *
 * **The version gate is deliberately NOT applied.** `gatePermissionMode` exists to degrade `auto`
 * to a bare command line for an old Claude CLI; it never touches `bypassPermissions`, and asking
 * it here would tie a security decision to a `claude --version` probe on a canvas whose agent may
 * not even be claude.
 */
export function controlConfirmDecision(
  verb: string,
  /**
   * The project the request ACTS ON. Defaults to the active one, which is what every pre-existing
   * caller means — but canvas control routes by SOURCE, and a background agent's `write`/`close`
   * is now answered in its OWN project without the user's tab moving
   * (@shared/control-off-screen), so the dispatch passes `ctlProject?.id`. Both halves below have
   * to follow it: the per-project waiver obviously, and the permission MODE too, because
   * `project.defaultPermissionMode` is per project and reading the active one would weigh the
   * wrong project's Bypass.
   */
  projectId?: string
): ControlConfirmDecision {
  const { settings } = useSettings.getState()
  const { getProject, activeProjectId } = useProjects.getState()
  const pid = projectId ?? activeProjectId
  const { mode, source } = resolvePermissionModeWithSource(getProject(pid), settings)
  return decideControlConfirm({
    verb,
    sessionWaived: sessionWaivedVerbs(),
    persisted: activeControlConfirmWaivers(),
    projectId: pid,
    permissionMode: mode,
    permissionModeSource: source
  })
}

/**
 * Grant a PERMANENT waiver scoped to one project — the durable half of the dialog's "Don't ask
 * again", and the only persisted waiver a dialog may grant (the machine-wide `always` stays
 * Settings-only; see `ControlConfirmWaivers.always`).
 *
 * It PRUNES on the way in, like every `sidebarCollapsedItems` write: settings.json is forever, and
 * an entry keyed to a project the user deleted is a live security waiver nothing can show them.
 * `live` is every project the store holds, closed ones included — a closed project is parked, not
 * gone.
 *
 * The id being GRANTED survives the prune because the merge below happens after it, not because
 * of any exemption inside it — which matters for a project that went away between the dialog
 * appearing and the user answering it: their answer is still honoured. (`pruneCollapsedItems` has
 * an explicit `keepKey` for this; here the write order already says it, and a second mechanism
 * saying the same thing would be one no test could turn red.)
 *
 * Returns false when nothing was granted (an unwaivable verb, or no project), so a caller cannot
 * report a waiver it did not get.
 */
export function waiveControlConfirmForProject(verb: string, projectId: string | undefined): boolean {
  if (!isWaivableVerb(verb) || !projectId) return false
  const current = activeControlConfirmWaivers()
  const live = new Set(useProjects.getState().projects.map((p) => p.id))
  const pruned = pruneControlConfirmWaivers(current, live)
  const next = {
    ...pruned,
    projects: {
      ...(pruned.projects ?? {}),
      [projectId]: [...new Set([...(pruned.projects?.[projectId] ?? []), verb])]
    }
  }
  // Sanitized on the way OUT as well as in: the write is the file, and every other writer of this
  // key does the same, so a bug here cannot persist a shape the readers would then drop in silence.
  useSettings.getState().update({ controlConfirmWaivers: sanitizeControlConfirmWaivers(next) })
  return true
}

/** The sanitized persisted waivers. `settings.json` is hand-editable, so this is the ONE read. */
export function activeControlConfirmWaivers(): ControlConfirmWaivers {
  return sanitizeControlConfirmWaivers(useSettings.getState().settings.controlConfirmWaivers)
}
