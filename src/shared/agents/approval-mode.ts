// Per-agent translation of nodeterm's permission mode into the agent's own approval flag.
//
// claude and grok share one spelling and one vocabulary, which is why they needed no mapping at all
// until now. gemini and codex each have their own, and BOTH are narrower than ours — which is the
// interesting case: our five modes fit neither `default|auto_edit|yolo|plan` nor
// `untrusted|on-request|never`, so a mode the CLI cannot express emits NO flag (its own default)
// rather than a nearest match. A silent substitution would show the user "Plan" while codex ran in
// on-request, or "Auto" while gemini auto-approved every file edit.
//
// Measured: `gemini --help` (0.54.4) and `codex --help` (0.146.0 … 0.154.0, and 0.153.2 for the
// bypass flag). For codex, `manual` and `auto` touch the APPROVAL axis only (`--ask-for-approval`),
// leaving the sandbox at its default; but `bypassPermissions` ("Bypass all") is FULL yolo (fork,
// Termscape) — it maps to `--dangerously-bypass-approvals-and-sandbox`, one flag that drops BOTH the
// approval prompts and the sandbox, so "Bypass all" means the same unrestricted access on codex as
// on claude. A bypass that still sandboxed the filesystem was not what the label promised, and the
// `codex --yolo` launch-command workaround for it was itself broken (see withPermissionMode). That
// flag is mutually exclusive with `--ask-for-approval` and `--sandbox`, which is why
// withPermissionMode must recognise the whole permission axis, not just the one flag it would append.
//
// AND ONE AGENT'S VOCABULARY IS NOT A CONSTANT. codex accepted `untrusted|on-request|never`
// through 0.148.0 and accepts `on-request|never` from 0.149.0 on — measured release by release,
// see `CODEX_APPROVAL_BASELINE`. clap does not ignore a value it does not know, it EXITS, so a
// table pinned to one release is not a stale mapping, it is a dead node. Every `--ask-for-approval`
// value this module emits is therefore checked against what the CLI that will actually run the
// session says it takes (`ApprovalCaps`), and a value we have not seen it advertise is never emitted.
import {
  AGENT_CONFIG,
  ALL_PERMISSION_MODES,
  PERMISSION_MODE_CAPABLE,
  PERMISSION_MODE_LABELS,
  hasPermissionMode,
  isPermissionMode,
  permissionModeFlag,
  type AgentId,
  type AgentPermissionMode,
  type BuiltinAgentId
} from './config'
import { argvHasFlag } from '../shell-quote'

/**
 * What we know about the CLI that will actually RUN this session — the facts that decide whether a
 * value in the tables below may be emitted at all.
 *
 * Optional and empty-by-default ON PURPOSE. A caller that passes nothing gets the baseline
 * vocabulary, which is the safe answer everywhere: the launch keeps working, at worst one mode
 * degrades to the CLI's own default (and the derived UI copy says so). A caller that forgets to
 * pass its probe result therefore costs a mode, never a dead pane — which is the only degrade
 * direction this file accepts.
 */
export interface ApprovalCaps {
  /** The values this machine's (or this host's) `codex` advertises for `--ask-for-approval`, read
   *  from its own `--help` — see `core/codex-cli.ts`. `null`/absent = not probed, not probeable
   *  (a remote host, a relay tab), or the probe failed. */
  codexApprovalValues?: readonly string[] | null
}

/**
 * The `--ask-for-approval` values EVERY codex we have measured accepts, and therefore the answer
 * when we do not know which codex will run.
 *
 * Measured one release at a time on real binaries (`@openai/codex@<v>-linux-x64`, `--help`):
 * 0.146.0 · 0.147.0 · 0.148.0 advertise `untrusted, on-request, never`; 0.149.0 · 0.150.0 ·
 * 0.151.0 · 0.152.0 · 0.153.0 · 0.154.0 advertise `on-request, never`. So `untrusted` was removed
 * in **0.149.0** — five releases before the one issue #785 reported it from — and `on-request` /
 * `never` are common to every one of them.
 *
 * `untrusted` is deliberately NOT in the baseline. An unknown value does not degrade: clap answers
 *
 *   error: invalid value 'untrusted' for '--ask-for-approval <APPROVAL_POLICY>'
 *
 * and exits, so the pane is left at a bare shell with the launch dead (issue #785). A value we
 * have not SEEN this CLI advertise is never emitted; the two we have seen on every measured
 * release are what an unprobed launch falls back to, because that is the command line nodeterm has
 * always sent for those modes.
 */
const CODEX_APPROVAL_BASELINE: readonly string[] = ['on-request', 'never']

/** One agent's approval dialect: each mode it can express → the EXACT argv to append for it. Full
 *  flag arrays, not a shared flag + value table, because codex's `bypassPermissions` is a DIFFERENT
 *  flag from its other modes (`--dangerously-bypass-approvals-and-sandbox`, which takes no value) —
 *  a shared-flag model could not express it. A mode absent from the table has no equivalent in this
 *  agent's CLI and emits nothing (its own default), surfaced via modeSupported/unsupportedModesNote. */
interface ApprovalDialect {
  modes: Partial<Record<AgentPermissionMode, readonly string[]>>
  /**
   * Does this CLI's OWN default already prompt before every action?
   *
   * This is what decides whether `manual` ("Ask each time") is honoured by emitting NOTHING. For
   * gemini it is true — its `default` mode is documented as "prompt for approval" — so the bare
   * command already keeps the promise. For codex it is false: its built-in default is
   * `on-request`, "the model decides when to ask", so an unflagged codex delivers something else
   * entirely under that label. Kept as a per-agent fact rather than a special case in
   * `modeSupported`, because it is a property of the CLI, not of the mode.
   */
  manualIsDefault: boolean
  /** The values this CLI accepts for ONE version-dependent flag. `undefined` = every entry in
   *  `modes` is stable across the releases we have measured, so the table alone decides (gemini).
   *  Only codex has one — `--ask-for-approval`, see `CODEX_APPROVAL_BASELINE`. An entry that does
   *  not carry `flag` (codex's bypass flag, which takes no value) is not filtered by it. */
  vocabulary?: { flag: string; values: (caps: ApprovalCaps) => readonly string[] }
  /** What this CLI actually does when `manual` turns out to be inexpressible, for the UI note.
   *  Lives beside the table so the sentence cannot drift from it. */
  manualGapNote?: string
}

const GEMINI_MODES: Partial<Record<AgentPermissionMode, readonly string[]>> = {
  plan: ['--approval-mode', 'plan'],
  acceptEdits: ['--approval-mode', 'auto_edit'],
  bypassPermissions: ['--approval-mode', 'yolo']
  // `manual` → gemini's own `default`, i.e. NO flag, exactly as it is for claude.
  //
  // `auto` is ABSENT ON PURPOSE, and it is the one absence worth explaining, because `auto` is
  // `DEFAULT_PERMISSION_MODE` — so this decides what an untouched install launches gemini with.
  // gemini's vocabulary is exactly `default|auto_edit|yolo|plan`; none of those means "approve most
  // things but NOT edits", which is what our `auto` promises. The nearest value, `auto_edit`, is
  // documented as "auto-approve edit tools" — the opposite end of the one axis the user cares
  // about. Mapping `auto → auto_edit` would therefore have made every existing gemini node start
  // auto-approving file edits on upgrade, silently: before gemini joined PERMISSION_MODE_CAPABLE it
  // always launched bare (= `default` = prompt for approval), and `modeSupported` would have
  // answered `true`, so the derived copy would not have admitted it either. No flag is the honest
  // answer and reproduces the pre-branch launch exactly. See `unsupportedModesNote`.
}

const CODEX_MODES: Partial<Record<AgentPermissionMode, readonly string[]>> = {
  // codex is the FIRST agent where `manual` emits a flag, and — where the CLI still has the value
  // — it has to. For every other agent `manual` = no flag = a default that already prompts
  // (gemini's own `default` is documented as "prompt for approval"), which is exactly what the
  // label "Ask each time" promises. codex's built-in default is NOT that: measured on 0.146.0 AND
  // re-measured on 0.151.0, `codex doctor` reports `approval policy OnRequest` with no `approval`
  // key in ~/.codex/config.toml — the model decides when to ask. So leaving `manual` unflagged
  // delivers `on-request` under an "ask each time" label, and collapses two dropdown entries onto
  // one behaviour — the same dishonesty this module exists to remove, just expressed as an
  // unflagged claim instead of a substituted flag. `untrusted` is the real equivalent: "only run
  // trusted commands without asking; escalate anything not in the trusted set".
  //
  // THIS ENTRY IS A CANDIDATE, NOT A PROMISE. codex removed `untrusted` in 0.149.0, so on any
  // current CLI it is filtered out by `vocabulary` below and `manual` emits nothing — and
  // `modeSupported` then answers false, so `unsupportedModesNote` admits it instead of the
  // dropdown quietly lying. It stays in the table because a codex <= 0.148.0 is still a codex a
  // user may be running, and on THAT CLI "Ask each time" really is expressible; the probe is what
  // decides, not this file.
  //
  // What was checked before concluding the mode is gone (all on 0.151.0): `-a unless-trusted` —
  // rejected by clap; `-c approval_policy=untrusted` and `-c approval_policy=unless-trusted` —
  // both refused with "config could not be loaded", so the TOML route is not a back door either;
  // `--approve-for-me` — a real flag, but it routes approvals through AUTOMATIC review, which is
  // the opposite of asking the user. 0.149.0+ genuinely cannot express "ask every time".
  manual: ['--ask-for-approval', 'untrusted'],
  auto: ['--ask-for-approval', 'on-request'],
  // `bypassPermissions` ("Bypass all") is FULL yolo for codex (fork, Termscape; upstream maps it to
  // `--ask-for-approval never`, which keeps the sandbox). `--dangerously-bypass-approvals-and-sandbox`
  // drops the approval prompts AND the sandbox in one flag, so "Bypass all" grants the same
  // unrestricted access here as on claude — not "approvals off but still sandboxed", which the label
  // did not promise and which no in-product setting could reach (the `codex --yolo` launch-command
  // workaround itself broke — see withPermissionMode). The flag takes no value, so the
  // `--ask-for-approval` vocabulary gate does not apply to it. It is MUTUALLY EXCLUSIVE with
  // `--ask-for-approval` and `--sandbox`; withPermissionMode suppresses the append whenever the
  // user's own command already states either axis, so codex is never handed both.
  bypassPermissions: ['--dangerously-bypass-approvals-and-sandbox']
  // No `plan` and no edit-specific mode exists in ANY measured codex (0.146.0 … 0.154.0), so
  // `plan` and `acceptEdits` are absent ON PURPOSE — see modeSupported.
}

/**
 * The agents that need a translation: each mode mapped to the exact argv to append.
 *
 * Each mode carries its FULL flags, so a new agent (or a new mode) states its own spelling and its
 * value together — there is no shared flag field for a mode to disagree with, which is how a table
 * once risked emitting one agent's flag with another agent's value.
 *
 * Looked up through `Object.hasOwn`, not `[agentId]`: `AgentId` is OPEN (custom agents carry
 * user-typed ids), so a plain-object index answers `'constructor'` with a Function.
 */
const APPROVAL_DIALECTS: Partial<Record<AgentId, ApprovalDialect>> = {
  gemini: { modes: GEMINI_MODES, manualIsDefault: true },
  codex: {
    modes: CODEX_MODES,
    manualIsDefault: false,
    vocabulary: {
      flag: '--ask-for-approval',
      values: (caps) =>
        caps.codexApprovalValues?.length ? caps.codexApprovalValues : CODEX_APPROVAL_BASELINE
    },
    manualGapNote:
      'That default asks only when the model chooses to: `untrusted`, the policy that meant ' +
      'ask-every-time, was removed in codex-cli 0.149.0 and has no replacement.'
  }
}

/**
 * The argv this dialect may actually EMIT for this mode — the table entry, filtered through what
 * the target CLI says it accepts for its version-dependent flag. `undefined` = emit nothing.
 *
 * `Object.hasOwn`, not `[mode]`, for the same reason `dialectFor` uses it: the callers below
 * validate `mode` with `isPermissionMode` first, and this keeps the lookup honest even so — a
 * plain-object index answers `'constructor'` with a Function, and this value is headed for a shell
 * command line.
 */
function emittableFlags(
  dialect: ApprovalDialect,
  mode: AgentPermissionMode,
  caps: ApprovalCaps
): readonly string[] | undefined {
  const flags = Object.hasOwn(dialect.modes, mode) ? dialect.modes[mode] : undefined
  if (!flags?.length) return undefined
  if (!dialect.vocabulary) return flags
  const at = flags.indexOf(dialect.vocabulary.flag)
  // An entry that does not spell the version-dependent flag (codex's value-less bypass flag) is
  // not gated by that flag's vocabulary.
  if (at < 0) return flags
  const value = flags[at + 1]
  return value !== undefined && dialect.vocabulary.values(caps).includes(value) ? flags : undefined
}

const dialectFor = (agentId: AgentId): ApprovalDialect | null =>
  Object.hasOwn(APPROVAL_DIALECTS, agentId) ? APPROVAL_DIALECTS[agentId] ?? null : null

/** Can this agent actually start in this mode? `false` means the launch omits the flag and the
 *  agent uses its own default — surfaced in the UI so the user is not misled. */
export function modeSupported(
  agentId: AgentId,
  mode: AgentPermissionMode,
  caps: ApprovalCaps = {}
): boolean {
  if (!isPermissionMode(mode)) return false
  const dialect = dialectFor(agentId)
  // claude and grok speak our own vocabulary and their defaults prompt: every mode is reachable.
  if (!dialect) return hasPermissionMode(agentId)
  // `manual` — "ask each time" — is reached two different ways, which is why the table alone is
  // not its authority: by emitting NO flag on a CLI whose own default already prompts
  // (`manualIsDefault`: claude, grok, gemini), or by emitting a value that means it (codex's
  // `untrusted`). An agent that can do NEITHER cannot keep the promise, and this is where that is
  // admitted — codex >= 0.149.0 is exactly that case, and it is why this early return stopped
  // being an unconditional `true`.
  if (mode === 'manual')
    return dialect.manualIsDefault || emittableFlags(dialect, 'manual', caps) !== undefined
  return emittableFlags(dialect, mode, caps) !== undefined
}

/**
 * The flags to append for this agent + mode. Empty = the bare command.
 *
 * The mode is re-validated at the top for the same reason `permissionModeFlag` does it: the value
 * comes from hand-editable, git-shared JSON (settings.json / project.json) and is interpolated into
 * a shell command line, so its TYPE proves nothing. Without the guard, a forged `constructor`
 * indexes a plain-object table and hands back a Function — one that would have been stringified
 * onto a tmux `send-keys` line. (`dialectFor` closes the same hole on the agent id.)
 */
export function approvalFlags(
  agentId: AgentId,
  mode: AgentPermissionMode,
  caps: ApprovalCaps = {}
): string[] {
  if (!isPermissionMode(mode)) return []
  const dialect = dialectFor(agentId)
  if (dialect) {
    const flags = emittableFlags(dialect, mode, caps)
    return flags ? [...flags] : []
  }
  // claude + grok keep their exact historical spelling, validated at the interpolation site.
  return hasPermissionMode(agentId) ? permissionModeFlag(mode) : []
}

// codex's three flag groups. Its APPROVAL axis and its SANDBOX axis are independent (codex accepts
// `--sandbox X --ask-for-approval Y` together), but the combined BYPASS flag sets both at once and is
// MUTUALLY EXCLUSIVE with each — codex refuses to launch if a bypass flag appears beside either axis.
// `--approve-for-me` (automatic review + workspace-write sandbox) is in the same class: measured on
// codex-cli 0.155.1, it is refused beside `--ask-for-approval` and beside `--sandbox`.
const CODEX_APPROVAL_FLAGS = ['--ask-for-approval', '-a'] as const
const CODEX_SANDBOX_FLAGS = ['--sandbox', '-s'] as const
const CODEX_BYPASS_FLAGS = [
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--full-auto',
  '--approve-for-me'
] as const
/** Every codex permission-axis flag the funnel knows. The shared-identity launcher's preflight
 *  (`nt_preflight`, core/codex-identity-proxy.ts) must recognize the same set: a flag in one list
 *  and not the other either appends a pair codex refuses or skips the plain-codex fallback.
 *  `codex-permission-flags.guard.test.ts` pins the two together. */
export const CODEX_PERMISSION_FLAGS: readonly string[] = [
  ...CODEX_APPROVAL_FLAGS,
  ...CODEX_SANDBOX_FLAGS,
  ...CODEX_BYPASS_FLAGS
]

/**
 * For codex, the flags already in a launch command that make appending `appendedFlag` (the first
 * flag we would add) either a mutual-exclusion CONFLICT or a duplicate — so we append nothing.
 *
 * The distinction matters and a blanket "any axis flag suppresses" is WRONG (it silently dropped the
 * dropdown's approval policy for a sandbox-only launch command — reviewer finding):
 *  - Appending an `--ask-for-approval` flag is suppressed by an existing APPROVAL flag (duplicate) or
 *    a BYPASS flag (which sets approvals too, and conflicts). It is NOT suppressed by `--sandbox`:
 *    `codex --sandbox read-only` should still get the dropdown's approval policy — the axes are
 *    orthogonal and codex takes both.
 *  - Appending the combined BYPASS flag is suppressed by ANY approval, sandbox, or bypass flag,
 *    because `--dangerously-bypass-approvals-and-sandbox` is mutually exclusive with both axes.
 */
function codexSuppressors(appendedFlag: string): readonly string[] {
  return appendedFlag === '--dangerously-bypass-approvals-and-sandbox'
    ? [...CODEX_APPROVAL_FLAGS, ...CODEX_SANDBOX_FLAGS, ...CODEX_BYPASS_FLAGS]
    : [...CODEX_APPROVAL_FLAGS, ...CODEX_BYPASS_FLAGS]
}

/**
 * Appends the agent's approval flag to a launch command, if it has one. The single funnel for every
 * CLI launch path (new node, cold-restore resume, branch, handoff, canvas control).
 *
 * WHERE the flag lands is decided one layer up, by `createAgentNode`: with no `argvPromptSeparator`
 * (claude, gemini, codex) it goes LAST, keeping those command lines byte-identical; with one
 * (grok's `--`) it must go BEFORE the separator, because `--` is end-of-options.
 *
 * **A flag the command already carries is left alone (issue #601).** `cmd` is not always ours:
 * `settings.agentLaunchCommands` lets the user replace the program part with a wrapper, and a
 * wrapper may spell the approval flag itself. Appending regardless produced
 * `claude --permission-mode bypassPermissions --permission-mode auto` — a duplicate the settings
 * field still displayed as exactly what the user typed, so whichever occurrence the CLI honoured,
 * they had no way to tell which one was in force.
 *
 * **For codex the suppression spans its permission axes, not one flag (the reporter's bug).** codex's
 * `--yolo` / `--dangerously-bypass-approvals-and-sandbox` is mutually exclusive with
 * `--ask-for-approval` and `--sandbox`, so appending our flag beside a user's `codex --yolo` did not
 * merely duplicate — codex refused to launch. `codexSuppressors` decides, per the flag we are about
 * to add, which existing flags conflict with or duplicate it — narrowly, so a sandbox-only launch
 * command still receives the dropdown's (orthogonal) approval policy.
 *
 * The contract this settles is "program only, minus what you spelled yourself", not "the override
 * owns the whole command". The whole-command reading cannot work: the settings copy already
 * promises that `--resume` and friends are appended, and a wrapper has no way to know the session id
 * a cold restore is resuming — so nodeterm has to keep appending. What it must not do is append a
 * SECOND opinion about a flag the user has already stated one about; theirs is the more specific and
 * the more explicit, and it wins.
 *
 * Deliberately not extended to `withAgentModel`: a model switch is a per-node action the user just
 * took, and letting a global launch-command override veto it would silently strand that node on the
 * wrapper's model. Different specificity, opposite answer.
 *
 * A command with no override cannot reach the suppression — nodeterm builds it and never puts the
 * flag in twice — so every existing launch line is byte-identical.
 */
export function withPermissionMode(
  cmd: string,
  id: AgentId,
  mode: AgentPermissionMode,
  caps: ApprovalCaps = {}
): string {
  const flags = approvalFlags(id, mode, caps)
  if (!flags.length) return cmd
  // Suppress the append when the user's command already states the relevant permission flag. For
  // codex the conflicting/duplicate set depends on WHICH flag we would add (codexSuppressors); every
  // other agent falls back to the single flag it would emit, byte-identical to before.
  const suppressors = id === 'codex' ? codexSuppressors(flags[0]) : [flags[0]]
  if (suppressors.some((f) => argvHasFlag(cmd, f))) return cmd
  return `${cmd} ${flags.join(' ')}`
}

// ---------------------------------------------------------------------------------------------
// UI copy, DERIVED from the mapping above.
//
// The settings description has to name the agents the mode applies to and admit where it does not
// apply, and both facts live in the mapping. Spelling them out in a string literal is how a sentence
// starts telling users that Plan works on an agent that has silently stopped supporting it — a
// sentence that drifts from the mapping is worse than none. So they are computed.
// ---------------------------------------------------------------------------------------------

const agentLabel = (id: AgentId): string =>
  AGENT_CONFIG[id as BuiltinAgentId]?.label ?? id

const joinAnd = (parts: string[]): string =>
  parts.length <= 1
    ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`

/**
 * The agents whose start-up mode we can set, labelled for prose: "Claude Code, Grok, …".
 *
 * `mode` narrows to the agents that can actually express THAT mode (a warning about "Bypass all"
 * must not name an agent the mode never reaches); `exclude` drops one the sentence is already about
 * (claude's version-gate note, whose subject is claude).
 */
export function permissionModeAgentsLabel(opts?: PermissionModeAgentFilter): string {
  return joinAnd(permissionModeAgentIds(opts).map(agentLabel))
}

interface PermissionModeAgentFilter {
  mode?: AgentPermissionMode
  exclude?: readonly AgentId[]
  /** What the target CLIs accept, so a "which agents support this mode?" answer is about the CLIs
   *  the user actually has. Omitted = the baseline, exactly as everywhere else in this file. */
  caps?: ApprovalCaps
}

/**
 * The ids `permissionModeAgentsLabel` will name, under the same filter.
 *
 * Exported so a caller can AGREE with the label grammatically — one agent takes "is", several take
 * "are" — instead of hardcoding a plural that reads as "Grok are unaffected" the day the capable list
 * narrows. Same drift `permissionModeAgentsLabel` exists to prevent, one level down.
 */
export function permissionModeAgentIds(opts?: PermissionModeAgentFilter): AgentId[] {
  return PERMISSION_MODE_CAPABLE.filter(
    (id) =>
      !opts?.exclude?.includes(id) &&
      (opts?.mode === undefined || modeSupported(id, opts.mode, opts.caps ?? {}))
  )
}

/**
 * One sentence per capable agent that cannot express every mode, naming the modes and saying what
 * happens instead. Empty string when there is nothing to admit — so the caller appends it blindly
 * and the sentence disappears by itself the day a CLI grows the missing mode.
 */
export function unsupportedModesNote(caps: ApprovalCaps = {}): string {
  return PERMISSION_MODE_CAPABLE.map((id) => ({
    label: agentLabel(id),
    gaps: ALL_PERMISSION_MODES.filter((m) => !modeSupported(id, m, caps)),
    // Only rendered when `manual` is among the gaps — see below. A generic "starts in its own
    // default" is honest for Plan and Accept edits (nothing was promised about what the default
    // does), but it is NOT enough for "Ask each time": the user picked a promise about every
    // single action, and codex's default keeps none of it. The sentence lives on the dialect so
    // it can only be written where the behaviour it describes is.
    manualGap: dialectFor(id)?.manualGapNote
  }))
    .filter((a) => a.gaps.length > 0)
    .map(({ label, gaps, manualGap }) => {
      const modes = joinAnd(gaps.map((m) => PERMISSION_MODE_LABELS[m]))
      const verb = gaps.length > 1 ? 'have' : 'has'
      const head = `${modes} ${verb} no ${label} equivalent, so ${label} sessions start in ${label}'s own default.`
      return gaps.includes('manual') && manualGap ? `${head} ${manualGap}` : head
    })
    .join(' ')
}

/**
 * Agents whose "Bypass all" ALSO drops the OS sandbox (full filesystem + network), not just the
 * approval prompts — so the warning can say so. codex's `bypassPermissions` maps to
 * `--dangerously-bypass-approvals-and-sandbox`; claude/grok/gemini have no separate sandbox to drop
 * (their bypass was always full). Kept beside the mapping that causes it so the copy cannot drift.
 * (This inverts the pre-change `bypassSandboxCaveat`, which reassured that codex KEPT its sandbox —
 * now false.)
 */
const BYPASS_DROPS_SANDBOX: readonly AgentId[] = ['codex']

/** The clause a "Bypass all" warning owes now that codex's bypass drops the sandbox: "no permission
 *  checks" must be read as "no sandbox either — full disk and network". Empty when it applies to
 *  nobody. `caps` narrows to the agents whose CLI can actually express the bypass (upstream's
 *  vocabulary gate), exactly as `permissionModeAgentsLabel` does. */
export function bypassNoSandboxCaveat(caps: ApprovalCaps = {}): string {
  const ids = permissionModeAgentIds({ mode: 'bypassPermissions', caps }).filter((id) =>
    BYPASS_DROPS_SANDBOX.includes(id)
  )
  if (!ids.length) return ''
  const label = joinAnd(ids.map(agentLabel))
  return `${label} additionally ${ids.length > 1 ? 'run' : 'runs'} with NO sandbox — full filesystem and network access, not just skipped prompts.`
}
