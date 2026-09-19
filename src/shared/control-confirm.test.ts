import { describe, expect, it } from 'vitest'

import {
  CONFIRM_WAIVABLE_VERBS,
  CONTROL_REQUEST_TIMEOUT_MS,
  confirmExpiresAt,
  decideControlConfirm,
  expiredDialogNotice,
  isWaivableVerb,
  pruneControlConfirmWaivers,
  sanitizeControlConfirmWaivers,
  waivedNotice
} from './control-confirm'
import { DESTRUCTIVE_VERBS } from './control-verbs'

describe('which verbs may be waived', () => {
  it('is a strict subset of the confirm-gated set', () => {
    for (const v of CONFIRM_WAIVABLE_VERBS) expect(DESTRUCTIVE_VERBS.has(v)).toBe(true)
    expect(CONFIRM_WAIVABLE_VERBS.size).toBeLessThan(DESTRUCTIVE_VERBS.size)
  })

  it('never admits open-project, whatever the user asks for', () => {
    expect(isWaivableVerb('open-project')).toBe(false)
    // Every lever: the app-run set, the persisted list, and the bypass pair.
    expect(
      decideControlConfirm({ verb: 'open-project', sessionWaived: new Set(['open-project']) })
    ).toEqual({ skip: false, via: null })
    expect(
      decideControlConfirm({ verb: 'open-project', persisted: { always: ['open-project'] } })
    ).toEqual({ skip: false, via: null })
    expect(
      decideControlConfirm({
        verb: 'open-project',
        persisted: { bypassMode: true },
        permissionMode: 'bypassPermissions',
        permissionModeSource: 'global'
      })
    ).toEqual({ skip: false, via: null })
  })

  it('does not answer for a verb that has no dialog at all', () => {
    expect(isWaivableVerb('list')).toBe(false)
    expect(decideControlConfirm({ verb: 'list', sessionWaived: new Set(['list']) }).skip).toBe(false)
  })
})

describe('decideControlConfirm — the default is to ask', () => {
  it('asks when nothing is waived', () => {
    for (const verb of ['write', 'close']) {
      expect(decideControlConfirm({ verb })).toEqual({ skip: false, via: null })
    }
  })

  it('honours an app-run waiver, per verb', () => {
    expect(decideControlConfirm({ verb: 'close', sessionWaived: new Set(['close']) })).toEqual({
      skip: true,
      via: 'session'
    })
    // Waiving `close` says nothing about `write` — the whole point of keying on the verb.
    expect(decideControlConfirm({ verb: 'write', sessionWaived: new Set(['close']) }).skip).toBe(
      false
    )
  })

  it('honours a permanent waiver', () => {
    expect(decideControlConfirm({ verb: 'write', persisted: { always: ['write'] } })).toEqual({
      skip: true,
      via: 'always'
    })
  })

  it('re-checks a hand-edited `always` entry against the table', () => {
    // Reachable: settings.json is hand-editable and the sanitizer runs at read, but the decision
    // must not depend on somebody having called it.
    expect(
      decideControlConfirm({ verb: 'open-project', persisted: { always: ['open-project'] } }).skip
    ).toBe(false)
  })
})

describe('the bypassPermissions branch needs BOTH locks', () => {
  const bypassGlobal = {
    verb: 'close',
    permissionMode: 'bypassPermissions',
    permissionModeSource: 'global'
  } as const

  it('skips when the machine opted in AND the mode is the user own global choice', () => {
    expect(decideControlConfirm({ ...bypassGlobal, persisted: { bypassMode: true } })).toEqual({
      skip: true,
      via: 'bypass'
    })
  })

  it('asks when the machine did not opt in', () => {
    expect(decideControlConfirm({ ...bypassGlobal }).skip).toBe(false)
    expect(decideControlConfirm({ ...bypassGlobal, persisted: { bypassMode: false } }).skip).toBe(
      false
    )
  })

  it('asks when bypassPermissions came from the PROJECT file — the cloned-repo trap', () => {
    // `.nodeterm/project.json` is git-shared, so `project.defaultPermissionMode` arrives with
    // somebody else's repository. It must never waive a local confirmation.
    expect(
      decideControlConfirm({
        verb: 'close',
        persisted: { bypassMode: true },
        permissionMode: 'bypassPermissions',
        permissionModeSource: 'project'
      }).skip
    ).toBe(false)
  })

  it('asks when nobody chose the mode at all', () => {
    expect(
      decideControlConfirm({
        verb: 'close',
        persisted: { bypassMode: true },
        permissionMode: 'bypassPermissions',
        permissionModeSource: 'default'
      }).skip
    ).toBe(false)
  })

  it('asks under every other permission mode', () => {
    for (const mode of ['manual', 'auto', 'acceptEdits', 'plan'] as const) {
      expect(
        decideControlConfirm({
          verb: 'close',
          persisted: { bypassMode: true },
          permissionMode: mode,
          permissionModeSource: 'global'
        }).skip
      ).toBe(false)
    }
  })
})

describe('sanitizeControlConfirmWaivers — settings.json is hostile input', () => {
  it('drops unwaivable and unknown verb names', () => {
    expect(
      sanitizeControlConfirmWaivers({ always: ['close', 'open-project', 'rm -rf', 42] })
    ).toEqual({ always: ['close'] })
  })

  it('collapses duplicates and omits an empty list', () => {
    expect(sanitizeControlConfirmWaivers({ always: ['write', 'write'] })).toEqual({
      always: ['write']
    })
    expect(sanitizeControlConfirmWaivers({ always: [] })).toEqual({})
  })

  it('accepts only a literal true for bypassMode', () => {
    expect(sanitizeControlConfirmWaivers({ bypassMode: true })).toEqual({ bypassMode: true })
    for (const v of ['true', 1, {}, null]) {
      expect(sanitizeControlConfirmWaivers({ bypassMode: v })).toEqual({})
    }
  })

  it('degrades any non-object to "ask"', () => {
    for (const raw of [undefined, null, 'close', 7, ['close']]) {
      expect(sanitizeControlConfirmWaivers(raw)).toEqual({})
    }
  })
})

describe('the dialog deadline', () => {
  it('is main own request budget, measured from the renderer receipt', () => {
    expect(confirmExpiresAt(1_000)).toBe(1_000 + CONTROL_REQUEST_TIMEOUT_MS)
    // Later than main started waiting, never earlier: the renderer receives the request after the
    // timer starts, so the dialog can never abandon a request main would still accept.
    expect(confirmExpiresAt(1_000)).toBeGreaterThan(CONTROL_REQUEST_TIMEOUT_MS)
  })
})

describe('expiredDialogNotice', () => {
  it('names who asked, and says nothing happened', () => {
    const n = expiredDialogNotice('orchestrator')
    expect(n).toContain('orchestrator')
    expect(n).toContain('expired')
    // The whole point of the sentence: the user must not be left wondering whether the worktree
    // was removed / the text was sent while they were away.
    expect(n).toContain('nothing was done')
  })

  it('falls back to "an agent" rather than printing undefined', () => {
    expect(expiredDialogNotice()).toContain('an agent')
    expect(expiredDialogNotice()).not.toContain('undefined')
  })

  it('is ONE sentence for every expiring dialog', () => {
    // Both callers (the canvas-control confirm and the worktree-removal dialog) render this. Two
    // wordings for the same event read as two different events.
    expect(expiredDialogNotice('x')).toBe(expiredDialogNotice('x'))
  })
})

describe('waivedNotice', () => {
  it('names the action and the waiver that let it through', () => {
    expect(waivedNotice('Agent "x" closed 3 nodes', 'session')).toContain('this app run')
    expect(waivedNotice('Agent "x" closed 3 nodes', 'always')).toContain('permanently')
    expect(waivedNotice('Agent "x" closed 3 nodes', 'bypass')).toContain('Bypass')
    // Every variant points at where to undo it — a waived destructive action is never silent.
    for (const via of ['session', 'always', 'bypass'] as const) {
      expect(waivedNotice('did a thing', via)).toContain('Settings → Agents')
      expect(waivedNotice('did a thing', via)).toContain('did a thing')
    }
  })
})

describe('the per-project waiver — a "don\'t ask again" that lasts, without going machine-wide', () => {
  it('skips only inside the project it was granted for', () => {
    const persisted = { projects: { p1: ['close'] } }
    expect(decideControlConfirm({ verb: 'close', persisted, projectId: 'p1' })).toEqual({
      skip: true,
      via: 'project'
    })
    // The whole point of the scope. A user who trusts the orchestrator in one repo has said
    // nothing at all about the next one.
    expect(decideControlConfirm({ verb: 'close', persisted, projectId: 'p2' })).toEqual({
      skip: false,
      via: null
    })
    // …and nothing about another verb in the same project.
    expect(decideControlConfirm({ verb: 'write', persisted, projectId: 'p1' })).toEqual({
      skip: false,
      via: null
    })
  })

  it('needs a real project id — an absent one must not match anything', () => {
    // Fail closed: canvas control can now answer a call whose owning project it could not resolve,
    // and `undefined` used as a map key would stringify to "undefined" and match a hand-edited
    // entry of that name.
    const persisted = { projects: { undefined: ['close'], '': ['close'] } }
    expect(decideControlConfirm({ verb: 'close', persisted }).skip).toBe(false)
    expect(decideControlConfirm({ verb: 'close', persisted, projectId: '' }).skip).toBe(false)
  })

  it('is outranked by the unwaivable table, like every other lever', () => {
    expect(
      decideControlConfirm({
        verb: 'open-project',
        persisted: { projects: { p1: ['open-project'] } },
        projectId: 'p1'
      })
    ).toEqual({ skip: false, via: null })
  })

  it('sits between the app-run waiver and the machine-wide one', () => {
    // Precedence is narrowest-first among the persisted grants, so the notice names the waiver the
    // user most likely wants back. A session waiver still outranks it: it is the most recent thing
    // they said.
    const persisted = { projects: { p1: ['close'] }, always: ['close'] }
    expect(decideControlConfirm({ verb: 'close', persisted, projectId: 'p1' }).via).toBe('project')
    expect(
      decideControlConfirm({
        verb: 'close',
        persisted,
        projectId: 'p1',
        sessionWaived: new Set(['close'])
      }).via
    ).toBe('session')
    // A project with no entry still falls through to the machine-wide one.
    expect(decideControlConfirm({ verb: 'close', persisted, projectId: 'p9' }).via).toBe('always')
  })

  it('a project entry never opens the bypass branch, and vice versa', () => {
    // They are independent locks; neither may stand in for the other.
    expect(
      decideControlConfirm({
        verb: 'close',
        persisted: { projects: { p1: ['close'] } },
        projectId: 'p2',
        permissionMode: 'bypassPermissions',
        permissionModeSource: 'global'
      }).skip
    ).toBe(false)
  })
})

describe('sanitizeControlConfirmWaivers — the per-project map is hostile input too', () => {
  it('applies the verb table per project, exactly as it does to `always`', () => {
    expect(
      sanitizeControlConfirmWaivers({
        projects: { p1: ['close', 'open-project', 'nonsense', 'close'] }
      })
    ).toEqual({ projects: { p1: ['close'] } })
  })

  it('drops an entry that would waive nothing, key and all', () => {
    // An entry waiving nothing is indistinguishable from no entry to every reader, and keeping it
    // would put a row in Settings offering to revoke a waiver that does not exist.
    expect(sanitizeControlConfirmWaivers({ projects: { p1: [], p2: ['open-project'] } })).toEqual({})
  })

  it('degrades a non-object `projects` to nothing rather than throwing', () => {
    for (const bad of [null, 'close', 42, ['close'], true]) {
      expect(sanitizeControlConfirmWaivers({ projects: bad })).toEqual({})
    }
    expect(sanitizeControlConfirmWaivers({ projects: { '': ['close'] } })).toEqual({})
  })

  it('keeps the other keys intact', () => {
    expect(
      sanitizeControlConfirmWaivers({
        always: ['write'],
        projects: { p1: ['close'] },
        bypassMode: true
      })
    ).toEqual({ always: ['write'], projects: { p1: ['close'] }, bypassMode: true })
  })
})

describe('pruneControlConfirmWaivers — settings.json is forever, project ids are not', () => {
  it('drops entries whose project is gone', () => {
    const w = { projects: { alive: ['close'], dead: ['write'] }, always: ['write'] }
    expect(pruneControlConfirmWaivers(w, new Set(['alive']))).toEqual({
      projects: { alive: ['close'] },
      always: ['write']
    })
  })

  it('removes the key entirely when nothing survives', () => {
    const pruned = pruneControlConfirmWaivers({ projects: { dead: ['close'] } }, new Set())
    expect(pruned).toEqual({})
    expect('projects' in pruned).toBe(false)
  })

  it('returns the SAME object when nothing would change, so a no-op never dirties settings', () => {
    const w = { projects: { alive: ['close'] } }
    expect(pruneControlConfirmWaivers(w, new Set(['alive']))).toBe(w)
    const none = { always: ['close'] }
    expect(pruneControlConfirmWaivers(none, new Set())).toBe(none)
  })
})

describe('waivedNotice names the per-project waiver by project', () => {
  it('names the project, because "this project" may not be the one on screen', () => {
    // Canvas control answers a background agent in its OWN project without moving the user's tab,
    // so a notice saying "this project" would point at whatever they happen to be looking at.
    expect(waivedNotice('Agent "A" closed n-1', 'project', 'web-app')).toContain('"web-app"')
    expect(waivedNotice('Agent "A" closed n-1', 'project', 'web-app')).toContain('Settings \u2192 Agents')
  })

  it('still says something true when the project name is unknown', () => {
    expect(waivedNotice('x', 'project')).toContain('that project')
    expect(waivedNotice('x', 'project')).not.toContain('undefined')
  })

  it('the other three are unchanged', () => {
    expect(waivedNotice('x', 'session')).toContain('this app run')
    expect(waivedNotice('x', 'always')).toContain('permanently')
    expect(waivedNotice('x', 'bypass')).toContain('Bypass')
  })
})
