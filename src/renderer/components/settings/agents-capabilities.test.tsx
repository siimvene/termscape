// @vitest-environment jsdom
//
// Settings → Agents: the per-project capability rows are GENERATED from PROJECT_CAPABILITIES.
// Every assertion below iterates the array rather than naming rows: a capability added to the
// union without a rendered row (the hand-written-list failure this repo has already documented)
// fails here, and agent messaging's row (its PR 6) must appear by adding a copy entry only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Project } from '@shared/types'
import {
  PROJECT_CAPABILITIES,
  PROJECT_CAPABILITY_COPY,
  capabilityHasMachineDefault,
  projectCapabilityFlagInFile
} from '@shared/project-capabilities'
import { projectCapabilityGrantedFor } from '@shared/project-capability-consent'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useProjects } from '../../state/projects'
import { useSettings } from '../../state/settings'
import { AgentsSection } from './sections/AgentsSection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'my-canvas',
  color: '#7aa2f7',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  ...over
})

let root: Root
let host: HTMLElement

function mount(): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<AgentsSection isActive />))
}

/** Capabilities drawn as a two-position switch (no machine default) and as a three-way choice. */
const SWITCH_CAPS = PROJECT_CAPABILITIES.filter((c) => !capabilityHasMachineDefault(c))
const CHOICE_CAPS = PROJECT_CAPABILITIES.filter((c) => capabilityHasMachineDefault(c))

function capChoice(label: string): HTMLSelectElement {
  const el = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)
  expect(el, `a rendered choice for "${label}"`).toBeTruthy()
  return el!
}

function choose(el: HTMLSelectElement, value: string): void {
  act(() => {
    el.value = value
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/** Either control, for assertions that hold for both. */
function capControl(label: string): HTMLElement {
  const el =
    host.querySelector<HTMLElement>(`[role="switch"][aria-label="${label}"]`) ??
    host.querySelector<HTMLElement>(`select[aria-label="${label}"]`)
  expect(el, `a rendered control for "${label}"`).toBeTruthy()
  return el!
}

function capSwitch(label: string): HTMLElement {
  const el = host.querySelector<HTMLElement>(`[role="switch"][aria-label="${label}"]`)
  expect(el, `a rendered switch for "${label}"`).toBeTruthy()
  return el!
}

beforeEach(() => {
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    settings: { save: vi.fn(async () => undefined) },
    claude: { cliCaps: vi.fn(async () => null) }
  }
  useProjects.setState({ projects: [project()], activeProjectId: 'p1', reloadNonce: 0 })
  useSettings.setState({ settings: DEFAULT_SETTINGS, hydrated: true })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useProjects.setState({ projects: [], activeProjectId: '' })
})

describe('per-project capability rows, generated from PROJECT_CAPABILITIES', () => {
  it('renders one row per capability, naming the active project, the grant and what travels', () => {
    mount()
    const text = host.textContent ?? ''
    for (const cap of PROJECT_CAPABILITIES) {
      const copy = PROJECT_CAPABILITY_COPY[cap]
      capControl(copy.label)
      expect(text).toContain(copy.description)
      // The same "this is in the project file" sentence the clone notice shows: the two
      // git-shared grants read alike wherever the switch is set.
      expect(text).toContain(copy.cloneWarning)
    }
    expect(text).toContain('my-canvas')
  })

  it.each([...SWITCH_CAPS])(
    'toggling %s on writes the literal true the strict validators accept, plus this machine’s ack',
    (cap) => {
      mount()
      act(() => capSwitch(PROJECT_CAPABILITY_COPY[cap].label).click())
      const p = useProjects.getState().getProject('p1')!
      expect(p[cap]).toBe(true) // === true, not "true"/1 — projectCapabilityFlagInFile is strict
      // Setting it yourself records its own KEPT: no clone notice for the user's own switch.
      expect(p.capabilityAck?.[cap]).toBe('kept')
      expect(projectCapabilityFlagInFile(p, cap)).toBe(true)
    }
  )

  it.each([...SWITCH_CAPS])(
    'toggling %s off deletes the field outright — no bytes, and never a stored false',
    (cap) => {
      useProjects.getState().setProjectCapability('p1', cap, true)
      mount()
      act(() => capSwitch(PROJECT_CAPABILITY_COPY[cap].label).click())
      const p = useProjects.getState().getProject('p1')!
      expect(p[cap]).toBeUndefined()
      // …and records DECLINED (PR #213 C1/M-2): if a teammate re-commits `true`, the project is
      // re-noticed and refused instead of silently re-granted through the old consent.
      expect(p.capabilityAck?.[cap]).toBe('declined')
    }
  )

  it('turning a capability off takes effect LIVE: every read consults the store, nothing caches', () => {
    // PR 6 Task 6.4 depends on this shape: the browser ledger / messagingEnabled read the switch
    // per call. Simulate two consecutive calls around an off-toggle and require the second to see
    // the refusal immediately — no lease-start snapshot may answer for it.
    const cap = SWITCH_CAPS[0]
    useProjects.getState().setProjectCapability('p1', cap, true)
    const grantedNow = (): boolean =>
      projectCapabilityGrantedFor(useProjects.getState().getProject('p1'), cap, {})
    expect(grantedNow()).toBe(true)
    mount()
    act(() => capSwitch(PROJECT_CAPABILITY_COPY[cap].label).click())
    expect(grantedNow()).toBe(false)
  })

  it('with no project open the switch is disabled — a capability needs a project to belong to', () => {
    useProjects.setState({ projects: [], activeProjectId: '' })
    mount()
    for (const cap of PROJECT_CAPABILITIES) {
      const el = capControl(PROJECT_CAPABILITY_COPY[cap].label)
      expect(el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled')).toBe(true)
    }
  })
})

describe('a capability with a machine default is a three-way choice, not a switch', () => {
  it('has one (agent messaging), and nothing without a default grew a choice', () => {
    expect(CHOICE_CAPS).toEqual(['agentMessaging'])
  })

  it.each([...CHOICE_CAPS])('%s: an untouched project reads "use default" and says it is off by default', (cap) => {
    mount()
    const el = capChoice(PROJECT_CAPABILITY_COPY[cap].label)
    expect(el.value).toBe('default')
    expect(host.textContent).toContain("Off in my-canvas (this machine's default).")
    expect(el.textContent).toContain("Use this machine's default (off)")
  })

  it.each([...CHOICE_CAPS])('%s: with the machine default ON, an untouched project reads "on (default)" and GRANTS', (cap) => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, agentMessagingDefault: true }, hydrated: true })
    mount()
    expect(capChoice(PROJECT_CAPABILITY_COPY[cap].label).value).toBe('default')
    expect(host.textContent).toContain("On in my-canvas (this machine's default).")
    const p = useProjects.getState().getProject('p1')
    expect(projectCapabilityGrantedFor(p, cap, useSettings.getState().settings)).toBe(true)
    // …and nothing was written to the project to make it so.
    expect(p && Object.prototype.hasOwnProperty.call(p, cap)).toBe(false)
  })

  it.each([...CHOICE_CAPS])('%s: "On" writes true + kept; "Off" writes an explicit false + declined that beats a default', (cap) => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, agentMessagingDefault: true }, hydrated: true })
    mount()
    choose(capChoice(PROJECT_CAPABILITY_COPY[cap].label), 'on')
    let p = useProjects.getState().getProject('p1')!
    expect(p[cap]).toBe(true)
    expect(p.capabilityAck?.[cap]).toBe('kept')
    expect(host.textContent).toContain('On in my-canvas (set for this project).')
    choose(capChoice(PROJECT_CAPABILITY_COPY[cap].label), 'off')
    p = useProjects.getState().getProject('p1')!
    expect(p[cap]).toBe(false)
    expect(p.capabilityAck?.[cap]).toBe('declined')
    expect(projectCapabilityGrantedFor(p, cap, useSettings.getState().settings)).toBe(false)
    expect(host.textContent).toContain('Off in my-canvas (set for this project).')
  })

  it.each([...CHOICE_CAPS])('%s: "Use default" clears the value AND the answer, so the default applies again', (cap) => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, agentMessagingDefault: true }, hydrated: true })
    useProjects.getState().setProjectCapability('p1', cap, false)
    mount()
    choose(capChoice(PROJECT_CAPABILITY_COPY[cap].label), 'default')
    const p = useProjects.getState().getProject('p1')!
    expect(Object.prototype.hasOwnProperty.call(p, cap)).toBe(false)
    expect(p.capabilityAck?.[cap]).toBeUndefined()
    expect(projectCapabilityGrantedFor(p, cap, useSettings.getState().settings)).toBe(true)
  })

  it('the machine default is a switch in settings.json, not in any project', () => {
    mount()
    const label = 'Agent messaging in projects that do not set it'
    act(() => capSwitch(label).click())
    expect(useSettings.getState().settings.agentMessagingDefault).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(useProjects.getState().getProject('p1')!, 'agentMessaging')).toBe(false)
  })
})
