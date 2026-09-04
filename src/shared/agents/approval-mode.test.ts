import { describe, expect, it } from 'vitest'
import {
  approvalFlags,
  bypassNoSandboxCaveat,
  modeSupported,
  permissionModeAgentIds,
  permissionModeAgentsLabel,
  unsupportedModesNote,
  withPermissionMode
} from './approval-mode'
import {
  ALL_PERMISSION_MODES,
  PERMISSION_MODE_LABELS,
  type AgentPermissionMode
} from './config'

/**
 * Measured flag vocabularies:
 *   claude / grok : --permission-mode auto|acceptEdits|plan|bypassPermissions   (manual = no flag)
 *   gemini 0.54.4 : --approval-mode  default|auto_edit|yolo|plan                (gemini --help)
 *   codex 0.153.2 : --ask-for-approval untrusted|on-request  (manual/auto), and
 *                   --dangerously-bypass-approvals-and-sandbox (bypassPermissions = full yolo)
 */
describe('approvalFlags — claude and grok are untouched', () => {
  it('emits the historical --permission-mode spelling', () => {
    expect(approvalFlags('claude', 'plan')).toEqual(['--permission-mode', 'plan'])
    expect(approvalFlags('grok', 'auto')).toEqual(['--permission-mode', 'auto'])
    expect(approvalFlags('claude', 'manual')).toEqual([])
  })
})

describe('approvalFlags — gemini', () => {
  it('translates every mode gemini can express', () => {
    expect(approvalFlags('gemini', 'manual')).toEqual([])
    expect(approvalFlags('gemini', 'plan')).toEqual(['--approval-mode', 'plan'])
    expect(approvalFlags('gemini', 'acceptEdits')).toEqual(['--approval-mode', 'auto_edit'])
    expect(approvalFlags('gemini', 'bypassPermissions')).toEqual(['--approval-mode', 'yolo'])
  })

  /**
   * The one that matters most, because `auto` is `DEFAULT_PERMISSION_MODE`: it decides what an
   * UNTOUCHED install launches gemini with.
   *
   * gemini's vocabulary is `default|auto_edit|yolo|plan` and none of those means "approve most
   * things but not edits". The nearest, `auto_edit`, is "auto-approve edit tools" — the opposite end
   * of the axis our `auto` is about. Mapping it would have turned every existing gemini node into an
   * auto-approve-edits session on upgrade, silently: gemini launched BARE before it joined
   * PERMISSION_MODE_CAPABLE (bare = gemini's `default` = prompt for approval), and `modeSupported`
   * would have said `true`, so the derived copy would not have admitted it either.
   */
  it('emits NO flag for `auto`, the default mode, rather than auto-approving edits', () => {
    expect(approvalFlags('gemini', 'auto')).toEqual([])
    expect(modeSupported('gemini', 'auto')).toBe(false)
    // Same command line gemini launched with before it joined the capable list.
    expect(withPermissionMode('gemini', 'gemini', 'auto')).toBe('gemini')
    // ...and it must not quietly become the acceptEdits value.
    expect(approvalFlags('gemini', 'auto')).not.toEqual(approvalFlags('gemini', 'acceptEdits'))
    // The derived copy has to say so, naming gemini and the mode.
    const note = unsupportedModesNote()
    expect(note).toContain('Gemini')
    expect(note).toContain(PERMISSION_MODE_LABELS.auto)
    expect(note).toContain("Gemini sessions start in Gemini's own default")
  })

  it('supports the four gemini has a value for', () => {
    for (const m of ALL_PERMISSION_MODES)
      expect(modeSupported('gemini', m), m).toBe(m !== 'auto')
  })

  it('only ever emits a value gemini --help lists', () => {
    // The vocabulary read off `gemini --help` on 0.54.4. A value outside it is a failed launch.
    const CHOICES = ['default', 'auto_edit', 'yolo', 'plan']
    for (const m of ALL_PERMISSION_MODES) {
      const flags = approvalFlags('gemini', m)
      if (!flags.length) continue
      expect(flags[0], m).toBe('--approval-mode')
      expect(CHOICES, m).toContain(flags[1])
    }
  })
})

describe('approvalFlags — codex REFUSES what it cannot express', () => {
  it('maps only the three modes that have a real counterpart', () => {
    expect(approvalFlags('codex', 'auto')).toEqual(['--ask-for-approval', 'on-request'])
    // Bypass all is FULL yolo: one flag that drops approvals AND the sandbox (not --ask-for-approval never).
    expect(approvalFlags('codex', 'bypassPermissions')).toEqual([
      '--dangerously-bypass-approvals-and-sandbox'
    ])
  })

  /**
   * codex is the only agent where `manual` emits a flag, and it MUST. Measured on 0.146.0:
   * `codex doctor` reports `approval policy OnRequest` with no `approval` key in
   * ~/.codex/config.toml, so codex's built-in default is "the model decides when to ask" — not "ask
   * each time". Unflagged, `manual` and `auto` would be the SAME runtime policy: two dropdown
   * entries collapsed onto one behaviour, under a label promising something else. `untrusted` is the
   * documented equivalent ("only run trusted commands without asking; escalate anything else").
   */
  it('emits `untrusted` for manual, because codex’s own default is not "ask each time"', () => {
    expect(approvalFlags('codex', 'manual')).toEqual(['--ask-for-approval', 'untrusted'])
    // ...and it is therefore a DIFFERENT policy from auto, which is the whole point.
    expect(approvalFlags('codex', 'manual')).not.toEqual(approvalFlags('codex', 'auto'))
    // codex has an equivalent, so the derived copy must NOT claim otherwise.
    expect(modeSupported('codex', 'manual')).toBe(true)
    expect(unsupportedModesNote()).not.toContain(PERMISSION_MODE_LABELS.manual)
  })

  it('leaves every other agent’s manual unflagged — their own default already prompts', () => {
    // gemini's `default` is documented as "prompt for approval", so no flag keeps the promise there.
    for (const id of ['claude', 'grok', 'gemini']) {
      expect(approvalFlags(id, 'manual'), id).toEqual([])
      expect(modeSupported(id, 'manual'), id).toBe(true)
    }
  })

  it('emits NO flag for a mode codex has no equivalent of', () => {
    // Silently substituting a nearest match would tell the user "Plan" while codex ran in
    // on-request. No flag = codex's own default, which is the honest degrade.
    expect(approvalFlags('codex', 'plan')).toEqual([])
    expect(approvalFlags('codex', 'acceptEdits')).toEqual([])
    expect(modeSupported('codex', 'plan')).toBe(false)
    expect(modeSupported('codex', 'acceptEdits')).toBe(false)
  })

  it('touches the sandbox ONLY for Bypass all (full yolo), never for the approval-only modes', () => {
    // manual/auto are approval-axis only — they must not widen filesystem access.
    for (const m of ['manual', 'auto'] as const)
      expect(approvalFlags('codex', m).join(' '), m).not.toContain('sandbox')
    // bypassPermissions IS full yolo: the one flag that drops approvals AND the sandbox together.
    expect(approvalFlags('codex', 'bypassPermissions')).toEqual([
      '--dangerously-bypass-approvals-and-sandbox'
    ])
  })

  it('only ever emits flags codex --help lists', () => {
    // Approval-axis values read off `codex --help`; Bypass all is the standalone bypass flag.
    const APPROVAL_CHOICES = ['untrusted', 'on-request']
    for (const m of ALL_PERMISSION_MODES) {
      const flags = approvalFlags('codex', m)
      if (!flags.length) continue
      if (flags[0] === '--dangerously-bypass-approvals-and-sandbox') {
        expect(flags, m).toEqual(['--dangerously-bypass-approvals-and-sandbox'])
        continue
      }
      expect(flags[0], m).toBe('--ask-for-approval')
      expect(APPROVAL_CHOICES, m).toContain(flags[1])
    }
  })
})

describe('approvalFlags — an agent with no permission mode', () => {
  it('emits nothing for opencode and for a custom agent', () => {
    for (const id of ['opencode', 'custom:abc']) {
      for (const m of ALL_PERMISSION_MODES)
        expect(approvalFlags(id, m), `${id}/${m}`).toEqual([])
    }
  })
})

/**
 * The settings copy is DERIVED from the mapping, so it cannot claim a mode works on an agent that
 * cannot express it. These assert the derivation, not the exact wording.
 */
describe('UI copy derived from the mapping', () => {
  it('names every agent whose start-up mode we can set', () => {
    const label = permissionModeAgentsLabel()
    for (const name of ['Claude Code', 'Grok', 'Gemini', 'Codex']) expect(label).toContain(name)
    expect(label).not.toContain('opencode')
  })

  it('agrees grammatically with the list it names, however long that list is', () => {
    // A hardcoded plural reads as "Grok are unaffected." the day the capable list narrows, which is
    // the same drift the label helper exists to prevent, one level down. The ids are exported so the
    // caller can agree with them; this pins that they describe the SAME set the label does.
    const ids = permissionModeAgentIds({ exclude: ['claude'] })
    expect(ids).toEqual(['grok', 'gemini', 'codex'])
    const label = permissionModeAgentsLabel({ exclude: ['claude'] })
    for (const id of ids) expect(label.toLowerCase()).toContain(id === 'codex' ? 'codex' : id)
    expect(label).not.toContain('Claude')
  })

  it('warns that Bypass all now runs codex with NO sandbox (full disk + network)', () => {
    // Inverts the old caveat: codex's bypass maps to --dangerously-bypass-approvals-and-sandbox, so
    // the warning must say the sandbox is gone, not that it is kept. Only codex among the capable
    // agents drops a separate sandbox.
    const caveat = bypassNoSandboxCaveat()
    expect(caveat).toContain('Codex')
    expect(caveat.toLowerCase()).toContain('sandbox')
    expect(caveat).not.toContain('Gemini')
    expect(caveat).not.toContain('Claude')
  })

  it('admits each gap once, with number agreement, and names no agent that has none', () => {
    const note = unsupportedModesNote()
    // codex: two gaps → plural verb.
    expect(note).toContain('Accept edits and Plan have no Codex equivalent')
    // gemini: one gap → singular verb. Both sentences in one string, one per agent.
    expect(note).toContain('Auto has no Gemini equivalent')
    // Number agreement on the possessive too: "Codex sessions start in Codex's own default",
    // never "in its own default".
    expect(note).toContain("Codex's own default")
    expect(note).toContain("Gemini's own default")
    // claude and grok express all five, so neither may appear in a sentence about missing modes.
    expect(note).not.toContain('Claude Code')
    expect(note).not.toContain('Grok')
  })

  it('says nothing at all when every capable agent expresses every mode', () => {
    // The sentence has to vanish by itself the day a CLI grows the missing mode — otherwise it
    // becomes a stale claim nobody thinks to delete. Proven by the shape: the note is a join over
    // agents WITH gaps, so an empty gap set is an empty string.
    const gapCount = ALL_PERMISSION_MODES.filter((m) => !modeSupported('codex', m)).length
    expect(gapCount).toBe(2)
    expect(unsupportedModesNote().endsWith('own default.')).toBe(true)
  })
})

/**
 * The mode is re-validated HERE for the same reason `permissionModeFlag` re-validates: the value
 * arrives from hand-editable, git-shared JSON (`.nodeterm/project.json`) and ends up interpolated
 * into a tmux `send-keys` command line, so the type is no protection at all. `constructor` is the
 * one that matters — a plain-object lookup table answers `'constructor' in table` with true and
 * hands back a Function, which would have been stringified onto a command line.
 */
/**
 * Issue #601 — a launch-command override that already spells the approval flag.
 *
 * `settings.agentLaunchCommands` replaces the program part with the user's own wrapper, and the
 * wrapper is entitled to carry the flag itself. Appending regardless produced
 * `claude --permission-mode bypassPermissions --permission-mode auto`: a duplicate the settings
 * field still displayed as exactly what was typed, so whichever occurrence the CLI honoured, the
 * user could not tell which one was in force from the UI.
 */
describe('withPermissionMode — a flag the command already carries (issue #601)', () => {
  it('does not append a second --permission-mode', () => {
    expect(withPermissionMode('claude --permission-mode bypassPermissions', 'claude', 'auto')).toBe(
      'claude --permission-mode bypassPermissions'
    )
  })

  it('reads the `--flag=value` spelling too', () => {
    expect(withPermissionMode('claude --permission-mode=plan', 'claude', 'auto')).toBe(
      'claude --permission-mode=plan'
    )
  })

  it('still appends when the override spells a DIFFERENT flag', () => {
    // The reporter's own benign case: the two flags are about different things, so nodeterm keeps
    // ownership of the one the user said nothing about.
    expect(withPermissionMode('claude --allow-dangerously-skip-permissions', 'claude', 'auto')).toBe(
      'claude --allow-dangerously-skip-permissions --permission-mode auto'
    )
  })

  it('answers per agent — a gemini wrapper carrying claude’s spelling is not a match', () => {
    // The dialects differ (`--approval-mode` vs `--permission-mode`), so the suppression has to be
    // keyed on the flag THIS agent would actually emit, not on a fixed string.
    expect(withPermissionMode('gemini --approval-mode yolo', 'gemini', 'plan')).toBe(
      'gemini --approval-mode yolo'
    )
    expect(withPermissionMode('gemini --permission-mode plan', 'gemini', 'plan')).toBe(
      'gemini --permission-mode plan --approval-mode plan'
    )
  })

  it('does not match the flag NAMED inside a quoted argument', () => {
    // Why this is tokenized rather than a substring search: a wrapper may talk ABOUT the flag, and
    // suppressing nodeterm's real flag over a sentence would silently change the mode every node
    // launches in.
    expect(
      withPermissionMode(
        "claude --append-system-prompt 'never suggest --permission-mode'",
        'claude',
        'auto'
      )
    ).toBe("claude --append-system-prompt 'never suggest --permission-mode' --permission-mode auto")
  })

  it('leaves every non-override command byte-identical', () => {
    // The regression guard for everyone who has not set an override: nodeterm builds those lines
    // and never puts the flag in twice, so the new branch is unreachable for them.
    expect(withPermissionMode('claude', 'claude', 'auto')).toBe('claude --permission-mode auto')
    expect(withPermissionMode('codex', 'codex', 'manual')).toBe('codex --ask-for-approval untrusted')
    // Bypass all on a plain codex is now full yolo, in one flag.
    expect(withPermissionMode('codex', 'codex', 'bypassPermissions')).toBe(
      'codex --dangerously-bypass-approvals-and-sandbox'
    )
    expect(withPermissionMode('claude', 'claude', 'manual')).toBe('claude')
  })
})

describe('withPermissionMode — codex, per-flag conflict suppression (reporter bug + reviewer fix)', () => {
  it('does NOT append a conflicting flag to a `codex --yolo` launch command', () => {
    // The reporter's exact case. `--yolo` = `--dangerously-bypass-approvals-and-sandbox`, mutually
    // exclusive with `--ask-for-approval`; before the fix Bypass all appended one and codex refused.
    expect(withPermissionMode('codex --yolo', 'codex', 'bypassPermissions')).toBe('codex --yolo')
    expect(withPermissionMode('codex --yolo', 'codex', 'auto')).toBe('codex --yolo')
    expect(withPermissionMode('codex --yolo', 'codex', 'manual')).toBe('codex --yolo')
  })

  it('leaves a command that already owns the APPROVAL axis (or a bypass flag) alone', () => {
    for (const cmd of [
      'codex --dangerously-bypass-approvals-and-sandbox',
      'codex --ask-for-approval never',
      'codex -a on-request'
    ]) {
      expect(withPermissionMode(cmd, 'codex', 'bypassPermissions'), cmd).toBe(cmd)
      expect(withPermissionMode(cmd, 'codex', 'auto'), cmd).toBe(cmd)
    }
  })

  it('a SANDBOX-only launch command still gets the dropdown’s approval policy (reviewer finding)', () => {
    // `--sandbox` and `--ask-for-approval` are orthogonal and codex takes both, so an approval mode
    // must NOT be dropped just because the user set a sandbox. Over-broad suppression did exactly
    // that (a sandbox-only command silently ran at codex's default approval policy).
    expect(withPermissionMode('codex --sandbox read-only', 'codex', 'auto')).toBe(
      'codex --sandbox read-only --ask-for-approval on-request'
    )
    expect(withPermissionMode('codex -s workspace-write', 'codex', 'manual')).toBe(
      'codex -s workspace-write --ask-for-approval untrusted'
    )
    // But the combined BYPASS flag IS mutually exclusive with --sandbox, so Bypass all is suppressed
    // beside a --sandbox command rather than emitted into a non-launchable pair.
    expect(
      withPermissionMode('codex --sandbox danger-full-access', 'codex', 'bypassPermissions')
    ).toBe('codex --sandbox danger-full-access')
  })

  it('still appends for a codex command that states no permission flag', () => {
    expect(withPermissionMode('my-codex-wrapper', 'codex', 'bypassPermissions')).toBe(
      'my-codex-wrapper --dangerously-bypass-approvals-and-sandbox'
    )
    expect(withPermissionMode('my-codex-wrapper', 'codex', 'auto')).toBe(
      'my-codex-wrapper --ask-for-approval on-request'
    )
  })

  it('recognises the SPACED short approval/sandbox forms (bundled is not — see shell-quote.ts)', () => {
    // -a / -s spaced are the forms people write, and they suppress correctly.
    expect(withPermissionMode('codex -a never', 'codex', 'bypassPermissions')).toBe('codex -a never')
    expect(withPermissionMode('codex -s danger-full-access', 'codex', 'bypassPermissions')).toBe(
      'codex -s danger-full-access'
    )
    // -s is the sandbox axis, orthogonal to approvals: an approval mode STILL appends beside it.
    expect(withPermissionMode('codex -s workspace-write', 'codex', 'auto')).toBe(
      'codex -s workspace-write --ask-for-approval on-request'
    )
  })
})

describe('approvalFlags — a forged mode yields the bare command', () => {
  const FORGED = ['yolo', 'on-request', 'constructor', '__proto__', 'toString', '', undefined, null]
  it('emits no flag for any agent', () => {
    for (const id of ['claude', 'grok', 'gemini', 'codex']) {
      for (const f of FORGED) {
        const mode = f as unknown as AgentPermissionMode
        expect(approvalFlags(id, mode), `${id}/${String(f)}`).toEqual([])
        expect(modeSupported(id, mode), `${id}/${String(f)}`).toBe(false)
      }
    }
  })
})
