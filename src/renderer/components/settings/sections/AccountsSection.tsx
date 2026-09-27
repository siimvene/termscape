import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { IconClose } from '../../icons'
import { AgentIcon } from '../../../lib/agentIcons'
import type { ClaudeAccount, ClaudeSkillShareResult } from '@shared/types'
import type { CodexAccount } from '@shared/codex-account'
import type { PiAccount } from '@shared/pi-account'
import { E_UNSUPPORTED } from '@shared/rpc'
import { sshHostKey } from '@shared/ssh'
import { useAgentStatus } from '../../../state/agentStatus'
import { useSettings } from '../../../state/settings'
import { useSystemAccount } from '../../../state/systemAccount'
import { useSystemCodexAccount } from '../../../state/systemCodexAccount'
import { isAccountLoginNode, isPiAccountLoginNode } from '../../../state/workspace'
import { NODE_COLOR_SECTIONS } from '@shared/node-colors'
import { useProjects } from '../../../state/projects'
import { useSshConn } from '../../../state/sshConn'
import { useSshServers } from '../../../state/sshServers'
import {
  applyResolvedCodexAccounts,
  discoverResolvedCodexAccounts
} from '../../../state/codexAccountReconcile'
import {
  codexRemoteTargets,
  groupAccountsByMachine,
  strayAccounts
} from '../../../lib/codexMachineGroups'
import { configDirLabel, unlinkedConfigDirs } from '../../../lib/accountChip'
import { presentAccount } from '../../../lib/accountPresentation'
import {
  healedAccount,
  healedPiAccount,
  openLoginNodeThenCapture,
  raceLoginCapture
} from '../../../lib/accountHeal'
import { skillShareNote } from '../../../lib/skillSharing'
import { codexAccountSelectable } from '../../../canvas/codex-account-switch'
import { ConfirmDialog } from '../../ConfirmDialog'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { Button } from '@renderer/ui/Button'
import { Input } from '@renderer/ui/Input'
import { Switch } from '@renderer/ui/Switch'
import { cn } from '@renderer/ui/cn'
import { thisMachine, thisMachineCap } from '../../../lib/machineName'

const ROWS = {
  accounts: {
    title: 'Claude, Codex & Pi accounts',
    keywords: [
      'account',
      'claude',
      'codex',
      'openai',
      'pi',
      'provider',
      'anthropic',
      'login',
      'isolated',
      'multi',
      'email',
      'link',
      'config dir',
      'existing',
      'detected',
      'machine',
      'ssh',
      'host',
      'remote'
    ]
  }
}
const ENTRIES = Object.values(ROWS)

/** The bridge's "this shell registers no such handler" rejection (renderer/bridge/stubs.ts). It is
 *  a fact about the SURFACE, not about this account — worth a different sentence than a failure. */
const isUnsupported = (e: unknown): boolean =>
  !!e && typeof e === 'object' && (e as { code?: string }).code === E_UNSUPPORTED

/** The rejection's own message when it has one, else `fallback`. `link` refuses for a handful of
 *  specific, user-fixable reasons (not a directory, already linked, that IS the system account) and
 *  every one of them is worth more than a generic failure line. Errors arrive as plain objects over
 *  the WS bridge, so this reads the field rather than testing `instanceof Error`. */
const errorText = (e: unknown, fallback: string): string => {
  const m = e && typeof e === 'object' ? (e as { message?: unknown }).message : undefined
  return typeof m === 'string' && m.trim() ? m.trim() : fallback
}

/** One machine's card in the accounts UI: a connectivity dot, the machine label, a Local/SSH pill,
 *  and (for a remote machine) its `user@host` subtitle. Children are the provider blocks. */
function MachinePanel({
  label,
  remote,
  hostKey,
  connected,
  children
}: {
  label: string
  remote: boolean
  hostKey?: string
  connected?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section
      aria-label={remote ? `Accounts on ${hostKey ?? label}` : `Accounts on ${label}`}
      className="space-y-3 rounded-md border border-border p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            !remote || connected ? 'bg-[color:var(--state-success)]' : 'bg-[color:var(--muted-2)]'
          }`}
          aria-hidden
          title={!remote ? 'This machine' : connected ? 'Connected' : 'Not connected'}
        />
        <span className="text-[13px] font-medium text-text">{label}</span>
        <span className="rounded-full bg-fill-weak px-2 py-0.5 text-[11px] font-medium text-muted">
          {remote ? 'SSH' : 'Local'}
        </span>
        {remote && hostKey && hostKey !== label ? (
          <span className="text-[12px] text-muted">{hostKey}</span>
        ) : null}
        {remote && !connected ? (
          <span className="text-[12px] text-muted">
            · not connected — open a project on this host to add or log in accounts
          </span>
        ) : null}
      </div>
      {children}
    </section>
  )
}

/**
 * One provider's accounts on one machine. The SAME frame for Claude, Codex and Pi — a heading with
 * the agent's icon and its Add button, then the system row, then the managed rows — so the
 * providers read, and are added, the same way on every machine. (Pi appears on THIS machine only:
 * managed Pi accounts are local-only, see `.claude/rules/agents-pi.md`.)
 */
function ProviderBlock({
  agentId,
  title,
  action,
  error,
  progress,
  children
}: {
  agentId: 'claude' | 'codex' | 'pi'
  title: string
  action: React.ReactNode
  error?: string | null
  progress?: string | null
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[12px] font-medium text-text">
          <AgentIcon agentId={agentId} size={14} />
          {title}
        </div>
        {action}
      </div>
      {progress ? <p className="text-[12px] leading-relaxed text-muted">{progress}</p> : null}
      {error ? <p className="text-[12px] text-[color:var(--danger)]">{error}</p> : null}
      <div className="space-y-2">{children}</div>
    </div>
  )
}

/** The machine's implicit SYSTEM login (`~/.claude` / `~/.codex`) — not an account record, so it
 *  has no remove and no color; `name` may be an editable label (the local Claude one is). */
function SystemAccountRow({
  name,
  detail,
  action
}: {
  name: React.ReactNode
  detail?: string | null
  /** Row-level controls (the local Claude row's "Sign in / switch"); absent elsewhere. */
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 p-2">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          {name}
          <span
            className="rounded-full bg-fill-weak px-2 py-0.5 text-[11px] font-medium text-muted"
            title="The machine's default login. Used when a node has no account."
          >
            system
          </span>
        </div>
        {detail ? <p className="text-[12px] text-muted">{detail}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  )
}

/** A managed account row — identical for both providers; `extra` carries provider-only controls. */
function ManagedAccountRow({
  label,
  placeholder,
  onLabel,
  pending,
  pills,
  email,
  color,
  onColor,
  extra,
  actions,
  blockedReason
}: {
  label: string
  placeholder: string
  onLabel: (label: string) => void
  pending?: boolean
  pills?: React.ReactNode
  email?: string | null
  color?: string
  onColor: (color?: string) => void
  extra?: React.ReactNode
  actions: React.ReactNode
  blockedReason?: string
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 rounded-md border p-2',
        blockedReason ? 'border-[color:var(--warn)]/40' : 'border-border/60'
      )}
      title={blockedReason}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Input
            className="w-56"
            placeholder={placeholder}
            value={label}
            onChange={(e) => onLabel(e.target.value)}
          />
          {pending ? (
            <span className="rounded-full bg-[color:var(--warn)]/15 px-2 py-0.5 text-[11px] font-medium text-[color:var(--warn)]">
              pending
            </span>
          ) : null}
          {pills}
        </div>
        {email && !pending ? <p className="text-[12px] text-muted">{email}</p> : null}
        {blockedReason ? (
          <p className="text-[11px] text-[color:var(--warn)]">{blockedReason}</p>
        ) : null}
        <AccountColorSwatches label={label} color={color} onPick={onColor} />
        {extra}
      </div>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </div>
  )
}

/** Which Add button is mid-setup: `<provider>:<host>` (`''` host = this machine). */
type Provider = 'claude' | 'codex' | 'pi'
const addKey = (provider: Provider, host: string): string => `${provider}:${host}`

/** Reads fresh settings then applies a transform to the accounts list (avoids stale closures
 *  after an awaited login resolves late). */
function applyAccounts(fn: (accs: ClaudeAccount[]) => ClaudeAccount[]): void {
  const s = useSettings.getState()
  s.update({ claudeAccounts: fn(s.settings.claudeAccounts) })
}

/** The same fresh-read/transform for the Codex account list. */
function applyCodexAccounts(fn: (accs: CodexAccount[]) => CodexAccount[]): void {
  const s = useSettings.getState()
  s.update({ codexAccounts: fn(s.settings.codexAccounts) })
}

/** The same fresh-read/transform for the pi account list. */
function applyPiAccounts(fn: (accs: PiAccount[]) => PiAccount[]): void {
  const s = useSettings.getState()
  s.update({ piAccounts: fn(s.settings.piAccounts) })
}

/**
 * The per-account default node color picker. ONE definition for every managed-account kind: a
 * Claude, a Codex and a Pi account carry the same optional `color` and feed the same `agentAccountColor`
 * read at node creation, so two copies of these swatches could only drift. `label` names the group
 * for assistive tech (and for the tests) — account labels are user-typed, so it is the only handle
 * a row reliably has.
 */
function AccountColorSwatches({
  label,
  color,
  onPick
}: {
  label: string
  color?: string
  onPick: (color?: string) => void
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={`Default node color for ${label}`}
      className="flex flex-wrap items-center gap-2 pt-1"
    >
      <span className="text-[12px] text-muted">Node color</span>
      <button
        type="button"
        aria-label="Default"
        aria-pressed={!color}
        title="Use the agent's own color"
        onClick={() => onPick(undefined)}
        className={cn(
          'flex size-5 items-center justify-center rounded-full border-2 text-[11px] text-muted',
          color ? 'border-transparent bg-fill-weak' : 'border-text bg-fill-weak'
        )}
      >
        ✕
      </button>
      {NODE_COLOR_SECTIONS.map((section, i) => (
        <Fragment key={section.label}>
          {/* The agent section is headed so a user can tell WHICH circle is Claude's — the whole
              point of putting the brand colors in the palette. The first section keeps its
              historical bare row. */}
          {i > 0 ? (
            <span className="text-[11px] text-muted">{section.label}</span>
          ) : null}
          {section.swatches.map((swatch) => (
            <button
              key={swatch.value}
              type="button"
              // "<what> <name>", the convention the Appearance accent picker set — a bare hex is
              // not a name a screen reader can do anything with, which is also why the palette
              // now carries labels rather than only values.
              aria-label={`Node color ${swatch.label}`}
              title={swatch.label}
              aria-pressed={color === swatch.value}
              onClick={() => onPick(swatch.value)}
              style={{ background: swatch.value }}
              className={cn(
                'size-5 rounded-full border-2',
                color === swatch.value ? 'border-text' : 'border-transparent'
              )}
            />
          ))}
        </Fragment>
      ))}
    </div>
  )
}

/**
 * The per-account "Share ~/.claude/skills with this account" switch (issue #643).
 *
 * A managed account's config dir REPLACES `~/.claude/skills` rather than adding to it — that is
 * Claude Code's own `join(CLAUDE_CONFIG_DIR, 'skills')` — so a fresh account shows only the skills
 * nodeterm installed. The isolation is often the point, which is why this is off by default; this
 * is the way back in.
 *
 * The copy says **edits flow both ways** because they do: each system skill is LINKED, not copied,
 * so editing one from inside this account edits the machine's copy. A user who reads "share" as
 * "copy" would find that out by losing work.
 *
 * The switch is DISABLED (never hidden) for a remote account, with the reason — a silently missing
 * control teaches nothing, and an SSH account's skills live on its host, which v1 does not reach.
 */
function SkillSharingRow({
  account,
  onChange
}: {
  account: ClaudeAccount
  /** Resolves to the line to show under the switch, or null for "nothing worth saying". */
  onChange: (enabled: boolean) => Promise<string | null>
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const remote = !!account.host
  const on = !!account.shareSystemSkills
  return (
    <div className="pt-1">
      <div className="flex items-center gap-2">
        <Switch
          checked={on}
          disabled={remote || busy}
          ariaLabel={`Share system skills with ${account.label || account.id}`}
          onChange={(v) => {
            setBusy(true)
            setNote(null)
            void onChange(v)
              .then(setNote)
              .catch((e: unknown) => setNote(errorText(e, 'Could not update skill sharing.')))
              .finally(() => setBusy(false))
          }}
        />
        <span
          className="text-[12px] text-muted"
          // The full consequence rides the tooltip; the line below keeps the one fact a user must
          // not miss (an edit changes the machine's own file) visible without a paragraph per row.
          title={
            remote
              ? undefined
              : 'Links this machine’s skills into the account. They are shared, not copied, so an edit from either side changes the same file. Turning this off removes only the links.'
          }
        >
          Share ~/.claude/skills
        </span>
        <span className="text-[11px] text-muted">
          {remote
            ? 'Not available for accounts on an SSH host — their skills live on that machine.'
            : '— linked, not copied: edits change the same files'}
        </span>
      </div>
      {note ? <p className="pt-1 text-[11px] text-[color:var(--warn)]">{note}</p> : null}
    </div>
  )
}

/** Counts nodes bound to an account across every project's SERIALIZED nodes. The active
 *  project's live React Flow edits since the last commit aren't reflected here, so the count
 *  can be slightly stale for the active canvas — acceptable for a confirmation warning. */
function countNodesUsing(accountId: string): number {
  return useProjects
    .getState()
    .projects.reduce(
      (sum, p) => sum + p.nodes.filter((n) => n.accountId === accountId).length,
      0
    )
}

export function AccountsSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const accounts = useSettings((s) => s.settings.claudeAccounts)
  const codexAccounts = useSettings((s) => s.settings.codexAccounts)
  const systemLabelSetting = useSettings((s) => s.settings.systemAccountLabel)
  const systemEmail = useSystemAccount((s) => s.email)
  useEffect(() => useSystemAccount.getState().ensure(), [])
  // The system row's own login state — the same honest "waiting for login…" line the managed rows
  // have. It lives in the store, not here: dispatching the switch closes the Settings overlay and
  // unmounts this section, so a component-local flag would die mid-flight, the poll would run on
  // orphaned, and a reopened Settings would re-enable the button and start a SECOND login + poll.
  // `startSwitch` is a process-wide singleton — a second click while one is in flight is a no-op.
  const systemWait = useSystemAccount((s) => s.switching)
  const systemCodexEmail = useSystemCodexAccount((s) => s.email)
  const remoteSystemCodexEmails = useSystemCodexAccount((s) => s.remoteEmails)
  useEffect(() => useSystemCodexAccount.getState().ensure(), [])
  const sshServers = useSshServers((s) => s.servers)
  useEffect(() => {
    void useSshServers.getState().hydrate?.()
  }, [])
  const activeProjectId = useProjects((s) => s.activeProjectId)
  const activeProject = useProjects((s) => s.projects.find((p) => p.id === activeProjectId))
  // The active project's SSH host key (`user@host`) when it is an SSH project. The local system
  // row's "Sign in / switch" is disabled there: it would be ambiguous between this machine's
  // ~/.claude and the host's, and the listener spawns locally regardless.
  const activeHostKey = activeProject?.ssh ? sshHostKey(activeProject.ssh.server) : undefined
  // Subscribe to live SSH connections so a remote machine's Add / Retry buttons enable and disable
  // as its host connects and disconnects while this panel is open.
  const sshByProject = useSshConn((s) => s.byProject)
  const [versionWarning, setVersionWarning] = useState(false)
  const [pendingRemove, setPendingRemove] = useState<ClaudeAccount | null>(null)
  const [pendingRemoveCodex, setPendingRemoveCodex] = useState<CodexAccount | null>(null)
  /**
   * Which Add button is mid-setup (`addKey(provider, host)`). Minting a REMOTE account is several
   * seconds of real work on the host — mkdir, hook/skill installs or the Codex runtime links, a CLI
   * probe — and until this state existed the button simply sat there, so the click read as
   * "nothing happened" until the login node appeared. One setup at a time, across providers.
   */
  const [adding, setAdding] = useState<string | null>(null)
  const [addErrors, setAddErrors] = useState<Record<string, string>>({})
  const [removeError, setRemoveError] = useState<string | null>(null)
  // Honest per-row login state so a Claude account never just "sits there": 'waiting' while a
  // capture poll is in flight, 'not-captured' when it timed out (offer Retry). Keyed by account id.
  const [loginWait, setLoginWait] = useState<Record<string, 'waiting' | 'not-captured'>>({})
  const setLoginWaitFor = (id: string, state: 'waiting' | 'not-captured' | null): void =>
    setLoginWait((m) => {
      if (state === null) {
        const { [id]: _drop, ...rest } = m
        return rest
      }
      return { ...m, [id]: state }
    })
  // "Link existing config dir…": the typed path, the in-flight guard, and the inline error.
  const [linkPath, setLinkPath] = useState('')
  const [linking, setLinking] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  // A surface whose bridge registers no folder picker (a relay tab, an older server) answers
  // E_UNSUPPORTED once — after that the button is hidden rather than offered and broken. Typing
  // the path still works, which is why Browse is a convenience and never the only way in.
  const [browseUnsupported, setBrowseUnsupported] = useState(false)
  /**
   * Config dirs SEEN running on this core that we have no account for — the one-click Link
   * candidates. A primitive selector so the settings page does not re-render on every hook event
   * of every node just to discover the same list again.
   */
  const detectedDirs = useAgentStatus((s) =>
    // NUL-joined, not newline-joined: a path may legally contain a newline, and splitting one back
    // into two rows would offer the user a dir that does not exist.
    unlinkedConfigDirs(s.byId, accounts).join('\u0000')
  )
  const detected = detectedDirs ? detectedDirs.split('\u0000') : []

  const setAddError = (key: string, message: string | null): void =>
    setAddErrors((errs) => {
      const next = { ...errs }
      if (message) next[key] = message
      else delete next[key]
      return next
    })

  // The open project whose SSH host matches a remote account. Undefined for local accounts, or when
  // no such project is open.
  const projectIdForHost = (host?: string): string | undefined => {
    if (!host) return undefined
    return useProjects.getState().projects.find((p) => p.ssh && sshHostKey(p.ssh.server) === host)?.id
  }

  // A remote account can only be created, logged into or deleted over a CONNECTED matching-host
  // project (live ControlMaster in useSshConn). Undefined ⇒ that host is not reachable right now,
  // and every remote action is disabled — never quietly run against this machine instead.
  const connectedProjectIdForHost = (host?: string): string | undefined => {
    if (!host) return undefined
    return useProjects
      .getState()
      .projects.find((p) => p.ssh && sshHostKey(p.ssh.server) === host && sshByProject[p.id])?.id
  }

  // ── The machines ─────────────────────────────────────────────────────────────────────────────
  // This machine first, then every saved SSH server unioned with the active project's own server
  // (deduped by host key). BOTH providers' accounts partition onto the same list, so a host's
  // Claude and Codex logins always sit in the same panel.
  const remoteTargets = codexRemoteTargets(sshServers, activeProject?.ssh?.server)
  const claudeGroups = groupAccountsByMachine(accounts, remoteTargets)
  const codexGroups = groupAccountsByMachine(codexAccounts, remoteTargets)
  const claudeStrays = strayAccounts(accounts, remoteTargets)
  const codexStrays = strayAccounts(codexAccounts, remoteTargets)
  // A saved server with nothing on it and no connection is a panel of two empty lists and two
  // disabled buttons — noise, once a user has saved a handful of servers. It appears as soon as it
  // is connected (the moment its buttons would work) or holds an account.
  const machines = claudeGroups
    .map((group, i) => ({ ...group, claude: group.accounts, codex: codexGroups[i].accounts }))
    .filter(
      (m) =>
        !m.remote ||
        m.claude.length > 0 ||
        m.codex.length > 0 ||
        !!connectedProjectIdForHost(m.host)
    )
  const hiddenMachines = claudeGroups.length - machines.length

  // Discover the system Codex identity of every CONNECTED remote target, once per host. A host with
  // no live connection is skipped (and never fabricated — its panel simply shows no system email).
  useEffect(() => {
    if (!isActive) return
    for (const [host] of remoteTargets) {
      const projectId = connectedProjectIdForHost(host)
      if (projectId) useSystemCodexAccount.getState().ensureRemote(host, projectId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, remoteTargets.map(([h]) => h).join('|'), sshByProject])

  // Reconcile LOCAL pending Codex accounts against their now-authenticated homes. A remote pending
  // account is resolved by its own login wait (and its Retry), which asks the HOST — the local
  // `identity` read would look in this machine's managed home and misattribute it.
  useEffect(() => {
    if (!isActive) return
    let cancelled = false
    let timer: number | undefined
    const reconcile = async (): Promise<void> => {
      const localPending = useSettings
        .getState()
        .settings.codexAccounts.filter((account) => account.pending && !account.host)
      if (localPending.length === 0) return
      const resolved = await discoverResolvedCodexAccounts(localPending, (id) =>
        window.nodeTerminal.codexAccounts.identity(id)
      )
      if (cancelled) return
      if (resolved.length > 0) {
        applyCodexAccounts((accs) => applyResolvedCodexAccounts(accs, resolved))
      }
      const stillPending = useSettings
        .getState()
        .settings.codexAccounts.some((account) => account.pending && !account.host)
      if (!cancelled && stillPending) timer = window.setTimeout(() => void reconcile(), 2000)
    }
    void reconcile()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [isActive, codexAccounts])

  // ── Claude ───────────────────────────────────────────────────────────────────────────────────
  // `labelEdited` marks this as a deliberate user rename, so the store's reconcile takes it even
  // when the typed label happens to equal the mint placeholder (see reconcileOwnedAccountList).
  const setLabel = (id: string, label: string): void =>
    applyAccounts((accs) => accs.map((a) => (a.id === id ? { ...a, label, labelEdited: true } : a)))

  const setColor = (id: string, color?: string): void =>
    applyAccounts((accs) => accs.map((a) => (a.id === id ? { ...a, color } : a)))

  /**
   * Flip `~/.claude/skills` sharing for one account (issue #643). The FILESYSTEM is reconciled
   * first and the flag is persisted only if that call came back — because the flag is what the
   * launch sweep replays, and a stored `true` whose links were never made would make the switch
   * lie until the next boot. A REFUSAL is likewise not a state to store: nothing happened, so the
   * switch stays where it was and the note says why.
   */
  const setSkillSharing = async (id: string, enabled: boolean): Promise<string | null> => {
    let res: ClaudeSkillShareResult
    try {
      res = await window.nodeTerminal.claudeAccounts.setSkillSharing(id, enabled)
    } catch (e) {
      if (isUnsupported(e)) return 'Sharing skills is not available on this connection.'
      throw e
    }
    if (!res.refused) {
      applyAccounts((accs) =>
        accs.map((a) => (a.id === id ? { ...a, shareSystemSkills: enabled } : a))
      )
    }
    return skillShareNote(res, enabled)
  }

  // Open a login terminal for an account and wait (up to ~5 min) for the CLI to write its
  // credentials; on success flip the row out of `pending` and adopt the captured email. A remote
  // account (`host` set) logs in on its host: the login node runs in remote tmux and waitLogin polls
  // the remote `.claude.json` over ssh (via the ctx `projectId`).
  //
  // Also the path a SETTLED account takes back when its OAuth credential expires or is revoked
  // ("Sign in again"). That caller MUST pass `openNode: 'always'`: capture is "`.claude.json` has
  // an oauthAccount", which an already-logged-in-then-expired dir satisfies immediately — so a
  // capture-first race resolves off the stale identity file, the `claude /login` node never
  // opens, and the button does visibly nothing. An earlier shape expressed this as `graceMs: 0`
  // on the race, which is NOT equivalent: a 0 ms timer still loses to a capture that resolves in
  // the same tick, and the race's `finally` then clears the timer — the exact silent no-op the
  // zero was meant to prevent. So 'always' opens the terminal synchronously, before the poll even
  // starts; the capture that lands right after only refreshes the email, and the row is never left
  // latched (`waiting` clears on either outcome).
  const runLogin = async (
    account: Pick<ClaudeAccount, 'id' | 'host'>,
    opts: { openNode: 'always' | 'after-grace' }
  ): Promise<void> => {
    const remote = !!account.host
    const projectId = remote ? connectedProjectIdForHost(account.host) : undefined
    // Carry `host` so Canvas resolves the ssh binding BY HOST (among connected projects), not from
    // whatever project happens to be active when the button fires.
    const loginDeps = {
      waitLogin: () =>
        window.nodeTerminal.claudeAccounts.waitLogin(
          account.id,
          projectId ? { projectId } : undefined
        ),
      dispatchLoginNode: () =>
        window.dispatchEvent(
          new CustomEvent('nodeterm:add-account-login', {
            detail: { accountId: account.id, remote, host: account.host }
          })
        )
    }
    setLoginWaitFor(account.id, 'waiting')
    // 'after-grace' is the pending-account Retry: race capture against the 5 s grace, so a dir
    // already logged in captures in <2 s and no junk `claude /login` node appears. 'always' is the
    // settled account's "Sign in again" and a fresh Add — see above.
    const captured = await (
      opts.openNode === 'always'
        ? openLoginNodeThenCapture(loginDeps)
        : raceLoginCapture({
            ...loginDeps,
            setTimer: (fn, ms) => window.setTimeout(fn, ms),
            clearTimer: (h) => window.clearTimeout(h as number)
          })
    )
      // A rejected wait (IPC failure) must land on the honest 'not captured' branch, not leave
      // the row latched on 'waiting for login…' with Retry disabled.
      .catch(() => null)
    if (!captured) {
      // timeout / cancel: row stays pending, offers Retry with an honest reason.
      setLoginWaitFor(account.id, 'not-captured')
      return
    }
    setLoginWaitFor(account.id, null)
    applyAccounts((accs) =>
      accs.map((a) => (a.id === account.id ? healedAccount(a, captured.email) : a))
    )
  }

  // `host` set → create the account dir + hook ON that SSH host (via the ctx projectId); the row
  // then lives in that host's panel and is only offered in that host's projects.
  //
  // The SHELL registers the row: `add()` appends it to settings inside the store's own chain and
  // resolves only once that is on disk. The mirror below is display state for THIS tab; the
  // snapshot save it schedules cannot add, drop or duplicate a row, nor change its `host`
  // (settings-store.ts reconciles `claudeAccounts` against its own membership, field by field), so
  // two tabs adding at once both keep their accounts.
  const onAddClaude = async (host?: string): Promise<void> => {
    if (adding) return // one setup at a time — the buttons are disabled, this is the guard
    const key = addKey('claude', host ?? '')
    const projectId = host ? connectedProjectIdForHost(host) : undefined
    if (host && !projectId) return
    setAdding(key)
    setAddError(key, null)
    let added: { id: string; versionSupported: boolean; account: ClaudeAccount }
    try {
      // `host` rides along for the one case the shell cannot name it itself; a local add ignores it.
      added = await window.nodeTerminal.claudeAccounts.add(
        projectId ? { projectId, host } : undefined
      )
    } catch (e) {
      // The remote path does not reject on a failed setup (it answers with an empty configDir and
      // lets the login node report the connection error), so reaching here means the call itself
      // never landed. E_UNSUPPORTED is its own sentence: a fact about the surface, not the account.
      setAddError(
        key,
        isUnsupported(e)
          ? 'Managed Claude accounts are not available on this surface — manage them from the desktop app or the Server Edition directly.'
          : host
            ? `Could not set up an account on ${host}. Is the project still connected?`
            : 'Could not set up the account.'
      )
      return
    } finally {
      // Cleared before the login wait below: `runLogin` resolves only when the user finishes
      // logging in (up to 5 minutes), and a spinner running that long would claim the setup is
      // still going when the thing to do next is on the canvas.
      setAdding(null)
    }
    // Non-blocking: the account still isolates config, but an old CLI's unscoped macOS keychain
    // service would collide across accounts — surface a dismissable warning.
    if (!added.versionSupported) setVersionWarning(true)
    const { account } = added
    applyAccounts((accs) => (accs.some((a) => a.id === account.id) ? accs : [...accs, account]))
    // Fresh Add: the dir was minted milliseconds ago, so a capture inside the grace is impossible —
    // open the login node immediately. Unconditionally, not via a 0 ms race: see `runLogin`.
    await runLogin(account, { openNode: 'always' })
  }

  /**
   * Adopt a config dir the user already owns (`~/.claude-2` and friends) as a real account: core
   * validates the path, reads its `.claude.json` for the signed-in email, and installs the managed
   * status hook into it. From then on the dir has an id, so env injection, the transcript jail, the
   * usage rows, the pickers and the node chip all treat it like any other account.
   *
   * `~` is expanded by CORE, not here: the renderer does not know the home dir of the machine that
   * owns the files (the Server Edition's browser is not the filesystem's host).
   */
  const onLink = async (dir: string): Promise<void> => {
    const path = dir.trim()
    if (!path || linking) return
    setLinking(true)
    setLinkError(null)
    try {
      const linked = await window.nodeTerminal.claudeAccounts.link(path)
      applyAccounts((accs) => [
        ...accs,
        {
          id: linked.id,
          // Named by its login when the dir is signed in; otherwise by the folder, which is how
          // the user thinks of it anyway ("the .claude-2 one"). Never a generated placeholder.
          label: linked.email ?? configDirLabel(linked.configDir),
          ...(linked.email ? { email: linked.email } : {}),
          // The NORMALIZED path core resolved, never the raw text typed here: it is re-validated
          // at every point of use, and the two must be the same string for the jail to match.
          configDir: linked.configDir,
          createdAt: Date.now()
        }
      ])
      setLinkPath('')
    } catch (e) {
      setLinkError(
        isUnsupported(e)
          ? 'Linking a config dir is not available on this surface — do it from the desktop app or the Server Edition directly.'
          : errorText(e, 'Could not link that config dir.')
      )
    } finally {
      setLinking(false)
    }
  }

  const onBrowse = async (): Promise<void> => {
    try {
      const folder = await window.nodeTerminal.dialog.selectFolder()
      if (folder) setLinkPath(folder)
    } catch (e) {
      if (isUnsupported(e)) setBrowseUnsupported(true)
      else setLinkError(errorText(e, 'Could not open the folder picker.'))
    }
  }

  const confirmRemove = async (account: ClaudeAccount): Promise<void> => {
    // Drop any stale login-wait row state for the removed id (a heal/Retry poll may still be
    // draining; its late resolution must not resurrect a row label for a dead account).
    setLoginWaitFor(account.id, null)
    setPendingRemove(null)
    setRemoveError(null)
    try {
      // Removing a pending account: stop the 5-minute waitLogin poll loop first.
      if (account.pending) await window.nodeTerminal.claudeAccounts.cancelWaitLogin(account.id)
      // The SHELL deletes the row (after the config dir, for a local account). A row carrying
      // `host` has its dir removed over ssh and the row dropped only once teardown on the host is
      // CONFIRMED — never locally, and never "forgotten" while its credential dir survives there —
      // so a disconnected host refuses and the row stays listed and retryable.
      const projectId = account.host
        ? (connectedProjectIdForHost(account.host) ?? projectIdForHost(account.host))
        : undefined
      await window.nodeTerminal.claudeAccounts.remove(
        account.id,
        projectId ? { projectId } : undefined
      )
    } catch (e) {
      setRemoveError(
        account.host
          ? `Couldn't remove "${account.label}" on ${account.host}. Reconnect the project and try again.`
          : errorText(e, `Couldn't remove "${account.label}".`)
      )
      return
    }
    applyAccounts((accs) => accs.filter((a) => a.id !== account.id))
    // Clear the account off serialized nodes (all projects) + any project default...
    useProjects.setState((s) => ({
      projects: s.projects.map((p) => ({
        ...p,
        ...(p.defaultAccountId === account.id ? { defaultAccountId: undefined } : {}),
        // The account's serialized login node is DROPPED, not kept account-less: respawned
        // without its env, its `claude /login` would run against the system ~/.claude and
        // overwrite the user's identity on completion. Other nodes just lose the accountId.
        nodes: p.nodes
          .filter((n) => !(n.accountId === account.id && isAccountLoginNode(n)))
          .map((n) => (n.accountId === account.id ? { ...n, accountId: undefined } : n))
      }))
    }))
    // ...and off the active project's LIVE nodes (Canvas listener patches React Flow).
    window.dispatchEvent(
      new CustomEvent('nodeterm:account-removed', { detail: { accountId: account.id } })
    )
  }

  const removeMessage = (a: ClaudeAccount): string => {
    const n = countNodesUsing(a.id)
    const fallout = `${n} node(s) currently use it and will fall back to the system account.`
    // A LINKED dir is the user's own folder — removing the account forgets the record and deletes
    // NOTHING (core refuses to `rm -rf` anything outside its own managed dirs). Saying "will be
    // deleted" here would be a lie that stops people unlinking.
    if (a.configDir) {
      return `Unlink account "${a.label}"? nodeterm forgets it — the folder ${a.configDir} keeps its login and transcripts exactly as they are. ${fallout}`
    }
    if (a.host && !connectedProjectIdForHost(a.host)) {
      // The shell drops a remote row only after CONFIRMED teardown on its host (no orphaned
      // credential), so without a connection the removal is refused and the row stays.
      return `Remove account "${a.label}"? ${a.host} is not connected, so the account cannot be removed yet — connect a project on that host first. Its login and transcripts stay on that host until then. ${fallout}`
    }
    return `Remove account "${a.label}"? Its logged-in credentials and all its Claude transcripts${
      a.host ? ` on ${a.host}` : ''
    } will be deleted. ${fallout}`
  }

  // ── Codex ────────────────────────────────────────────────────────────────────────────────────
  // See `setLabel`: mark a deliberate user rename so a placeholder-equal label survives reconcile.
  const setCodexLabel = (id: string, label: string): void =>
    applyCodexAccounts((accs) => accs.map((a) => (a.id === id ? { ...a, label, labelEdited: true } : a)))

  const setCodexColor = (id: string, color?: string): void =>
    applyCodexAccounts((accs) => accs.map((a) => (a.id === id ? { ...a, color } : a)))

  /** Open the account's `codex login` node (on its host for a remote one) and wait for the device
   *  login to land; on success the row leaves `pending` with the captured email. */
  const runCodexLogin = async (account: Pick<CodexAccount, 'id' | 'host'>): Promise<void> => {
    const remote = !!account.host
    const projectId = remote ? connectedProjectIdForHost(account.host) : undefined
    if (remote && !projectId) return
    window.dispatchEvent(
      new CustomEvent('nodeterm:add-codex-account-login', {
        detail: remote ? { accountId: account.id, remote, host: account.host } : { accountId: account.id }
      })
    )
    const captured = projectId
      ? await window.nodeTerminal.codexAccounts.waitLogin(account.id, { projectId })
      : await window.nodeTerminal.codexAccounts.waitLogin(account.id)
    if (captured) {
      applyCodexAccounts((accs) =>
        applyResolvedCodexAccounts(accs, [{ id: account.id, email: captured.email }])
      )
    }
  }

  // Add a managed Codex account on this machine or, with `host`, ON that connected SSH host: its
  // private CODEX_HOME is created there and the device login runs there, so the credential is
  // written on the machine that uses it and never travels.
  const onAddCodex = async (host?: string): Promise<void> => {
    if (adding) return
    const key = addKey('codex', host ?? '')
    const projectId = host ? connectedProjectIdForHost(host) : undefined
    if (host && !projectId) return
    setAdding(key)
    setAddError(key, null)
    let accountId: string
    try {
      const added = projectId
        ? await window.nodeTerminal.codexAccounts.add({ projectId })
        : await window.nodeTerminal.codexAccounts.add()
      accountId = added.id
      // The SHELL registers the row (pinned to `host` for an SSH add): `add()` appends it to
      // settings inside the store's own chain and resolves only once that is on disk, so the id is
      // already known to PtyManager (which reads live settings to decide the login pty's
      // `CODEX_HOME`) before the login node is asked for — no save barrier needed. The mirror below
      // is display state for THIS tab; the snapshot save it schedules cannot add, drop or duplicate
      // a row (settings-store.ts reconciles `codexAccounts` against its own membership).
      applyCodexAccounts((accs) =>
        accs.some((a) => a.id === added.account.id) ? accs : [...accs, added.account]
      )
    } catch (e) {
      // Without this the browser's E_UNSUPPORTED rejection was an UNHANDLED promise rejection: the
      // spinner stopped and nothing else happened, which reads as a dead button.
      setAddError(
        key,
        isUnsupported(e)
          ? 'Managed Codex accounts are not available in the browser yet — manage them from the desktop app.'
          : host
            ? errorText(e, `Could not set up a Codex account on ${host}.`)
            : 'Could not set up the Codex account.'
      )
      return
    } finally {
      setAdding(null)
    }
    await runCodexLogin({ id: accountId, host })
  }

  const confirmRemoveCodex = async (account: CodexAccount): Promise<void> => {
    setPendingRemoveCodex(null)
    setRemoveError(null)
    try {
      if (account.pending) await window.nodeTerminal.codexAccounts.cancelWaitLogin(account.id)
      // The SHELL deletes the row. Over a live connection a remote account's home is deleted ON its
      // host first; without one only the row goes (core's remove never touches a local home for a
      // row carrying `host`), which is the "only forgets it" the dialog promised.
      const projectId = account.host ? connectedProjectIdForHost(account.host) : undefined
      if (projectId) await window.nodeTerminal.codexAccounts.remove(account.id, { projectId })
      else await window.nodeTerminal.codexAccounts.remove(account.id)
    } catch (e) {
      // Local removal refuses while an account switch holds the account — say so, keep the row.
      setRemoveError(errorText(e, `Could not remove "${account.label}".`))
      return
    }
    applyCodexAccounts((accs) => accs.filter((a) => a.id !== account.id))
    useProjects.setState((s) => ({
      projects: s.projects.map((p) => ({
        ...p,
        nodes: p.nodes.map((n) => (n.accountId === account.id ? { ...n, accountId: undefined } : n))
      }))
    }))
  }

  const removeCodexMessage = (a: CodexAccount): string => {
    if (a.host && !connectedProjectIdForHost(a.host)) {
      return `Remove Codex account "${a.label}"? ${a.host} is not connected, so nodeterm only forgets it — its login and Codex home stay on that host.`
    }
    return `Remove Codex account "${a.label}"? Its logged-in credentials and its Codex home${
      a.host ? ` on ${a.host}` : ''
    } will be deleted.`
  }

  // ── Pi (THIS machine only) ───────────────────────────────────────────────────────────────────
  // Managed Pi accounts are local-only (`.claude/rules/agents-pi.md`): `piAccounts.add()` mints on
  // this machine, a pi binding is dropped on an SSH node, and the remote spawn skips the pi scope.
  // So Pi is the third provider of the LOCAL machine panel and never appears on a remote one.
  const piAccounts = useSettings((s) => s.settings.piAccounts)
  const [pendingRemovePi, setPendingRemovePi] = useState<PiAccount | null>(null)
  const [piRemoveError, setPiRemoveError] = useState<string | null>(null)

  // See `setLabel`: mark a deliberate user rename so a placeholder-equal label survives the
  // shell's own capture flip (see `healedPiAccount`).
  const setPiLabel = (id: string, label: string): void =>
    applyPiAccounts((accs) => accs.map((a) => (a.id === id ? { ...a, label, labelEdited: true } : a)))

  const setPiColor = (id: string, color?: string): void =>
    applyPiAccounts((accs) => accs.map((a) => (a.id === id ? { ...a, color } : a)))

  // ONE wait per pending row at a time (ids in flight), mirroring this tab's `healedPiAccount`
  // capture flip when it resolves. Shared by the add path, the reconcile effect below and the
  // Retry button, so none of them can start a second poll for a row that already has one. The
  // shell keeps a SET of waits per id anyway (a stray duplicate is harmless), this just keeps the
  // renderer from being the source of them.
  const piWaitsRef = useRef(new Set<string>())
  const waitPiLogin = useCallback(async (id: string): Promise<void> => {
    if (piWaitsRef.current.has(id)) return
    piWaitsRef.current.add(id)
    try {
      const captured = await window.nodeTerminal.piAccounts.waitLogin(id)
      if (captured) {
        applyPiAccounts((accs) =>
          accs.map((a) => (a.id === id ? healedPiAccount(a, captured.providers) : a))
        )
      }
    } catch {
      // Unsupported surface (relay tab) or a cancelled wait: the row simply stays pending.
    } finally {
      piWaitsRef.current.delete(id)
    }
  }, [])

  // Reconcile pending pi rows while the section is active — the pi twin of the Codex reconcile
  // effect above. A row is left `pending` when the 5-minute `waitLogin` timed out mid-OAuth or the
  // app restarted before the capture; `auth.json` may hold the login by now, but nothing else ever
  // calls `waitLogin` again, the add menu filters pending rows out, and the row's only action was
  // Remove. Re-arming the wait here resolves it the moment the file names a provider.
  useEffect(() => {
    if (!isActive) return
    for (const account of piAccounts) {
      if (account.pending) void waitPiLogin(account.id)
    }
  }, [isActive, piAccounts, waitPiLogin])

  // Retry login on a pending row: reopen the login terminal (the same event `onAddPi` fires) and
  // make sure a wait is armed for the capture.
  const retryPiLogin = (id: string): void => {
    window.dispatchEvent(new CustomEvent('nodeterm:add-pi-account-login', { detail: { accountId: id } }))
    void waitPiLogin(id)
  }

  // Add a managed pi account and open its login node (interactive `pi`, the user types /login
  // themselves — pi has no CLI login flag, unlike claude/codex). The SHELL registers the row
  // (`add()` appends it inside the store's own chain and resolves once that is on disk, so the id
  // is already known to pty-manager's PRE-FLIGHT 3 before the login node is asked for) and performs
  // the capture flip on its own row once `waitLogin` resolves — `SettingsStore.mutate` does not
  // push to the renderer, so the mirror (`healedPiAccount`) is what makes THIS tab's row agree.
  const onAddPi = async (): Promise<void> => {
    if (adding) return
    const key = addKey('pi', '')
    setAdding(key)
    setAddError(key, null)
    let accountId: string
    try {
      const added = await window.nodeTerminal.piAccounts.add()
      accountId = added.id
      applyPiAccounts((accs) =>
        accs.some((a) => a.id === added.account.id) ? accs : [...accs, added.account]
      )
    } catch (e) {
      setAddError(
        key,
        isUnsupported(e)
          ? 'Managed Pi accounts are not available on this surface — manage them from the desktop app or the Server Edition directly.'
          : 'Could not set up the Pi account.'
      )
      return
    } finally {
      // Cleared before the login wait, like the other providers: the wait can take minutes.
      setAdding(null)
    }
    window.dispatchEvent(
      new CustomEvent('nodeterm:add-pi-account-login', { detail: { accountId } })
    )
    await waitPiLogin(accountId)
  }

  const confirmRemovePi = async (account: PiAccount): Promise<void> => {
    setPendingRemovePi(null)
    setPiRemoveError(null)
    // The SHELL deletes the dir then the row (pi-accounts-service.ts `remove`); the filter below is
    // this tab's mirror, matching the Claude/Codex removal shape.
    try {
      if (account.pending) await window.nodeTerminal.piAccounts.cancelWaitLogin(account.id)
      await window.nodeTerminal.piAccounts.remove(account.id)
    } catch (e) {
      // The shell refused (settings lock timeout, a dir teardown failure, or the surface has no
      // pi-accounts channel at all). The dialog is already closed, so this line is the only thing
      // telling the user why the row is still there — and it IS still there: the credential dir
      // survives, so the mirrors below must not pretend the account is gone.
      setPiRemoveError(
        isUnsupported(e)
          ? 'Managed Pi accounts are not available on this surface — remove it from the desktop app or the Server Edition directly.'
          : `Couldn't remove "${account.label}".`
      )
      return
    }
    applyPiAccounts((accs) => accs.filter((a) => a.id !== account.id))
    useProjects.setState((s) => ({
      projects: s.projects.map((p) => ({
        ...p,
        nodes: p.nodes
          // The login node is DROPPED, not left account-less: respawned without its env, its
          // bare `pi` would start under the SYSTEM agent dir — the same hazard `isAccountLoginNode`
          // guards for Claude. Other nodes just lose the accountId.
          .filter((n) => !(n.accountId === account.id && isPiAccountLoginNode(n)))
          .map((n) => (n.accountId === account.id ? { ...n, accountId: undefined } : n))
      }))
    }))
    window.dispatchEvent(
      new CustomEvent('nodeterm:account-removed', { detail: { accountId: account.id } })
    )
  }

  // ── Rows ─────────────────────────────────────────────────────────────────────────────────────
  const machineLabelFor = (host?: string): string | undefined =>
    host ? sshServers.find((entry) => sshHostKey(entry) === host)?.label : undefined

  /** The Retry-login button both providers show on a pending row; a remote one needs its host. */
  const retryButton = (host: string | undefined, onRetry: () => void): React.JSX.Element => {
    const blocked = !!host && !connectedProjectIdForHost(host)
    return (
      <Button
        disabled={blocked}
        title={blocked ? `Connect to ${host} to finish logging in` : undefined}
        onClick={onRetry}
      >
        Retry login
      </Button>
    )
  }

  const claudeRow = (account: ClaudeAccount, showHost: boolean): React.JSX.Element => {
    const presented = presentAccount({
      label: account.label,
      email: account.email,
      host: account.host,
      machineLabel: machineLabelFor(account.host),
      linked: !!account.configDir,
      configDir: account.configDir
    })
    return (
      <ManagedAccountRow
        key={account.id}
        label={account.label}
        placeholder="Account label"
        onLabel={(v) => setLabel(account.id, v)}
        pending={account.pending}
        email={account.email}
        color={account.color}
        onColor={(c) => setColor(account.id, c)}
        pills={
          <>
            {/* A LINKED account: the user's own dir, adopted rather than minted. The path is the
                identifying fact, so it rides the tooltip — through `presentAccount`, so this row
                says the same thing every other account surface would. */}
            {account.configDir ? (
              <span
                className="rounded-full bg-fill-weak px-2 py-0.5 text-[11px] font-medium text-muted"
                title={presented.tooltip}
              >
                {presented.provenance}
              </span>
            ) : null}
            {showHost && account.host ? (
              <span
                className="rounded-full bg-[color:var(--accent)]/15 px-2 py-0.5 text-[11px] font-medium text-[color:var(--accent)]"
                title={`Remote account on ${account.host}`}
              >
                {account.host}
              </span>
            ) : null}
            {/* Progress and outcome are NOT gated on `pending`: a SETTLED account signs in
                through the same machinery ("Sign in again"), and gating these on `pending` would
                leave that row silent for the whole capture window and silent again on failure. */}
            {loginWait[account.id] === 'waiting' ? (
              <span className="inline-flex items-center gap-1.5 text-[12px] text-muted">
                <span className="ui-spinner" aria-hidden />
                waiting for login…
              </span>
            ) : null}
            {loginWait[account.id] === 'not-captured' ? (
              <span className="text-[12px] text-[color:var(--warn)]">login not captured</span>
            ) : null}
          </>
        }
        extra={
          <SkillSharingRow account={account} onChange={(v) => setSkillSharing(account.id, v)} />
        }
        actions={
          <>
            {(() => {
              // A remote account can only log in on a connected matching-host project; without
              // one, the button is disabled (a local spawn would log into the system account).
              const blocked = !!account.host && !connectedProjectIdForHost(account.host)
              const waiting = loginWait[account.id] === 'waiting'
              return (
                <Button
                  disabled={blocked || waiting}
                  title={
                    blocked
                      ? `Connect to ${account.host} to finish logging in`
                      : account.pending
                        ? undefined
                        : 'Opens `claude /login` in a terminal for this account. Use it when its ' +
                          'credential has expired or was revoked — the account keeps its config ' +
                          'dir, transcripts, colour and every node bound to it.'
                  }
                  onClick={() =>
                    void runLogin(account, { openNode: account.pending ? 'after-grace' : 'always' })
                  }
                >
                  {account.pending ? 'Retry login' : 'Sign in again'}
                </Button>
              )
            })()}
            <Button
              variant="ghost"
              // "Unlink" for a linked dir: the action really is different (the folder stays), and
              // the label is what a screen reader and the tests both go by.
              aria-label={account.configDir ? 'Unlink account' : 'Remove account'}
              onClick={() => setPendingRemove(account)}
            >
              <IconClose />
            </Button>
          </>
        }
      />
    )
  }

  const codexRow = (account: CodexAccount, showHost: boolean): React.JSX.Element => {
    // The SAME fail-closed gate the create/switch UI uses (§5 Property 4): an account that is
    // unsafe, missing, or a remote account with no live connection is not operable.
    const selectable = codexAccountSelectable(account.id, codexAccounts, (host) =>
      connectedProjectIdForHost(host)
    )
    const blockedReason = selectable.ok
      ? undefined
      : selectable.reason === 'no-connection'
        ? `Connect to ${account.host} to use this account`
        : 'This account is unavailable'
    return (
      <ManagedAccountRow
        key={account.id}
        label={account.label}
        placeholder="Codex account label"
        onLabel={(v) => setCodexLabel(account.id, v)}
        pending={account.pending}
        email={account.email}
        color={account.color}
        onColor={(c) => setCodexColor(account.id, c)}
        blockedReason={account.pending ? undefined : blockedReason}
        pills={
          showHost && account.host ? (
            <span
              className="rounded-full bg-[color:var(--accent)]/15 px-2 py-0.5 text-[11px] font-medium text-[color:var(--accent)]"
              title={`Remote account on ${account.host}`}
            >
              {account.host}
            </span>
          ) : null
        }
        actions={
          <>
            {account.pending ? retryButton(account.host, () => void runCodexLogin(account)) : null}
            <Button
              variant="ghost"
              aria-label="Remove Codex account"
              onClick={() => setPendingRemoveCodex(account)}
            >
              <IconClose />
            </Button>
          </>
        }
      />
    )
  }

  const piRow = (account: PiAccount): React.JSX.Element => (
    // pi's OAuth credential carries no email, so a captured row is identified by its logged-in
    // provider list (its label after `healedPiAccount`) instead.
    <ManagedAccountRow
      key={account.id}
      label={account.label}
      placeholder="Pi account label"
      onLabel={(v) => setPiLabel(account.id, v)}
      pending={account.pending}
      email={account.email}
      color={account.color}
      onColor={(c) => setPiColor(account.id, c)}
      actions={
        <>
          {account.pending ? retryButton(undefined, () => retryPiLogin(account.id)) : null}
          <Button
            variant="ghost"
            aria-label="Remove Pi account"
            onClick={() => setPendingRemovePi(account)}
          >
            <IconClose />
          </Button>
        </>
      }
    />
  )

  /** A provider's Add button on one machine: local always, remote only over a live connection. */
  const addButton = (provider: Provider, host: string): React.JSX.Element => {
    const key = addKey(provider, host)
    const where = host || thisMachine()
    const reachable = !host || !!connectedProjectIdForHost(host)
    const text =
      provider === 'claude'
        ? 'Add Claude account'
        : provider === 'codex'
          ? 'Add Codex account'
          : 'Add Pi account'
    return (
      <Button
        variant="primary"
        disabled={adding !== null || !reachable}
        title={reachable ? undefined : `Connect to ${host} to add an account there`}
        onClick={() =>
          void (provider === 'claude'
            ? onAddClaude(host || undefined)
            : provider === 'codex'
              ? onAddCodex(host || undefined)
              : onAddPi())
        }
      >
        {adding === key ? (
          <span className="inline-flex items-center gap-2">
            <span className="ui-spinner" aria-hidden />
            Setting up on {where}…
          </span>
        ) : (
          text
        )}
      </Button>
    )
  }

  /** What the spinner is waiting for — a remote setup takes long enough that silence reads as a
   *  broken button. */
  const progressFor = (provider: Provider, host: string): string | null => {
    if (adding !== addKey(provider, host)) return null
    if (provider === 'pi') {
      return 'Creating the agent dir and installing the status extension. A login terminal opens next — type /login once pi starts and pick a provider.'
    }
    if (!host) return 'Creating the account directory and installing the status hook…'
    return provider === 'claude'
      ? `Creating the config dir on ${host} and installing the status hook and agent skills over SSH — this takes a few seconds. The login terminal opens when it's ready.`
      : `Creating the Codex home on ${host} over SSH — the login terminal opens when it's ready.`
  }

  const linkExisting = (
    // LINK an existing config dir. The other half of "several Claude logins": a user who already
    // keeps `~/.claude-2` and drives it from their own shell function does not want a new managed
    // dir — they want THIS one to have an id. Local only: a linked dir is a path on the machine that
    // owns the files. Folded away by default: it is the rarer way in, and the Add button is the
    // common one.
    <details className="rounded-md border border-border/60 p-2" open={!!linkPath || !!linkError}>
      <summary className="cursor-pointer text-[12px] font-medium text-text">
        Link an existing config dir…
      </summary>
      <div className="space-y-2 pt-2">
        <p className="text-[12px] leading-relaxed text-muted">
          Already have a second login in its own folder (say <code>~/.claude-2</code>)? Link it and
          nodeterm will label its terminals, read its transcripts, and offer it in the add menus.
          Nothing is copied or moved, and unlinking later leaves the folder alone.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="w-72"
            placeholder="~/.claude-2"
            value={linkPath}
            onChange={(e) => setLinkPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onLink(linkPath)
            }}
          />
          {browseUnsupported ? null : (
            <Button disabled={linking} onClick={() => void onBrowse()}>
              Browse…
            </Button>
          )}
          <Button
            variant="primary"
            // Named: the detected list repeats the word "Link" once per row, and a bare label
            // leaves both the user's screen reader and the tests guessing which.
            aria-label="Link config dir"
            disabled={linking || !linkPath.trim()}
            onClick={() => void onLink(linkPath)}
          >
            {linking ? (
              <span className="inline-flex items-center gap-2">
                <span className="ui-spinner" aria-hidden />
                Linking…
              </span>
            ) : (
              'Link'
            )}
          </Button>
        </div>
        {linkError ? <p className="text-[12px] text-[color:var(--danger)]">{linkError}</p> : null}
      </div>
    </details>
  )

  // DETECTED dirs: config dirs whose sessions actually posted hooks here and that we have no
  // account for. Derived from observations only — nothing on disk is read for an unlinked dir (a
  // forged POST must not make us stat anything), so the path is all that is shown. Shown OUTSIDE
  // the fold: it is a suggestion about a login the user is demonstrably using.
  const detectedBlock =
    detected.length > 0 ? (
      <div className="space-y-2 rounded-md border border-dashed border-border/60 p-2">
        <div className="text-[12px] font-medium text-text">Detected config dirs</div>
        {detected.map((dir) => (
          <div key={dir} className="flex items-center justify-between gap-3">
            <span className="min-w-0 flex-1 truncate text-[12px] text-muted" title={dir}>
              {dir}
            </span>
            <Button aria-label={`Link ${dir}`} disabled={linking} onClick={() => void onLink(dir)}>
              Link
            </Button>
          </div>
        ))}
      </div>
    ) : null

  return (
    <SettingsSection
      id="accounts"
      title="Accounts"
      description="Separate Claude, Codex and Pi logins, grouped by the machine they live on (Pi accounts are local to this machine). Each account has its own login, settings and history; pick one when you open an agent, or move a running node to another from its right-click menu."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.accounts}>
        <div className="space-y-4">
          {versionWarning ? (
            <div className="flex items-start justify-between gap-3 rounded-md border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/10 px-3 py-2 text-[13px] leading-relaxed text-[color:var(--danger)]">
              <span>
                Your installed Claude CLI is older than the version that scopes credentials per
                config dir. Accounts still isolate their config, but on macOS logins may collide in
                the shared keychain. Update the Claude CLI to keep them fully separate.
              </span>
              <button
                className="shrink-0 cursor-pointer text-muted hover:text-text"
                onClick={() => setVersionWarning(false)}
              >
                Dismiss
              </button>
            </div>
          ) : null}
          {removeError ? (
            <p className="text-[12px] text-[color:var(--danger)]">{removeError}</p>
          ) : null}

          {machines.map((m) => {
            const host = m.host // '' = this machine
            const connected = !m.remote || !!connectedProjectIdForHost(host)
            const codexSystemEmail = m.remote ? (remoteSystemCodexEmails[host] ?? null) : systemCodexEmail
            return (
              <MachinePanel
                key={host || 'local'}
                label={m.remote ? (m.server?.label ?? host) : thisMachineCap()}
                remote={m.remote}
                hostKey={host || undefined}
                connected={connected}
              >
                <ProviderBlock
                  agentId="claude"
                  title="Claude"
                  action={addButton('claude', host)}
                  progress={progressFor('claude', host)}
                  error={addErrors[addKey('claude', host)]}
                >
                  <SystemAccountRow
                    name={
                      m.remote ? (
                        <span className="text-[13px] text-text">System account</span>
                      ) : (
                        // The local SYSTEM account is implicit (no ClaudeAccount record) but gets
                        // a renamable display label (empty = default) so pickers tell it apart.
                        <Input
                          className="w-56"
                          placeholder="System account"
                          value={systemLabelSetting}
                          onChange={(e) =>
                            useSettings.getState().update({ systemAccountLabel: e.target.value })
                          }
                        />
                      )
                    }
                    detail={m.remote ? `~/.claude on ${host}` : systemEmail}
                    action={
                      m.remote ? undefined : (
                        <>
                          {systemWait ? (
                            <span className="inline-flex items-center gap-1.5 text-[12px] text-muted">
                              <span className="ui-spinner" aria-hidden />
                              waiting for login…
                            </span>
                          ) : null}
                          {/* Same affordance as a managed row's "Sign in again", so the system
                              account is not the one login that has to happen somewhere else. LOCAL
                              only: inside an SSH project "switch account" would be ambiguous between
                              this machine's ~/.claude and the host's, and the listener spawns
                              locally regardless. */}
                          <Button
                            disabled={systemWait || !!activeHostKey}
                            title={
                              activeHostKey
                                ? `Switch the system account from a project on ${thisMachine()} — this row is ${thisMachine()}'s ~/.claude, not ${activeHostKey}'s`
                                : 'Opens `claude /login` in a terminal for the system account (~/.claude). ' +
                                  'Completing it switches the org/account every node without a managed account ' +
                                  'uses — running sessions carry on under the new one. Managed accounts keep ' +
                                  'their own logins.'
                            }
                            onClick={() => void useSystemAccount.getState().startSwitch()}
                          >
                            {systemEmail ? 'Sign in / switch' : 'Sign in'}
                          </Button>
                        </>
                      )
                    }
                  />
                  {m.claude.map((a) => claudeRow(a, false))}
                  {!m.remote ? (
                    <>
                      {detectedBlock}
                      {linkExisting}
                    </>
                  ) : null}
                </ProviderBlock>
                <div className="border-t border-border/60" aria-hidden />
                <ProviderBlock
                  agentId="codex"
                  title="Codex"
                  action={addButton('codex', host)}
                  progress={progressFor('codex', host)}
                  error={addErrors[addKey('codex', host)]}
                >
                  <SystemAccountRow
                    name={<span className="text-[13px] text-text">System account</span>}
                    detail={codexSystemEmail ?? (m.remote ? `~/.codex on ${host}` : '~/.codex')}
                  />
                  {m.codex.map((a) => codexRow(a, false))}
                </ProviderBlock>
                {!m.remote ? (
                  <>
                    <div className="border-t border-border/60" aria-hidden />
                    {/* Pi: this machine only (managed Pi accounts are local-only). pi's system
                        login is `~/.pi/agent`; a fresh account is a pending row plus a canvas
                        login node running interactive `pi` under its PI_CODING_AGENT_DIR. */}
                    <ProviderBlock
                      agentId="pi"
                      title="Pi"
                      action={addButton('pi', '')}
                      progress={progressFor('pi', '')}
                      error={addErrors[addKey('pi', '')] ?? piRemoveError}
                    >
                      <SystemAccountRow
                        name={<span className="text-[13px] text-text">System account</span>}
                        detail="~/.pi/agent"
                      />
                      {piAccounts.map((a) => piRow(a))}
                      {/* Shown BEFORE anyone picks a provider in /login (agents-pi rule): the
                          Anthropic case is billed differently from what a Claude Pro/Max subscriber
                          would assume. */}
                      <p className="text-[12px] leading-relaxed text-muted" data-testid="pi-billing-note">
                        Billing: a Claude Pro/Max login in Pi is billed by Anthropic as third-party
                        extra usage, per token, not against your plan limits. A ChatGPT Plus/Pro
                        login (openai-codex) uses your plan.
                      </p>
                    </ProviderBlock>
                  </>
                ) : null}
              </MachinePanel>
            )
          })}

          {claudeStrays.length + codexStrays.length > 0 ? (
            <div className="space-y-2 rounded-md border border-[color:var(--warn)]/40 p-3">
              <p className="text-[12px] font-medium text-[color:var(--warn)]">
                Accounts on machines you no longer have saved
              </p>
              {claudeStrays.map((a) => claudeRow(a, true))}
              {codexStrays.map((a) => codexRow(a, true))}
            </div>
          ) : null}

          <p className="text-[12px] leading-relaxed text-muted">
            An account on an SSH host is created, logged into and removed ON that host — its
            credentials never leave it — and is only offered in that host&apos;s projects.
            {hiddenMachines > 0
              ? ` ${hiddenMachines} saved SSH ${hiddenMachines === 1 ? 'server has' : 'servers have'} no accounts yet and ${hiddenMachines === 1 ? 'appears' : 'appear'} here once connected.`
              : ''}{' '}
            A node color applies to nodes opened under that account from then on.
          </p>
        </div>
      </SearchableRow>

      {pendingRemove ? (
        <ConfirmDialog
          message={removeMessage(pendingRemove)}
          confirmLabel={pendingRemove.configDir ? 'Unlink' : 'Remove'}
          onConfirm={() => void confirmRemove(pendingRemove)}
          onCancel={() => setPendingRemove(null)}
        />
      ) : null}
      {pendingRemoveCodex ? (
        <ConfirmDialog
          message={removeCodexMessage(pendingRemoveCodex)}
          confirmLabel="Remove"
          onConfirm={() => void confirmRemoveCodex(pendingRemoveCodex)}
          onCancel={() => setPendingRemoveCodex(null)}
        />
      ) : null}
      {pendingRemovePi ? (
        <ConfirmDialog
          message={`Remove Pi account "${pendingRemovePi.label}"? Its logged-in credentials, sessions and agent dir will be deleted.`}
          confirmLabel="Remove"
          onConfirm={() => void confirmRemovePi(pendingRemovePi)}
          onCancel={() => setPendingRemovePi(null)}
        />
      ) : null}
    </SettingsSection>
  )
}
