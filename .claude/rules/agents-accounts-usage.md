---
paths:
  - "src/core/claude-accounts-*.ts"
  - "src/core/codex-accounts-core.ts"
  - "src/core/codex-config-dir.ts"
  - "src/core/codex-identity-*.ts"
  - "src/core/claude-session-copy.ts"
  - "src/core/remote-claude-session-copy.ts"
  - "src/core/usage/**"
  - "src/core/pty-manager.ts"
  - "src/main/claude-accounts.ts"
  - "src/main/claude-usage.ts"
  - "src/main/codex-accounts.ts"
  - "src/renderer/canvas/claude-account-switch.ts"
  - "src/renderer/lib/usageScope.ts"
  - "src/renderer/components/UsageIndicator.tsx"
  - "src/renderer/state/systemAccount.ts"
  - "src/renderer/state/codexAccountReconcile.ts"
  - "src/renderer/state/systemCodexAccount.ts"
  - "src/shared/agents/account-*.ts"
  - "src/renderer/components/settings/sections/AccountsSection*.tsx"
  - "src/core/remote-account-env*.ts"
---
# Managed Claude/Codex accounts, account switch, usage indicator scope, remote usage

> Moved verbatim from the root `CLAUDE.md` on 2026-09-01 (see its "How this documentation is
> organized" section). Loads automatically when a file matching the `paths` above is read;
> when the root routing table points here, read this file before touching the subsystem.
<!-- moved-verbatim-from: CLAUDE.md -->

- **Managed Pi accounts** (2026-09, `core/pi-accounts-*.ts`, `core/pi-config-dir.ts`) follow the
  Claude model below one-for-one, with pi as the third provider: an account is
  `<userData>/pi-accounts/<id>` used as `PI_CODING_AGENT_DIR` (spawn env + tmux `-e`; the name rides
  `ACCOUNT_SCOPE_UPDATE_ENV`, pinned against a real tmux in `pi-account-env.realtmux.test.ts`), pi
  owns login/storage/refresh in that dir, logged in = `auth.json` holds at least one provider, row
  membership is the shell's (`SettingsStore.mutate`), and the status extension plus both canvas
  skills are installed into every account dir. `ACCOUNT_CAPABLE_AGENT_IDS` includes `pi`, so
  `boundAccountId` / `agentAccountColor` / `inheritableAccountId` (its `isPiAccount` resolver) answer
  for it; the headless factory now asks that shared rule instead of hard-coding claude||codex. Pi
  does NOT reuse Claude/Codex logins (a copied refresh token would rotate out from under the other
  CLI). Local-only in v1: an SSH Pi node runs the host's system pi. Mobile mirror: no pi account
  block yet. Details: `docs/pi-agent.md` §4, `.claude/rules/agents-pi.md`.
- **Managed Claude accounts** (Claude-only) — run several logged-in Claude identities side by
  side by giving each its own config dir. `settings.claudeAccounts` is a list of `ClaudeAccount
  {id, label, email?, host?, pending?, createdAt}` (in `settings.json`; the account **list** is
  config, not credentials). Isolation is **config-dir**, not token storage: a local account's dir
  is `{userData}/claude-accounts/<id>` (`claudeConfigDirFor` / pure `accountConfigDir`),
  a **remote** account's is `~/.nodeterm/claude-accounts/<id>` on its `host` (keyed by
  `sshHostKey` = `user@host`; `remoteAccountConfigDir` is `~`-relative for ssh expansion,
  `remoteAccountConfigDirAbs` resolves it against the connection's `remoteHome`). The **claude
  CLI owns login, credential storage, and token refresh** inside that dir — the app NEVER writes
  credentials. On macOS this works because Claude Code **≥ 2.1** scopes its Keychain service per
  config dir (`Claude Code-credentials-<sha256(configDir)[:8]>`, `claudeKeychainService`); on
  < 2.1 one unscoped service is shared → accounts collide, so add-account **warns** (`claude
  --version`, `isSupportedClaudeVersion`).
  - **`data.accountId` (terminal nodes)** — resolved **once at node creation**
    (`resolveNewNodeAccount`: explicit submenu pick → `project.defaultAccountId` → system default
    `~/.claude`), then **persisted** (serializers) and changed ONLY by an explicit **account switch**
    (below). `undefined` = system default
    = **bit-for-bit legacy behavior** (no env touched). Inherited by **Branch** (the
    terminal→chat fork it also fed is gone — the SDK chat node was removed 2026-07). Two #419
    rules inside the resolver: the submenu's **System row passes `null`** (an EXPLICIT system
    pick that skips the project default — before that, the row wearing the system email launched
    the project-default account), and validation runs against `accountsForProject`, not the raw
    list, so a **pending** account or one **pinned to another machine's host** is never stamped
    onto a node it cannot run on (both used to reach the missing-dir fallback at spawn).
  - **Switch Claude account (running node)** — node right-click → *Switch Claude
    account ▸* moves the conversation onto another account **already logged in** on this machine,
    with no `/login` in the pane. It works because a transcript carries **no account identity**
    (measured on 2.1.280: under a config dir lacking the file `--resume` says "No conversation found";
    with the file copied into `<configDir>/projects/<encoded cwd>/<id>.jsonl` only the login is
    missing). Choreography = "Restart agent and shell" with a `beforeRecycle` step
    (`agent-restart.ts`): exit the CLI (refused while working/blocked) → core
    `claudeAccounts.copySession` (`core/claude-session-copy.ts`) → rebind `accountId` → recycle, whose
    respawn gets the new `CLAUDE_CONFIG_DIR` and whose cold restore resumes the same id. Two rules:
    the copy runs **after** the exit, so the source is final and a target that is a byte-**prefix**
    of it is just an older copy (A→B→A) and may be replaced, while a **diverged** target is never
    overwritten; and the rebind is **returned** by `beforeRecycle` and merged into the closure's own
    `updateNodeData`, never set by a separate Canvas `setNodes` in the same tick (React Flow's update
    queue rebuilds the node from the store's copy and can drop it). Builtin `claude` only (the
    `boundAccountId` rule below). **SSH nodes** switch between the accounts pinned to THEIR host (and
    the host's own `~/.claude`): the copy runs ON the host as one generated `sh` script over the
    project's master (`core/remote-claude-session-copy.ts`, tested under a real `/bin/sh`; same
    prefix/diverged rule, via `head -c | cmp`), and `SshProjectManager.remoteClaudeSessionCopy`
    refuses an account pinned to another host. An SSH ctx with no remote leg (Server Edition) is
    refused, never answered from the local disk. Relay tabs: shown disabled.
    **Two more surfaces, one choreography** (`runClaudeAccountSwitch` returns a
    `ClaudeSwitchOutcome` instead of announcing it): the **kanban card** right-click menu gets the
    node's rows from the SAME builder the canvas node menu uses (`accountSwitchRows` → KanbanView's
    `accountMenuItems`), and the **usage popover** puts "⇄ Move N sessions" on each account row —
    every Claude session on this canvas running on that account, on the popover's machine
    (`bulkSwitchCandidates`), is moved to the picked account ONE AT A TIME (N parallel copies +
    recycles on one host is a load spike), busy ones skipped and counted, one summary line
    (`summarizeBulkSwitch`). The cross-project board (GlobalKanbanView) does not offer it:
    its cards belong to other projects' canvases, whose nodes have no restart closure mounted.
  - **`boundAccountId(accountId, agentId)` (`shared/agents/account-binding.ts`) is the ONE rule for
    whether a node is account-bound at all**, and it feeds `data.accountId` *and* the account color
    from a single decision — split them and a node carries an account it is not painted for, or is
    painted for one it does not carry. Two surfaces mint nodes and both ask it: `createAgentNode`
    (canvas) and `appendProjectNode` (the phone's `projects.registerNode`, which used to write
    whatever the wire sent, so a gemini node could come back bound to a Claude account). Managed
    accounts belong to the builtin **claude and codex** (S6); a **known** other agent — builtin or
    custom, since a custom agent inheriting one of those harnesses is still its own agent — never
    binds. **An UNSTATED agent keeps its binding** — the asymmetry is deliberate: the phone chooses
    `agentId` and `accountId` independently and is not known to always send the first
    (docs/ios-protocol-migration.md §6), dropping a real binding is the wrong-identity bug the
    field exists to prevent, while a stray one on an agent-less node only sets a config-home
    variable nothing reads. On the canvas `agentId` is always stated, so that path is bit-for-bit
    what it was. `main` resolves the color off the RAW id and lets the registrar refuse it, rather
    than re-deriving the gate at the call site.
  - **Account default node color (`ClaudeAccount.color` / `CodexAccount.color`, optional)** — a
    per-account default node color (Settings → Accounts) that beats the agent's own brand color in
    `createAgentNode`, so a second login is recognizable on the canvas. Read off the SAME
    `boundAccountId` that stamps `data.accountId`, so the color and the binding cannot drift.
    Applied **at creation** and baked into `data.color` like any other node color: a hand-picked
    node color is never overwritten and editing the account later repaints nothing. Unset / stale
    id / an agent that takes no managed account ⇒ the agent's color, unchanged.
    **Which list answers is `agentAccountColor`'s alone** (`shared/agents/account-color.ts`, one
    definition shared by `createAgentNode` and the phone-registered node path in `src/main`):
    claude reads `claudeAccounts`, codex reads `codexAccounts`, everything else reads nothing. The
    two lists are keyed **independently** — nothing stops the same id appearing in both — so a node
    colored from the other list would be repainted from a stranger's row; the swatch UI is one
    component (`AccountColorSwatches`) rendered by both row kinds for the same reason.
    The value is **re-validated as a string** at the read: the account lists come out of a
    hand-editable settings.json that nothing checks field-by-field on load, and a `"color": 123`
    would throw on `.trim()` INSIDE `createAgentNode` — stopping every new node under that account
    from opening, with nothing pointing back at the edited file.
  - **The LAUNCHING agent session's identity never reaches a pane** (`AGENT_SESSION_ENV_STRIP`,
    2026-08-28). `buildPtyEnv` spreads `{ ...process.env }`, so a nodeterm started from inside a
    Claude Code session (`open -a nodeterm` from an agent's shell, a canvas terminal launching a
    second instance) handed EVERY pane the parent session's markers. `CLAUDE_CODE_CHILD_SESSION` is
    the one that bites: the child claude disables transcript persistence, and this app reads that
    transcript for the context meter, session-name adoption, the ⌘M view and the find-bar's
    transcript index — so all four die **silently** on a session that looks perfectly healthy.
    `CLAUDE_CODE_MESSAGING_TOKEN` + its socket are a bearer for the parent's IPC, readable from any
    pane. [MEASURED: 9 of 14 live sessions carried them; the nodes that still had a meter were
    exactly those whose tmux session predated the polluted launch.] It is a **deny-list, never a
    `CLAUDE_CODE_*` prefix sweep** — that prefix also carries real user config
    (`USE_BEDROCK`, `USE_VERTEX`, `MAX_OUTPUT_TOKENS`, and `OAUTH_TOKEN`, which belongs to
    `AUTH_ENV_STRIP`'s managed-account rules); sweeping it breaks a Bedrock user's terminals to fix
    a marker. The names ALSO ride `ACCOUNT_SCOPE_UPDATE_ENV` for the same reason the account names
    do: deleting them from the client env never touches the global env of a tmux server a polluted
    client already started.
  - **Env injection** — `pty-manager` sets `CLAUDE_CONFIG_DIR` in the spawn env AND as a tmux `-e`
    (local); for a remote node it emits an **absolute-path** remote tmux `-e` built from the
    connection-cached `remoteHome` (skipped **fail-open** if home is unresolved). `AUTH_ENV_STRIP`
    (`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN`) is deleted from the
    child env so a stray env key can't shadow the account. A **missing** account dir → warn +
    silent system fallback. **The account-scope names ride the LOCAL conf's `update-environment`
    (`ACCOUNT_SCOPE_UPDATE_ENV`, issue #419)** — the shared tmux server inherits the env of the
    client that STARTS it, so a server started by a managed-account node used to leak that
    account's `CLAUDE_CONFIG_DIR` (and any un-stripped auth key) into every session created
    without a `-e` override: system nodes, plain terminals and the missing-dir fallback silently
    ran as that account ("the system account is entangled with the next account in the list").
    Listing the names makes tmux copy each from the creating client's env and **strip it when the
    client lacks it** (proven against a real tmux in `account-env.realtmux.test.ts`, seeded-server
    case included; `ensureUpdateEnvKeys` retrofits a long-lived pre-fix server). The same listing
    is what makes codex's explicit system-scope overwrite (`CODEX_HOME` /
    `NODETERM_CODEX_ACCOUNT_ID`) actually reach sessions on a shared server. **LOCAL conf only**
    — the remote conf must NOT get these names: a remote attach client's env is the login
    shell's, and the copy/strip would run against that wrong environment (pinned in
    `ssh.test.ts`).
  - **The system account is a normal row in Settings → Accounts (2026-09-17).** It carries the
    same login affordance as a managed row ("Sign in / switch"), dispatching the SAME
    `nodeterm:switch-system-account` event the usage popover's "⇄ Switch account…" fires (one
    listener in Canvas.tsx spawns the SYSTEM-scoped `claude /login` node and closes the Settings
    overlay so the node is seen). Why: the system login was the one Claude auth with no in-app path
    from Accounts, so it read as "the account you can't manage here" and sent people to a shell.
    Its wait is NOT `waitLogin`-shaped: a machine already logged in satisfies "has an oauthAccount"
    before the user types, so `lib/systemAccountSwitch.ts` waits for the RESOLVED email to differ
    from the one shown at click (via `usage.refresh`, not `fetch` — fetch serves a 5-min cache) and
    clears silently on timeout (re-picking the same org is a valid outcome). LOCAL only, like the
    popover button: disabled inside an SSH project, where "switch account" is ambiguous between this
    machine's `~/.claude` and the host's. The in-flight wait lives in the `useSystemAccount` store
    (`startSwitch`), not in AccountsSection, and is a process-wide singleton: the switch closes the
    Settings overlay (unmounting the section), so a component-local flag would leak its poll and a
    reopened Settings would offer the button again and start a second `claude /login` + poll — the
    store flag instead keeps the button disabled and the "waiting for login…" line shown across the
    close/reopen, and a second click while one is in flight returns `'busy'` and is a no-op.
    Known limit (measured 2026-09-17): the row's email is
    decoration from `~/.claude.json`, the numbers come from the Keychain token; the two CAN diverge
    (identity file said one org, token was another's), so a real switch can still read
    "unchanged" until the row identity is derived from the token.
  - **Login flow** — Settings → Accounts → **Add** creates a `pending` account and drops a canvas
    **login node** that runs `claude /login` under the account dir. Core polls the dir's
    `.claude.json` (`LOGIN_POLL_MS` 2 s, up to `LOGIN_TIMEOUT_MS` 5 min) for `oauthAccount.email`;
    on capture the account flips out of `pending` with its email as the default label. Account
    removal cancels any pending wait + `markDirty`. **Codex accounts have the same two halves** —
    `createCodexAccountLoginNode` (`codex login`, title "Codex login") behind the
    `nodeterm:add-codex-account-login` listener, with `codexAccounts.waitLogin` polling the managed
    home's `auth.json`. **A Codex identity (managed or system) is read from that `auth.json`'s
    `id_token` email FIRST; the app-server `account/read` is only the fallback** (2026-09-28).
    `codex app-server daemon start` runs only on the installer-managed standalone build
    (`$CODEX_HOME/packages/standalone/current/codex`) and exits on a Homebrew/npm Codex, so a
    daemon-only reader left every managed account `pending` forever — and pending rows are skipped
    by the usage popover, the pickers and the mirror, which read as "Codex shows only one account"
    while Claude showed all of them. A token-bearing `auth.json` with no email claim still resolves
    (`{ email: null }`); one with no token is not a login. The account SWITCH legs in
    `src/main/codex-accounts.ts` still start the daemon and are untouched by this. Both flows mint an **agent-less terminal** carrying only `accountId`, and
    that shape is why `needsCodexAccountScope` takes an `isCodexAccount` resolver rather than
    reading `!!accountId`: the two account lists share an id alphabet, so the id alone cannot say
    which provider it belongs to. Guessing "codex" refused every managed **Claude** node (#345);
    guessing "not codex" would let `codex login` write into the system `~/.codex`. A dispatch with
    no listener is a silent no-op, which is how the Codex half shipped inert (#346) — pinned now by
    `renderer/lib/nodeterm-events.test.ts`, which fails on any `nodeterm:*` event that is sent but
    never heard. **All THREE login factories take a `cwd`** (`createAccountLoginNode`,
    `createCodexAccountLoginNode`, `createSystemLoginNode`), and every call site passes the active
    project's — a login node with none starts in `$HOME`, and an agent CLI whose trust check is
    keyed on the cwd (Claude Code's is) then asks the user to trust their entire home directory,
    SSH keys and cloud credentials included, before an OAuth round trip that touches no files
    (issue #553; a persisted "yes" there grants that workspace for good). It is not a promise the
    prompt disappears — an untrusted project still prompts — it makes it the exception rather than
    the rule, without nodeterm writing another tool's trust config on the user's behalf. A
    **remote** login ignores the local path: `createTerminalNode` prefers `ssh.remoteCwd`, which is
    the only cwd that means anything for a session running on the host. An SSH project has no local
    `cwd`, so a LOCAL account added from one still opens in `$HOME` — the honest answer, since that
    project owns no local directory.
  - **The lifecycle is CORE, and both shells register it** (issue #313) —
    `core/claude-accounts-service.ts` owns the five `claude-accounts:*` channels (add / wait-login
    / cancel-wait / remove / link) behind `platform().handle`; `main/claude-accounts.ts` is a thin
    desktop wrapper and `registerCoreHandlers` calls the same `registerClaudeAccountsIpc()`. Two
    optional deps carry everything core cannot reach: `installSkill` (desktop passes
    `installCanvasSkillInto`; an enabled Server canvas-control runtime installs its Server-specific
    skill separately) and `remote`, a **thunk** resolving the SSH legs
    (desktop's manager is created after the registration, and the server has none — in both cases
    an `AccountCtx` carrying a `projectId` degrades to the LOCAL path, which is the pre-existing
    behavior this preserves). **Three surfaces:** Desktop unchanged (same channels, same shapes,
    same remote fallbacks); **Server Edition** now full — real `buildClaudeAccountsApi` over the
    ws-bridge (the 5-min `waitLogin` is a straight passthrough because RpcClient has no request
    timeout), minus SSH accounts and the canvas skill; **Mobile: N/A** — the phone launches with
    the accounts the agent-status mirror advertises and never mints one. **Managed CODEX accounts
    stay desktop-only** and their bridge namespace stays an `E_UNSUPPORTED` stub: the switch verbs
    authorize the owning window by Electron WebContents id, which has no meaning over a WS
    connection. The Settings section now *names* that refusal instead of leaving an unhandled
    promise rejection — a spinner that stops and says nothing reads as a dead button.
  - **Account ROW membership (both lists) is the shell's, not the renderer's (2026-09-04).**
    `settings.codexAccounts` and `settings.claudeAccounts` used to be renderer-owned: the renderer
    appended the minted id to its own snapshot and full-saved it. `settings-store.ts` `save`
    REPLACES the file (FIFO, so never torn — but last-write-wins), so two Server Edition tabs
    adding at once, or an add racing a label edit in another tab, left the later snapshot the
    winner: one authenticated home / config dir on disk with NO row pointing at it — a credential
    nothing could list, switch to, or remove. That is why the browser's Add button was gated. Now
    `codex-accounts:add` / `claude-accounts:add` append the row and the `remove` verbs delete it
    through **`SettingsStore.mutate`** (a read-modify-write on the store's own save chain), in the
    same verb that mints / tears down the home; `add` resolves only once the row is on disk (so the
    renderer's old save barrier before the login node is gone) and rolls the minted home back if
    the persist fails (Claude awaits the fullscreen-TUI write FIRST so a slow probe cannot recreate
    the dir after the rollback removed it; a rollback whose cleanup ALSO fails logs loudly instead
    of swallowing it); `remove` deletes the row LAST so a failed teardown stays visible and
    retryable, never touches the local fs for a row carrying `host`, and still tears down a
    row-less home (a pre-fix orphan). **Removal branches on the ROW's `host` (shell-owned), not the
    renderer ctx**, and a **Claude remote** removal deletes the row ONLY once teardown on the host is
    CONFIRMED — the SSH `remove` primitive returns `true` only when the project is connected AND the
    remote `rm` exits 0; a disconnected/failed teardown KEEPS the row and errors rather than
    orphaning an authenticated dir on the host under a removal the UI called complete, and a ctx
    whose project host mismatches the row's (or routes a local row through an SSH project) is
    refused. Both services are handler TABLES with two registrars
    (`codexAccountsHandlers` / `claudeAccountsHandlers`): `platform().handle` on the Server
    Edition (`registerCoreHandlers(…, { settingsStore })`) and `ipcMain.handle` on the desktop
    (`initCodexAccounts(settingsStore, …)`, `initClaudeAccounts(settingsStore, …)`) — never
    `platform().handle` there, which is the peer-reachable table (INVARIANT 4c: a relay guest must
    not mint or delete accounts on the host). The `settings` dep is REQUIRED on both, because a
    shell that mints homes without registering rows is exactly this bug. A Claude remote add's row
    takes its `host` from the SSH manager (`hostKey`), falling back to the renderer's `ctx.host`
    only when nothing was minted anywhere (project not connected); a local add never reads it.
    **A renderer snapshot save is reconciled FIELD BY FIELD** (`reconcileOwnedAccountList`):
    membership comes from the store (a row only the store has is kept, a row only the snapshot has
    is dropped — so a stale tab can neither lose an add nor resurrect a remove); on a row both
    have, only the renderer-owned fields (`label`, `color`, `email`) are taken from the snapshot
    and every other field (`id`, `host`, `createdAt`) stays the shell's — `settings:save` is
    relay-reachable (not in `HOST_ONLY_CHANNELS`), and a snapshot that could write `host` could
    dress a local row up as remote so that `remove` skips its home while reporting success; login
    resolution is monotonic (a still-`pending` snapshot never un-resolves a row), while a label the
    stale tab typed is still honoured unless it is the mint-time placeholder
    (`NEW_CLAUDE_ACCOUNT_LABEL` / `NEW_CODEX_ACCOUNT_LABEL`, in `shared/`), which the capture
    replaced with the email. **The read-modify-write runs against the FILE, not the cache**
    (`readModifyWrite`): the chain serializes writers in ONE process, and two processes on one
    directory (two Server Edition instances on a `--data-dir`, a desktop sharing it — see
    `docs/atomic-writes.md`) each have their own cache and chain, so a mutate applied to a stale
    cache would publish the other process's add out of existence. Every write re-reads
    settings.json, applies itself to that, and re-reads again if the file's inode/mtime/size
    stamp changed before the write (bounded). The read + write are held under a **cross-process
    advisory lock** (`withFileLock`, `src/core/file-lock.ts`, backed by `proper-lockfile` on
    `settings.json.lock`: an atomic `mkdir` kept fresh by an mtime heartbeat), so two cooperating
    processes no longer race the stamp-check→rename gap; a holder broken out from under it (the
    stale-break race, or a missed heartbeat) is DETECTED and the write is FLAGGED
    (`FileLockCompromisedError`) — it may already have landed (single atomic rename, last-writer-wins,
    never torn), so this signals a non-exclusive write for the caller to retry, it does not prevent it. The stamp re-read stays as a
    second line against a raw external writer, and on retry-exhaustion or a lock timeout the write is
    ABANDONED with a throw rather than landed stale (a genuinely corrupt settings.json is likewise
    refused, never overwritten with defaults). See docs/atomic-writes.md. Proofs:
    `settings-store.test.ts` (the three ownership describes, incl. two instances on one file),
    `codex-accounts-service.test.ts` / `claude-accounts-service.test.ts` ("the shell owns row
    membership"), the desktop halves in `main/codex-accounts.test.ts` and
    `main/claude-accounts.probe.test.ts`, the renderer mirrors in `AccountsSection.codex-add` /
    `AccountsSection.claude-add`.
  - **Cross-process account mutation is covered too.** SINGLE-PROCESS mutation is covered by the
    store's FIFO chain (one desktop app, or one server with any number of BROWSER TABS, loses no
    row); concurrent MUTATION across multiple PROCESSES sharing one `--data-dir` (two
    `nodeterm-server --data-dir X`, or `NT_MULTI` desktop) is covered by the lock + disk reads:
    - **Add/add** rests on `proper-lockfile` (atomic `mkdir` + mtime heartbeat), so a live holder is
      never wrongly broken, and a holder broken out from under it LEARNS (`FileLockCompromisedError`)
      instead of silently proceeding on a list that raced. The flag does not prevent the write (it
      runs inside `fn`); it signals it, and the caller retries. Every write is a single atomic rename,
      so a same-instant race is last-writer-wins with no torn file. (The hand-rolled O_EXCL
      predecessor's silent double-acquire is gone.)
    - **Remote teardown** reads a row's `host` provenance from DISK under the lock
      (`SettingsStore.readAccountsFromDisk`), not the per-process cache, so a stale cache can no
      longer route another process's remote account down the LOCAL teardown path (orphaning an
      authenticated dir on the host). A remote add that then fails rolls the remote dir back and LOGS
      loudly on an unconfirmed teardown (never swallowed); a mint whose project disconnects before
      its host is known is rolled back, not persisted as a local-looking row. See
      `docs/atomic-writes.md`.
  - **Hook install** — the managed hook is merged into **each account dir's** `settings.json` at
    add-account **and** at app launch (local, shared `install-helper.ts`) / via
    `RemoteHooks.installIntoAccountDir` (remote), so every identity reports agent status. The
    launch-time loop is ONE function (`installHooksIntoLocalAccounts`, beside the service) that
    both shells call — the desktop passing the canvas skill as its `extra`. A second copy is the
    drift these rule files warn about elsewhere: the Server Edition shipped without the per-account leg
    entirely, so a managed account there reported no agent status at all.
  - **Account-aware readers** — transcript resolution is scoped per account (`transcriptRootFor`
    picks the account dir's `projects/`, composite cache key includes `accountId`); the same
    threading runs through the session-name poll, restart handoff, and `ChatPanel` (the ⌘M
    transcript view, `chat.readTranscript`). The **usage indicator** is per account (`claude-usage.ts`: scoped Keychain
    service only for managed accounts, then their credentials file; popover lists a row per account with **System**
    first). **Remote (SSH host) accounts are included** — see **Remote usage** below.
  - **Pickers** — New Claude exposes an account **submenu** (pane menu; flat entries in
    the dock; palette commands; TabBar sets the **per-project default**). A **local** project
    lists local accounts, an **SSH** project lists only accounts whose `host` matches its
    connection; both offer a **System account** option. An SSH project whose host has **no**
    matching accounts gets a disabled hint row instead of a bare System-only list
    (`sshAccountsHint` — pane submenu, dock, TabBar; the palette deliberately omits it: a
    disabled row would surface as a search result) saying accounts for this host are added in
    Settings → Accounts while the project is connected — local accounts being invisible there is
    correct (their credentials aren't on the host) but read as "multi-account is broken on SSH".
  - **Remote accounts** — selection + login + env injection, plus **usage** (below); no
    per-account transcript readers beyond env.
  - **Settings → Accounts is ONE machine-grouped surface for BOTH providers** (2026-09): a panel
    per machine (this one, then each saved SSH server ∪ the active project's server — a saved server
    with no accounts and no connection is folded into a footnote count), each holding a Claude and a
    Codex block with the SAME row, system row and Add button (`groupAccountsByMachine`). A remote
    machine's Add / Retry / Remove act ON that host over a **connected** project only — a
    disconnected host's Add is disabled and its Remove only forgets the record (the dialog says so);
    a remote id never reaches a LOCAL remove. Codex gained the remote lifecycle this needed:
    `codexAccounts.add/waitLogin/identity/remove` take an SSH `ctx` (desktop `src/main/codex-accounts.ts`
    → the `SshProjectManager.remoteCodex*` legs; the credential is written on the host by
    `codex login --device-auth` — the default browser flow calls back to the HOST's localhost), and
    `systemIdentity({projectId})` now asks the host instead of answering `null`.
    **Fork (Termscape): Pi is the third provider on this surface, LOCAL-ONLY.** The local machine
    panel carries a Pi block beside Claude and Codex; a remote machine's panel never offers, adds or
    binds a Pi account (`boundAccountId(id, 'pi', { ssh })` drops the binding on SSH nodes, and the
    remote spawn skips the pi scope). Carry this into any further provider-keyed generalization of
    the surface. Detail: `.claude/rules/agents-pi.md`.
  - **The remote spawn scopes the account BY PROVIDER** (`core/remote-account-env.ts`). It used to
    hand every `accountId` to Claude's `CLAUDE_CONFIG_DIR`, so a node bound to a managed Codex account
    on an SSH host got a Claude dir that does not exist and NO `CODEX_HOME` — its codex silently ran
    as the host's system login (`remoteCodexTmuxEnvArgs` existed with no caller). The system Codex
    account is left to the host's own env (a remote `CODEX_HOME` of the user's — a snap remap — must
    win).
  - **Switch Codex account on an SSH node** (2026-09) does NOT use the local three-phase reservation
    (it plans rollouts in LOCAL homes). It is one host-side exposure —
    `codexAccounts.switchThreadRemote` → `SshProjectManager.remoteCodexSwitchThread` →
    `remoteCodexExposeThread` (relay `expose-thread`): resolve the thread across every account
    catalog on the host, hardlink the one authoritative rollout into the target home, verify the
    target's app-server discovers it, roll the link back if not; an ambiguous thread is refused.
    Then the usual still-eligible check and a restart-shell recycle, with the rebind riding
    `beforeRecycle` (never a separate setNodes). A hardlink, not a copy: both accounts see ONE file,
    so there is no diverged-copy case. Needs the relay runtime on the host (node + codex + curl);
    without it the switch fails with a notice and nothing changes. `planCodexAccountSwitch` now
    refuses a target on another machine than the node (`hostKey`) — the switch never crosses
    machines (moving a local conversation to a host is `transferThreadToSsh`, a separate flow).
  - **Remote Codex safety (#736):** `spawnNew` requires managed SSH Codex accounts (including custom
    Codex harnesses and known agent-less login terminals) to have a safe id in the saved Codex account
    list and a safe resolved `remoteHome`. `remoteAccountScopeEnvArgs` then supplies the private
    `CODEX_HOME` and account marker. An unresolved or unsafe home must refuse before env staging/spawn,
    not fall back to the host's system login. System Codex retains the host environment even before
    home discovery during early attach. Never guess HOME/CODEX_HOME. Desktop and Server share this
    core gate; Desktop supports the remote lifecycle, while Server account management remains unavailable.
  - **The fork's own copy-FIRST switcher is gone (v0.3.16 merge, 2026-09-27).** Both sides had built
    a running-node Claude account switch; the merge kept upstream's (**Switch Claude account**, above:
    quit the CLI, then `claudeAccounts.copySession`, then rebind + recycle) because it also covers SSH
    hosts, the kanban card and the usage popover's bulk move. The fork's driver
    (`renderer/lib/accountSwitch.ts`) and its core copy service (`core/account-transcript-copy.ts`,
    IPC `claude:copy-session-transcript`) were deleted rather than left callerless: that channel sat
    on the peer-reachable `platform().handle` table, so an approved relay guest could still move a
    transcript between account roots on the host with nothing in the product using it. Accepted
    differences from the old fork contract: a failed copy no longer "mutates nothing" (the CLI has
    already quit, so the pane restarts and resumes under the SOURCE account: an interruption, not a
    lost conversation, and the copy then works from a FINAL source file); upstream's planner has no
    `hibernated` refusal; and only the builtin `claude` switches (a claude-BASED custom agent no
    longer does, matching the `boundAccountId` rule that custom agents never bind an account).

- **Active Claude organization** (#552) — local Desktop and Server usage snapshots carry optional
  `organization` metadata from the SAME account's `.claude.json` (system, managed or linked).
  Read it even if Keychain/file credentials already have an email; unreadable/missing metadata
  preserves the email and usage. A known email mismatch drops metadata. Managed usage cannot use
  an unscoped Keychain token: a matching email alone does not prove it belongs to the same org.
  The popover names the org beneath the email; internal type/tier/id remain tooltip details.
  Refresh re-reads metadata together with usage; normal cache/poll intervals still apply.
  SSH's existing shell reader does not supply organization metadata and keeps its email-only
  fallback. Mobile's usage mirror currently omits it; displaying orgs there needs a follow-up
  mirror/iOS protocol change. No organization picker, credential writes or switching are added.

- **Bottom chrome shares a measured width budget** (issue #853). `CanvasPills` observes the canvas
  wrapper and actual dock, bounds the left row with an 8px gap, and uses a row above the dock when
  fewer than 200 CSS pixels remain. Rects are converted back through UI scale. Usage summary text
  ellipsizes; refresh never shrinks. Do not clip the whole row or give it a stacking context:
  usage/RAM popovers must escape independently above the sidebar and board. Desktop and Server
  share this renderer. The real-browser regression is `scripts/usage-layout.test.ts` (`CHROME_BIN`).

- **The usage indicator is scoped to the ACTIVE project** (`renderer/lib/usageScope.ts`, pure +
  unit-tested) — it describes **the machine that project runs on**, and nothing else. A local
  project shows this machine (system + managed local accounts + the billing providers, whose
  credentials are all local); an **SSH project shows that host's Claude and Codex accounts** — no local
  Claude, no local providers, no other host. Without this the panel showed every source at once:
  each addition was individually reasonable and the sum was unreadable, numbers from three
  machines sharing one line with nothing saying which was which. Deliberately NOT narrowed to the
  project's `defaultAccountId`: the local side lists every local identity, so the machine is the
  scope and the account is a row within it. The pill spells out the scoped machine's **system**
  account (falling back to the first identity with data, so a host used only through a managed
  login isn't blank), managed accounts stay popover-only — the rule the local side always had.
  `usageScopeKey`/`scopeFromKey` exist because the active project object is rebuilt on every node
  serialization: the zustand selector returns ONE primitive so the indicator doesn't re-render on
  every canvas edit. ⟳ refreshes only what is on screen, and `usage.remote({hostKey})` reads only
  that host (cache eviction still runs against the FULL target list, so switching between two SSH
  projects doesn't throw each host's cache away).

- **Grok billing failures** retain per-view HTTP status or a safe timeout/network/invalid-response category in `ProviderUsage.diagnostics`. The default view still runs after a credits failure; recovered limits keep their diagnostic. Only two successful empty views imply no quota. Never include raw exceptions, URLs or response bodies, or refresh/write credentials. Desktop and Server share the core reader and popover; provider-only errors must keep the pill visible.

- **Usage failure readouts** — an empty Claude snapshot with `status: error` says "Could not
  read usage." in both the single-account and multi-account popovers, including beside healthy
  provider rows. Nonempty snapshots retain their last-known bars on error; no error-specific
  authentication advice is inferred from the status.

- **Remote usage** (SSH hosts, `src/core/usage/remote-claude-usage.ts`) — the source behind the
  SSH scope above. v1 excluded remote accounts, which left a user whose Claude only ever runs on a
  server staring at an empty indicator while the host had perfectly good numbers.
  **The token never leaves the host.** The desktop could `cat` the remote `.credentials.json` and
  call the API itself — it already reads remote transcripts over the same master — but a bearer
  token pulled off a (possibly shared) server into another machine's memory buys nothing: the host
  can make the request itself. So core generates a POSIX **sh+curl** command, the shell runs it
  over the project's ControlMaster, and only the JSON answer comes back. Three details are
  load-bearing:
  1. **The token is piped into `curl --config -`, never `-H` on the command line** — argv is
     world-readable via `ps` on a shared host.
  2. **`.credentials.json` holds more than one `accessToken`** — every MCP server the CLI has
     authorized keeps its own under `mcpOAuth`. The extraction narrows to the `claudeAiOauth`
     object first (exactly as the local `parseCreds` does), because grabbing the file's first match
     sends an MCP token to the endpoint, earns a 401, and reports a signed-in host as signed out.
     Caught only by running the command against a REAL credentials file — which is why
     `remote-claude-usage.test.ts` runs the generated script under a real `/bin/sh` against a fake
     `$HOME` + fake `curl`, the same discipline as the canvas-control shim.
  3. **A read that could not run is `error`, never `unavailable`** — a dead master says nothing
     about whether the account has a subscription, and 'unavailable' silently drops the row.
  Shape: `remoteUsageTargets` (pure) elects ONE connected project per host (several projects share
  a host's `$HOME`) and offers its system `~/.claude` plus every managed account pinned to that
  host. The service (`usage:remote`) caches per target under the usual debounce, evicts targets
  whose host disconnected, and coalesces concurrent reads. **On demand, never polled** — each row
  is an ssh exec plus an HTTPS request on someone else's machine; the renderer asks on mount, on
  popover open, on ⟳, and when the active project's connection comes up (an SSH project is opened
  before its master is ready). Deps are injected exactly like
  Context Link's (`src/main` supplies the ControlMaster; **Server Edition passes none** ⇒ `[]`, so
  the UI needs no capability check). Own Settings switch (`claude-remote`), because hiding local
  Claude usage must not silently take the hosts down with it. **Mobile: N/A** — the
  slice pushed to a host still drops `usage` (a host reading its own numbers back off us is
  pointless), and no keychain leg exists remotely (a headless macOS host would hang on the prompt,
  so a mac host reports nothing).
- **Codex SSH usage** (`core/usage/remote-codex-usage.ts`) uses host-side Node JSON parsing
  and curl, reusing the local Codex quota mapper. Read only `tokens.access_token` and
  `tokens.account_id`; pass headers through stdin, disable curl config/redirects, and return
  only sanitized quota fields. Never download credentials, refresh tokens, or launch a remote
  app-server just to refresh usage. The host needs Node and curl; missing tools/transport or
  malformed responses are errors, not proof of a logged-out account. System reads use the
  host login environment's `CODEX_HOME`; managed reads use the validated account's remote
  home. Cache identity includes provider, host, account and connection/home identity.
  Remote Codex rows obey the Codex visibility setting and carry no Claude default-account
  or bulk-move actions. Desktop supports SSH reads; Server Edition keeps its local core
  readers and absent SSH dependency. The private mobile reader is separate. Device checks:
  `docs/codex-ssh-metrics.md`.
- **Codex usage in the agent-status mirror (the phone's Codex rows, 2026-09-06).** The mirror's
  `usage` block carries Codex rows (`agentId:'codex'`, the un-owned system row + one per managed
  local account) next to the Claude rows; `src/server/peer-status-bridge.ts` forwards them
  untouched and the phone keys rows by `accountId ?? "system:<agentId>"`. The design has TWO
  cache stamps in `usage-service.ts`: `providersAt` (the pill's full run, all providers, 5-min
  debounce) and `codexAt` (the Codex-only leg the mirror kicks through
  `refreshProvidersIfStale()`, POLL_MS cadence, gated exactly like `pollAll` on
  `shouldPoll() || mirrorMayBeRead()`, a no-op while EITHER a Codex leg or a full run is in
  flight). The Codex leg MERGES into `providersCache` (other providers' rows untouched, never
  stamps `providersAt`), and the account-set fingerprint is stamped where rows LAND, never at leg
  start — stamping it early let a popover be served the previous account set. `buildMirrorUsage`
  drops `status:'unavailable'` Codex rows (a phone must not show a dead Codex row on every
  machine), takes a managed row's email from settings only (the provider's `account` is
  `email || label`), and mirror writes are serialized per path so a stale doc can never overwrite
  a fresher one. `fetchCodexUsage` skips the `codex app-server` subprocess tier when the home has
  no `auth.json` at all. Contract + rationale: `docs/mobile-usage-inbox.md`.
- **`accountFallback` is a dir re-check at EVERY attach, and the Server Edition beside a desktop
  resolves the desktop's account dirs.** The phone showed "account folder missing" on every attach
  to an account-bound desktop node (2026-09-07): the server resolved the id under ITS data dir
  (`~/.nodeterm-server`), where the desktop's accounts do not live. Fixed where it arose:
  `claudeConfigDirForSpawn` (`src/core/claude-config-dir.ts`) resolves an id this instance has no
  dir for under `CorePlatform.peerUserDataDir` — the Server Edition takes it from
  `NODETERM_PEER_USER_DATA`, else DERIVES it from `NODETERM_PEER_STATUS_MIRROR`'s directory (the
  mirror is `<userData>/agent-status.json`; one peer, one knob) — so a phone attach or COLD spawn of
  a desktop node runs under the node's real account. Spawn-side only: add/login/remove keep
  `claudeConfigDirFor` and never touch the peer tree. The hook transcript-path jail
  (`isSafeLocalTranscriptPath`) accepts the peer's `claude-accounts/<id>/projects` too, same shape,
  or such a node's hook POSTs would be refused and it would show no status. **Do not gate the flag
  on `fresh`**: that was tried the same day and reverted after two independent reviewers (Codex,
  blind security agent) showed it hides a GENUINE fallback after a process restart — spawned fresh
  with the dir missing, pane really on `~/.claude`, reopened warm ⇒ flag dropped, chip healthy. The
  re-check is a guess about the pane on warm paths either way (the pane's real env is not knowable
  cheaply); "dir missing everywhere" is the honest, conservative answer. Tests:
  `pty-account-fallback.test.ts`, `claude-config-dir.test.ts`, `config.test.ts`. Still open on that
  topology: the server's transcript/session-name/context-link READERS (`transcript-index.ts` etc.)
  enumerate the server's own settings accounts only, so a peer-account node's transcript is not
  found by the browser find-bar / ⌘M (pre-existing for every desktop-spawned account node, deferred);
  a Codex account-bound desktop node is still refused (`unavailable: 'codex-account'`) — Codex
  homes are keyed by the instance's userData digest. The phone's New Session sheet gets the peer's
  Claude accounts from `claude-accounts:peer-list` (`src/core/peer-claude-accounts.ts`, server-only
  handler; read-only, filtered to spawnable rows: not pending, no `host`, dir present, safe id) and
  unions them with `settings:load`'s list — the server's own settings list no accounts on this
  topology, which left the sheet with only the System account (Siim, 2026-09-07). An id the server
  has its OWN dir for is never offered (the spawn would resolve to the own dir under the desktop
  label; consort HIGH). Deferred, same review: a phone registration under a peer account gets the
  agent brand color, not the account's configured color (`appendProjectNode` resolves colors from
  the server's own settings only).
- **Shared system skills** (`shareSystemSkills`, issue #643, OFF by default) — Claude Code resolves
  user skills as `join(CLAUDE_CONFIG_DIR ?? ~/.claude, 'skills')` (measured 2.1.266), so an account
  dir **replaces** `~/.claude/skills` and a fresh managed account shows only nodeterm's installed
  skills (#438). This per-account switch (Settings → Accounts) is the way back in. **Each system skill
  is linked INDIVIDUALLY** (`<accountDir>/skills/<name>` → `~/.claude/skills/<name>`), never the whole
  directory: `installCanvasSkillInto` writes INTO `<configDir>/skills/`, so a directory-level link
  would put nodeterm's canvas skill in the user's system folder. Per-skill links keep the account's
  `skills/` a real dir and make the off-switch a link removal (strace-confirmed equivalent for
  discovery). Load-bearing:
  - **Ownership is name-anchored** — an entry is ours iff it is a symlink whose target normalizes to
    exactly `join(systemSkillsDir, <its own name>)` (`core/claude-skill-share-core.ts`, pure +
    mutation-tested); a real directory is never ours. Removal is `unlink` then `rmdir` (both fail on a
    real non-empty dir; a Windows junction refuses `unlink`).
  - **`NODETERM_OWNED_SKILLS` (`manage-nodeterm-canvas`, `get-linked-context`) is never linked or
    pruned** — nodeterm's own installers own those; sharing them would make two owners fight over the
    name at every launch.
  - **The realpath refusal is load-bearing** — the issue's manual workaround (`ln -s ~/.claude/skills
    skills`) makes the account's `skills/` RESOLVE to the system one; the planner compares REAL paths
    and refuses (`same-directory`).
  - **Windows uses a directory JUNCTION** (no Developer Mode / elevation), so the feature is on every
    desktop platform. **The launch sweep re-links but NEVER removes** (removal only through
    `claude-accounts:set-skill-sharing`, where intent is explicit — a link's SHAPE cannot tell ours
    from an identical hand-made one). **The switch flips the filesystem FIRST, persists the flag only
    if that returned.** The copy says edits flow both ways (a link is not a copy). Surfaces: Desktop
    full; **Server Edition full** (whole impl is core); **SSH accounts out of scope for v1** (config
    dir is on the host — disabled with that reason, core refuses `remote-account`); Mobile N/A.
- **Linked accounts** (`ClaudeAccount.configDir`) — a PRE-EXISTING local config dir the user already
  drives (`export CLAUDE_CONFIG_DIR=~/.claude-2`) adopted as a first-class account without a login
  node. Settings → Accounts → **Link existing config dir…** calls `claude-accounts:link` (core): `~`
  expansion → `normalizeLinkedConfigDir` → string-only refusals (system `~/.claude`, anything under
  `{userData}/claude-accounts`, an already-linked path) → `stat` → email from `<dir>/.claude.json`
  (missing = `email: null`) → managed hook install. `claudeConfigDirFor(id)` consults a **registered
  accounts source** (`registerClaudeAccountsSource`, both shells right after `settingsStore.init()`,
  BEFORE the mirror provider can flush) so env injection, transcript roots, usage rows and pickers all
  resolve a linked id with no per-caller branch. Transcript jails accept `<linkedDir>/projects/**`
  **from settings only**, never a POST-named dir. **Removing a linked account only forgets the
  record** — the `rm -rf` names `accountConfigDir(userData, id)` directly, so it cannot reach outside
  the managed root. The hook installer resolves `settings.json` symlinks and atomically updates their
  target (without replacing the link; pinned by `claude-accounts-link-symlink.test.ts` — a
  `renameAtomic` over the link itself would be the regression, it replaces the link).
- **Observed account** (`ObservedClaudeAccount`, `NormalizedAgentEvent.account`) — which account a
  session is ACTUALLY on, derived by the hook server from the payload's `transcript_path`
  (`configDirFromTranscriptPath` walks up to the LAST `projects` segment).
  `classifyClaudeConfigDir` is pure host-agnostic string matching: managed local root → managed remote
  pattern (`…/.nodeterm/claude-accounts/<id>`) → linked (settings) → any `…/.claude` ⇒ system
  (`accountId: null`) → else `known: false`. It is a **LABEL** like `verified`: attached once in the
  hook server (both shells inherit it, neither raw listener changes), claude events only, never
  throws, **never reads the filesystem** (a forged POST naming `~/.ssh/projects/x` gets
  `known: false`). Recorded by the mirror and the renderer store (`agentStatus.account`, persisted
  like `agentId`). **Effective account for READERS** = `data.accountId ?? observed.accountId`
  (`effectiveAccountId`): `readSessionName`, `context.ensure`, transcript search and ⌘M use it;
  **spawn/env never does** (launch identity stays creation-time). The **account chip**
  (`AccountChip.tsx`, one component on node header, kanban card, card modal and sidebar row) shows for
  any non-system account, and for system panes only when ≥ 2 distinct account keys are live
  (`hasMultipleAccountKeys`). An unlinked dir is named by its last segment with a tooltip to
  Settings → Accounts → **Detected config dirs**. Mobile N/A.
