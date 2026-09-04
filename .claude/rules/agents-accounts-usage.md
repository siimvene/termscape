---
paths:
  - "src/core/claude-accounts-*.ts"
  - "src/core/codex-accounts-core.ts"
  - "src/core/codex-config-dir.ts"
  - "src/core/codex-identity-*.ts"
  - "src/core/account-transcript-copy.ts"
  - "src/core/usage/**"
  - "src/core/pty-manager.ts"
  - "src/main/claude-accounts.ts"
  - "src/main/claude-usage.ts"
  - "src/main/codex-accounts.ts"
  - "src/renderer/lib/accountSwitch.ts"
  - "src/renderer/lib/usageScope.ts"
  - "src/renderer/components/UsageIndicator.tsx"
  - "src/renderer/state/systemAccount.ts"
  - "src/renderer/state/codexAccountReconcile.ts"
  - "src/renderer/state/systemCodexAccount.ts"
  - "src/shared/agents/account-*.ts"
  - "src/renderer/components/settings/sections/AccountsSection*.tsx"
---
# Managed Claude/Codex accounts, account switch, usage indicator scope, remote usage

> Moved verbatim from the root `CLAUDE.md` on 2026-09-01 (see its "How this documentation is
> organized" section). Loads automatically when a file matching the `paths` above is read;
> when the root routing table points here, read this file before touching the subsystem.
<!-- moved-verbatim-from: CLAUDE.md -->

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
    `~/.claude`), then **immutable** and **persisted** (serializers). `undefined` = system default
    = **bit-for-bit legacy behavior** (no env touched). Inherited by **Branch** (the
    terminal→chat fork it also fed is gone — the SDK chat node was removed 2026-07). Two #419
    rules inside the resolver: the submenu's **System row passes `null`** (an EXPLICIT system
    pick that skips the project default — before that, the row wearing the system email launched
    the project-default account), and validation runs against `accountsForProject`, not the raw
    list, so a **pending** account or one **pinned to another machine's host** is never stamped
    onto a node it cannot run on (both used to reach the missing-dir fallback at spawn).
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
  - **Login flow** — Settings → Accounts → **Add** creates a `pending` account and drops a canvas
    **login node** that runs `claude /login` under the account dir. Core polls the dir's
    `.claude.json` (`LOGIN_POLL_MS` 2 s, up to `LOGIN_TIMEOUT_MS` 5 min) for `oauthAccount.email`;
    on capture the account flips out of `pending` with its email as the default label. Account
    removal cancels any pending wait + `markDirty`. **Codex accounts have the same two halves** —
    `createCodexAccountLoginNode` (`codex login`, title "Codex login") behind the
    `nodeterm:add-codex-account-login` listener, with `codexAccounts.waitLogin` polling the managed
    home's `auth.json`. Both flows mint an **agent-less terminal** carrying only `accountId`, and
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
    `core/claude-accounts-service.ts` owns the four `claude-accounts:*` channels (add / wait-login
    / cancel-wait / remove) behind `platform().handle`; `main/claude-accounts.ts` is a thin desktop
    wrapper and `registerCoreHandlers` calls the same `registerClaudeAccountsIpc()`. Two optional
    deps carry everything core cannot reach: `installSkill` (desktop passes `installCanvasSkillInto`
    — the server passes none, because **canvas control is not wired on that shell at all**, so a
    per-account SKILL.md would point at nothing) and `remote`, a **thunk** resolving the SSH legs
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
    stamp changed before the write (bounded). The read + write are now held under a **cross-process
    advisory lock** (`withFileLock` on `settings.json.lock`, an `O_EXCL` lockfile — `src/core/file-lock.ts`),
    so two cooperating processes no longer race the stamp-check→rename gap; the stamp re-read stays
    as a second line against a raw external writer, and on retry-exhaustion or a lock timeout the
    write is ABANDONED with a throw rather than landed stale (a genuinely corrupt settings.json is
    likewise refused, never overwritten with defaults). See docs/atomic-writes.md. Proofs:
    `settings-store.test.ts` (the three ownership describes, incl. two instances on one file),
    `codex-accounts-service.test.ts` / `claude-accounts-service.test.ts` ("the shell owns row
    membership"), the desktop halves in `main/codex-accounts.test.ts` and
    `main/claude-accounts.probe.test.ts`, the renderer mirrors in `AccountsSection.codex-add` /
    `AccountsSection.claude-add`.
  - **Known limitations (tracked for a follow-up).** SINGLE-PROCESS account mutation is fully
    covered — one desktop app, or one server with any number of BROWSER TABS on that one server,
    all serialize through the store's FIFO chain and lose no row. What is NOT yet guaranteed:
    - **Concurrent account MUTATION across multiple PROCESSES sharing one `--data-dir`.** The
      cross-process lock (`src/core/file-lock.ts`) is a hand-rolled O_EXCL lockfile that can
      double-acquire when two processes break the same STALE lock in the same instant, so a
      cross-process add/add can still lose a row. (The lock is now BOUNDED — it throws rather than
      hanging or busy-spinning — but not exclusive under a simultaneous stale-break.) The complete
      fix (a vetted cross-process lock, e.g. `proper-lockfile`, with owner tokens) is deferred to a
      dedicated follow-up branch.
    - **REMOTE account teardown across stale per-process caches.** The `remove`/`add` handlers read
      membership from THIS process's cache, not from disk under the lock, so a process with a stale
      cache can delete another process's remote row without SSH teardown; a remote rollback ignores
      a failed teardown; and a disconnect mid-add can persist a remote account as local. The fix
      (read membership from disk under the lock in the account handlers) is deferred to the same
      follow-up. See `docs/atomic-writes.md` "Known limitations". These are NOT fixed here — do not
      describe them as such.
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
    service first, legacy unscoped fallback; popover lists a row per account with **System**
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
  - **Switch account (running node)** — the node context menu's **Switch account** submenu moves an
    already-running Claude session onto another local account (or back to the system `~/.claude`).
    Because `data.accountId` is immutable at creation, this is a **copy-then-flip cold restore**,
    not a mutation of the live dir. The **transcript-copy invariant** is the whole point: the
    file-level half is the core service `copySessionTranscript` (`core/account-transcript-copy.ts`,
    IPC `claude:copy-session-transcript`, registered in **BOTH** shells, reached at
    `window.nodeTerminal.claude.copySessionTranscript`), which mirrors `<sessionId>.jsonl` **and**
    its subagents sibling tree from the source account's `projects` root into the target's
    (`transcriptRootFor`), STRICTLY by sessionId (never the newest transcript). The renderer driver
    `executeAccountSwitch` (`renderer/lib/accountSwitch.ts`) runs the ONE safe order: **copy FIRST**,
    then identity-gated `terminateForeground` → `transport.recycle(id)` → `updateNodeData(id,
    {accountId: target|undefined, respawnNonce: +1})` (the model-switch sequence); **a failed copy
    mutates NOTHING** — a resume that finds no transcript in the target dir is a lost conversation.
    Refusal matrix (`planAccountSwitch`, fail-closed): not a Claude node, a **remote** session
    (relay tab / SSH-project node — those account dirs live on another machine), **busy**
    (`working`/`blocked`), no resumable sessionId, a **same-account** no-op, or a target that is
    missing / forged / `host`ed / still `pending`. Both `fromAccountId`/`toAccountId` are validated
    with the same rule as `accountConfigDir` (`isSafeAccountId`) at the handler AND with a
    defense-in-depth regex in the renderer — a forged id interpolated into a path must never
    traverse. Server Edition switches accounts too (no remote leg — the server runs ON the host).

- **The usage indicator is scoped to the ACTIVE project** (`renderer/lib/usageScope.ts`, pure +
  unit-tested) — it describes **the machine that project runs on**, and nothing else. A local
  project shows this machine (system + managed local accounts + the billing providers, whose
  credentials are all local); an **SSH project shows only that host's Claude accounts** — no local
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
