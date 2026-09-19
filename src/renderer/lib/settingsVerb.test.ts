import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Project } from '@shared/types'
import { planSettingsSet, parseSettingsRequest } from '@shared/settings-verb'
import {
  needsCapabilityNotice,
  projectCapabilityGrantedFor,
  capabilityAnswerOf
} from '@shared/project-capability-consent'
import { projectCapabilityFlagInFile } from '@shared/project-capabilities'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useProjects } from '../state/projects'
import { applySettingsChange } from './settingsVerb'

const base = (id: string, over: Partial<Project> = {}): Project => ({
  id,
  name: 'api',
  color: '#fff',
  cwd: `/work/${id}`,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  ...over
})

/** Run a `settings --set` the way the dispatch does: parse → plan → (user confirms) → apply. */
function cliSet(projectId: string, value: 'true' | 'false'): void {
  const request = parseSettingsRequest({ set: 'agentMessaging', value })
  if ('error' in request || request.action !== 'set') throw new Error('bad request')
  const plan = planSettingsSet({
    request,
    settings: DEFAULT_SETTINGS,
    project: useProjects.getState().getProject(projectId),
    requestedBy: 'agent'
  })
  if (plan.kind !== 'confirm') throw new Error(`expected a confirm, got ${plan.kind}`)
  applySettingsChange(plan.change)
}

const strip = ({ id: _id, cwd: _cwd, ...rest }: Project) => rest

describe('a CLI change lands as exactly the state the Settings switch produces', () => {
  beforeEach(() => {
    useProjects.getState().hydrate({
      version: 2,
      activeProjectId: 'cli',
      projects: [base('cli'), base('ui')]
    })
  })

  it('turning messaging ON: file true AND this machine’s kept answer — granted, no clone notice', () => {
    cliSet('cli', 'true')
    // The AgentsSection switch's onChange, verbatim.
    useProjects.getState().setProjectCapability('ui', 'agentMessaging', true)
    const cli = useProjects.getState().getProject('cli')!
    const ui = useProjects.getState().getProject('ui')!
    expect(strip(cli)).toEqual(strip(ui))
    expect(projectCapabilityFlagInFile(cli, 'agentMessaging')).toBe(true)
    expect(capabilityAnswerOf(cli, 'agentMessaging')).toBe('kept')
    expect(projectCapabilityGrantedFor(cli, 'agentMessaging', {})).toBe(true)
    expect(
      needsCapabilityNotice({
        capability: 'agentMessaging',
        enabledInFile: true,
        answer: capabilityAnswerOf(cli, 'agentMessaging')
      })
    ).toBe(false)
  })

  it('confirming an unconfirmed file true is the same consent as the switch', () => {
    useProjects.getState().hydrate({
      version: 2,
      activeProjectId: 'cli',
      projects: [base('cli', { agentMessaging: true }), base('ui', { agentMessaging: true })]
    })
    cliSet('cli', 'true')
    useProjects.getState().setProjectCapability('ui', 'agentMessaging', true)
    expect(strip(useProjects.getState().getProject('cli')!)).toEqual(
      strip(useProjects.getState().getProject('ui')!)
    )
    expect(projectCapabilityGrantedFor(useProjects.getState().getProject('cli'), 'agentMessaging', {})).toBe(true)
  })

  it('turning it OFF matches too', () => {
    for (const id of ['cli', 'ui']) useProjects.getState().setProjectCapability(id, 'agentMessaging', true)
    cliSet('cli', 'false')
    useProjects.getState().setProjectCapability('ui', 'agentMessaging', false)
    expect(strip(useProjects.getState().getProject('cli')!)).toEqual(
      strip(useProjects.getState().getProject('ui')!)
    )
    expect(projectCapabilityGrantedFor(useProjects.getState().getProject('cli'), 'agentMessaging', {})).toBe(false)
  })
})

describe('applySettingsChange writes through exactly one setter', () => {
  it('machine keys go to the settings store', () => {
    const writers = { setProjectCapability: vi.fn(), updateSettings: vi.fn() }
    applySettingsChange({ scope: 'machine', patch: { gridSize: 32 } }, writers)
    expect(writers.updateSettings).toHaveBeenCalledWith({ gridSize: 32 })
    expect(writers.setProjectCapability).not.toHaveBeenCalled()
  })
})

describe('under a machine default that is ON, the CLI and the Settings choice still land identically', () => {
  it('--set false writes the same explicit false + declined as choosing "Off in this project"', () => {
    useProjects.getState().hydrate({
      version: 2,
      activeProjectId: 'cli',
      projects: [base('cli'), base('ui')]
    })
    const settings = { ...DEFAULT_SETTINGS, agentMessagingDefault: true }
    const request = parseSettingsRequest({ set: 'agentMessaging', value: 'false' })
    if ('error' in request || request.action !== 'set') throw new Error('bad request')
    const plan = planSettingsSet({
      request,
      settings,
      project: useProjects.getState().getProject('cli'),
      requestedBy: 'agent'
    })
    if (plan.kind !== 'confirm') throw new Error(`expected a confirm, got ${plan.kind}`)
    applySettingsChange(plan.change)
    useProjects.getState().setProjectCapability('ui', 'agentMessaging', false)
    const cli = useProjects.getState().getProject('cli')!
    expect(strip(cli)).toEqual(strip(useProjects.getState().getProject('ui')!))
    expect(cli.agentMessaging).toBe(false)
    expect(projectCapabilityGrantedFor(cli, 'agentMessaging', settings)).toBe(false)
  })
})
