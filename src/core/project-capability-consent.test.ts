import { describe, it, expect } from 'vitest'
import type { Project } from '../shared/types'
import {
  needsCapabilityNotice,
  projectCapabilityGranted,
  projectCapabilityGrantedFor,
  recordCapabilityAck
} from './project-capability-consent'
import * as shared from '../shared/project-capability-consent'
import { projectToFile, type IndexEntryV3 } from './workspace-files'

const baseProject: Project = {
  id: 'p1',
  name: 'p',
  color: '#fff',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: []
}

describe('needsCapabilityNotice', () => {
  const cap = 'agentBrowserControl' as const
  it('off in the file ⇒ never a notice', () => {
    expect(needsCapabilityNotice({ capability: cap, enabledInFile: false, answer: undefined })).toBe(false)
    expect(needsCapabilityNotice({ capability: cap, enabledInFile: false, answer: 'declined' })).toBe(false)
  })
  it('on in the file and never answered ON THIS MACHINE ⇒ notice', () => {
    expect(needsCapabilityNotice({ capability: cap, enabledInFile: true, answer: undefined })).toBe(true)
  })
  it('on and KEPT ⇒ silent thereafter', () => {
    expect(needsCapabilityNotice({ capability: cap, enabledInFile: true, answer: 'kept' })).toBe(false)
  })
  it('on and previously DECLINED ⇒ a NEW notice — the file re-arrived against a recorded no', () => {
    // C1 (PR #213 review): "Turn it off" deletes the field only in this working copy; a
    // `git checkout`/pull restores the hostile `true` and the watcher re-reads it. A recorded
    // decline must produce a fresh notice, never silence.
    expect(needsCapabilityNotice({ capability: cap, enabledInFile: true, answer: 'declined' })).toBe(true)
  })
})

describe('projectCapabilityGranted — only an explicit KEPT grants', () => {
  const cap = 'agentBrowserControl' as const
  it('a switch that is on but unanswered grants nothing', () => {
    // This is what the ledger (browser PR 4) and messagingEnabled (messaging PR 6) consult: the
    // window between a hostile clone's `agentBrowserControl: true` arriving and the user answering
    // the notice must be a refusal. Deleting the answer condition makes this red.
    expect(projectCapabilityGranted({ capability: cap, enabledInFile: true, answer: undefined })).toBe(false)
  })
  it('a DECLINED switch grants nothing even when the file says true again', () => {
    // C1's grant leg: decline → hostile true re-arrives → the standing "no" must refuse. An ack
    // that does not carry the answer cannot express this; treating any answer as consent is the
    // exact mutation this test exists to catch.
    expect(projectCapabilityGranted({ capability: cap, enabledInFile: true, answer: 'declined' })).toBe(false)
  })
  it('off in the file grants nothing, whatever was answered', () => {
    expect(projectCapabilityGranted({ capability: cap, enabledInFile: false, answer: 'kept' })).toBe(false)
  })
  it('on and kept is the one granting combination', () => {
    expect(projectCapabilityGranted({ capability: cap, enabledInFile: true, answer: 'kept' })).toBe(true)
  })
})

describe('projectCapabilityGrantedFor — the ONE consumer-facing wiring (PR 4 ledger, PR 6 messagingEnabled)', () => {
  const cap = 'agentBrowserControl' as const
  it('derives both halves from the project and refuses every non-granting shape', () => {
    expect(projectCapabilityGrantedFor(undefined, cap, {})).toBe(false)
    expect(projectCapabilityGrantedFor({ ...baseProject }, cap, {})).toBe(false)
    // pending notice (hostile clone window)
    expect(projectCapabilityGrantedFor({ ...baseProject, agentBrowserControl: true }, cap, {})).toBe(false)
    // recorded decline + re-arrived true
    expect(
      projectCapabilityGrantedFor(
        { ...baseProject, agentBrowserControl: true, capabilityAck: { [cap]: 'declined' } },
        cap, {})
    ).toBe(false)
    // non-literal-true file value never grants, answer or no answer
    expect(
      projectCapabilityGrantedFor(
        { ...baseProject, agentBrowserControl: 'true', capabilityAck: { [cap]: 'kept' } } as never,
        cap, {})
    ).toBe(false)
  })
  it('grants exactly for literal true + kept', () => {
    expect(
      projectCapabilityGrantedFor(
        { ...baseProject, agentBrowserControl: true, capabilityAck: { [cap]: 'kept' } },
        cap, {})
    ).toBe(true)
  })
  it('ignores a prototype-inherited flag or answer — own properties only', () => {
    // M-1 (PR #213 review): unreachable from JSON.parse, but in-process objects can inherit.
    const inheritedFlag = Object.create({ agentBrowserControl: true }) as Project
    expect(projectCapabilityGrantedFor({ ...baseProject, ...inheritedFlag, capabilityAck: { [cap]: 'kept' } }, cap, {})).toBe(false)
    const proto = Object.create({ agentBrowserControl: true, capabilityAck: { [cap]: 'kept' } }) as Project
    expect(projectCapabilityGrantedFor(proto, cap, {})).toBe(false)
  })
})

describe('the acknowledgment is MACHINE-LOCAL and carries the answer', () => {
  it('recordCapabilityAck writes the given answer to the index entry, never to the project file', () => {
    const kept = recordCapabilityAck({ id: 'p1', name: 'p', color: '#fff' } as IndexEntryV3, 'agentBrowserControl', 'kept')
    expect(kept.capabilityAck).toEqual({ agentBrowserControl: 'kept' })
    const declined = recordCapabilityAck({ id: 'p1', name: 'p', color: '#fff' } as IndexEntryV3, 'agentBrowserControl', 'declined')
    expect(declined.capabilityAck).toEqual({ agentBrowserControl: 'declined' })
    // The shared file must not learn about it: projectToFile writes only the capability FIELDS.
    // The project here CARRIES an ack (M-3: an ack-less input could never catch a leak).
    const file = projectToFile(
      { ...baseProject, agentBrowserControl: true, capabilityAck: { agentBrowserControl: 'kept' } },
      1,
      't',
      'l'
    )
    expect(Object.keys(file)).not.toContain('capabilityAck')
    expect(JSON.stringify(file)).not.toContain('capabilityAck')
  })

  it('a later answer overwrites an earlier one, without mutating the input', () => {
    const before: IndexEntryV3 = {
      id: 'p1',
      name: 'p',
      color: '#fff',
      capabilityAck: { agentBrowserControl: 'declined' }
    }
    const after = recordCapabilityAck(before, 'agentBrowserControl', 'kept')
    expect(after).not.toBe(before)
    expect(before.capabilityAck).toEqual({ agentBrowserControl: 'declined' })
    expect(after.capabilityAck).toEqual({ agentBrowserControl: 'kept' })
  })

  it('a SECOND WORKTREE of the same repo notifies again', () => {
    // node ids and project.json re-materialise in a second folder (git worktree add / checkout /
    // reset --hard), and workspace-files.ts is explicit that the index entry id is the only
    // authority for project identity. A second folder is a second entry, hence a second notice —
    // which is correct: it is a different working copy the user has not vetted.
    const a = recordCapabilityAck({ id: 'p1', name: 'p', color: '#fff' } as IndexEntryV3, 'agentBrowserControl', 'kept')
    const b: IndexEntryV3 = { id: 'p2', name: 'p', color: '#fff' } // same repo, second worktree, fresh entry
    expect(
      needsCapabilityNotice({
        capability: 'agentBrowserControl',
        enabledInFile: true,
        answer: a.capabilityAck?.agentBrowserControl
      })
    ).toBe(false)
    expect(
      needsCapabilityNotice({
        capability: 'agentBrowserControl',
        enabledInFile: true,
        answer: b.capabilityAck?.agentBrowserControl
      })
    ).toBe(true)
  })
})

describe('one decider, two consumers', () => {
  it('core re-exports the SAME functions the renderer imports from @shared — no drift possible', () => {
    // Same rule as isSafeNodeId: the renderer may not import src/core, so the implementation lives
    // in @shared/project-capability-consent and this core path re-exports it for main/core callers
    // (agent-messaging PR 6 Task 6.2 must not reimplement either function).
    expect(needsCapabilityNotice).toBe(shared.needsCapabilityNotice)
    expect(recordCapabilityAck).toBe(shared.recordCapabilityAck)
    expect(projectCapabilityGranted).toBe(shared.projectCapabilityGranted)
    expect(projectCapabilityGrantedFor).toBe(shared.projectCapabilityGrantedFor)
  })
})

describe('the MACHINE DEFAULT answers absence — and only absence (agentMessaging)', () => {
  const cap = 'agentMessaging' as const
  const on = { agentMessagingDefault: true }
  const off = { agentMessagingDefault: false }

  it('a project whose file says NOTHING reads on under the default, off without it', () => {
    expect(projectCapabilityGrantedFor({}, cap, on)).toBe(true)
    expect(projectCapabilityGrantedFor({}, cap, off)).toBe(false)
    expect(projectCapabilityGrantedFor({}, cap, {})).toBe(false)
    expect(shared.projectCapabilityEffective({}, cap, on)).toEqual({
      on: true,
      source: 'default',
      pendingNotice: false
    })
  })

  it('an explicit false in the file stays OFF, whatever the default', () => {
    expect(projectCapabilityGrantedFor({ agentMessaging: false }, cap, on)).toBe(false)
    expect(
      projectCapabilityGrantedFor(
        { agentMessaging: false, capabilityAck: { agentMessaging: 'kept' } },
        cap,
        on
      )
    ).toBe(false)
  })

  it('a CLONED true still needs this machine’s answer — the default is not consent for it', () => {
    const cloned = { agentMessaging: true }
    expect(projectCapabilityGrantedFor(cloned, cap, on)).toBe(false)
    expect(needsCapabilityNotice({ capability: cap, enabledInFile: true, answer: undefined })).toBe(
      true
    )
    expect(shared.projectCapabilityEffective(cloned, cap, on).pendingNotice).toBe(true)
  })

  it('a recorded DECLINE keeps an absent field off — the pre-default builds wrote "off" that way', () => {
    expect(
      projectCapabilityGrantedFor({ capabilityAck: { agentMessaging: 'declined' } }, cap, on)
    ).toBe(false)
  })

  it('a project on only by default raises no notice: the decider is keyed on an EXPLICIT true', () => {
    // CapabilityNotice feeds `enabledInFile` from the strict file flag, which is false for absence.
    expect(needsCapabilityNotice({ capability: cap, enabledInFile: false, answer: undefined })).toBe(
      false
    )
  })

  it('the default is read strictly: a hand-edited "true" string in settings.json is off', () => {
    expect(
      projectCapabilityGrantedFor({}, cap, { agentMessagingDefault: 'true' as unknown as boolean })
    ).toBe(false)
  })

  it('a malformed file value is absence, not an explicit off — and not an explicit on', () => {
    for (const v of ['true', 'false', 0, 1, null, {}]) {
      expect(projectCapabilityGrantedFor({ agentMessaging: v }, cap, on), String(v)).toBe(true)
      expect(projectCapabilityGrantedFor({ agentMessaging: v }, cap, off), String(v)).toBe(false)
    }
  })

  it('browser control has NO default: absence is off even if a caller passes one', () => {
    expect(
      projectCapabilityGrantedFor({}, 'agentBrowserControl', on as Record<string, boolean>)
    ).toBe(false)
    expect(
      projectCapabilityGrantedFor({ agentBrowserControl: false }, 'agentBrowserControl', on)
    ).toBe(false)
  })

  it('the core re-export is the same function object', () => {
    // src/core callers must reach the one rule, not a copy.
    expect(projectCapabilityGrantedFor).toBe(shared.projectCapabilityGrantedFor)
  })
})
