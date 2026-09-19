/**
 * The Settings → Agents view of a per-project capability that has a MACHINE DEFAULT
 * (@shared/project-capabilities, CAPABILITY_MACHINE_DEFAULTS — today only agent messaging).
 *
 * A capability with a default has THREE states in the project file, not two: an explicit `true`, an
 * explicit `false`, and absent ("use this machine's default"). A two-position switch cannot show
 * that — it would draw "off" for a project that is on by default, and toggling it would write an
 * explicit value the user never asked for — so these rows are a three-way choice plus one sentence
 * saying what is in effect and why. Pure so the wording and the mapping are tested without a DOM.
 */
import {
  projectCapabilityFileState,
  type CapabilityMachineDefaults,
  type ProjectCapability
} from '@shared/project-capabilities'
import {
  capabilityAnswerOf,
  projectCapabilityEffective,
  type CapabilityAckMap
} from '@shared/project-capability-consent'

export type CapabilityChoice = 'default' | 'on' | 'off'

type ProjectView = Partial<Record<ProjectCapability, unknown>> & {
  capabilityAck?: CapabilityAckMap
  name?: string
}

/** Which of the three choices the project currently holds. An absent value this machine DECLINED
 *  reads as `off`, because that is what it is: the pre-default "turn it off" wrote exactly that. */
export function capabilityChoiceOf(
  p: ProjectView | undefined,
  cap: ProjectCapability
): CapabilityChoice {
  const file = projectCapabilityFileState(p, cap)
  if (file === 'on') return 'on'
  if (file === 'off') return 'off'
  return capabilityAnswerOf(p, cap) === 'declined' ? 'off' : 'default'
}

export function capabilityChoiceLabel(choice: CapabilityChoice, machineDefaultOn: boolean): string {
  if (choice === 'on') return 'On in this project'
  if (choice === 'off') return 'Off in this project'
  return `Use this machine's default (${machineDefaultOn ? 'on' : 'off'})`
}

/** One sentence: what is in effect for the project right now, and where that came from. */
export function capabilityStatusText(
  p: ProjectView | undefined,
  cap: ProjectCapability,
  defaults: CapabilityMachineDefaults
): string {
  if (!p) return 'Open a project to change this — the switch belongs to a project, not to the app.'
  const name = p.name ?? 'this project'
  const effective = projectCapabilityEffective(p, cap, defaults)
  if (effective.pendingNotice) {
    return (
      `Off in ${name} for now: its project file turns it on, but you have not confirmed that on ` +
      'this machine yet. Choose "On in this project" to confirm it.'
    )
  }
  const state = effective.on ? 'On' : 'Off'
  const why = effective.source === 'default' ? "this machine's default" : 'set for this project'
  return `${state} in ${name} (${why}).`
}

export interface CapabilityChoiceWriters {
  setProjectCapability(id: string, cap: ProjectCapability, on: boolean): void
  resetProjectCapabilityToDefault(id: string, cap: ProjectCapability): void
}

export function applyCapabilityChoice(
  writers: CapabilityChoiceWriters,
  projectId: string,
  cap: ProjectCapability,
  choice: CapabilityChoice
): void {
  if (choice === 'default') writers.resetProjectCapabilityToDefault(projectId, cap)
  else writers.setProjectCapability(projectId, cap, choice === 'on')
}
