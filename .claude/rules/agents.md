---
paths:
  - "src/shared/agents/**"
  - "src/core/agents/**"
  - "src/core/usage/**"
  - "src/core/*-session*.ts"
  - "src/core/*-tail.ts"
  - "src/core/agent-*.ts"
  - "src/core/claude-cli.ts"
  - "src/core/transcript-*.ts"
  - "src/core/remote-transcript-locate.ts"
  - "src/core/codex-subagent-format.ts"
  - "src/core/session-name-sweep.ts"
  - "src/core/custom-agent-env.ts"
  - "src/main/index.ts"
  - "src/main/remote-*-tail.ts"
  - "src/main/remote-ssh/remote-hooks.ts"
  - "src/main/remote-ssh/remote-status-push.ts"
  - "src/main/remote-ssh/agent-resync*.ts"
  - "src/server/agent-status.ts"
  - "src/server/index.ts"
  - "src/renderer/state/agentStatus.ts"
  - "src/renderer/state/agentNodes.ts"
  - "src/renderer/state/permissionMode.ts"
  - "src/renderer/state/modelGateway.ts"
  - "src/renderer/nodes/ChatPanel.tsx"
  - "src/renderer/nodes/SubagentNode.tsx"
  - "src/renderer/nodes/LoopNode.tsx"
  - "src/renderer/terminal/agent-restart.ts"
  - "src/renderer/lib/hibernationCandidates.ts"
  - "src/renderer/lib/loopCard.ts"
  - "src/renderer/lib/transcriptGates.ts"
  - "src/renderer/lib/claudeBranch.ts"
  - "docs/*-agent.md"
  - "src/core/grok-*.ts"
  - "src/renderer/state/grokSessionIds.ts"
---
# Agent support: registry + capabilities, hooks, permission mode, transcripts, subagent/workflow viz, adding a new agent

> Moved verbatim from the root `CLAUDE.md` on 2026-09-01 (see its "How this documentation is
> organized" section). Loads automatically when a file matching the `paths` above is read;
> when the root routing table points here, read this file before touching the subsystem.
<!-- moved-verbatim-from: CLAUDE.md -->

## Agent support (Claude / Codex / Gemini / Copilot / opencode / Grok / custom)

The app is a pluggable multi-agent system: Claude Code is one builtin of
several. Extra terminal-node behavior is driven per agent by a registry + capability lists, a
shared 4-state model, and a **transient** zustand store `state/agentStatus.ts`
(`{state, agentId, unread, session, sessionId, loop, hibernated}` per node id; the live `state` is
**not** persisted — only `unread`/`session`/`sessionId`/`agentId`/`loop`/`hibernated` go to
localStorage under `nodeterm.agentStatus`, migrated once from the legacy `nodeterm.claudeStatus`
key. `agentId` is durable because a hand-launched `claude` in a plain terminal is known nowhere
else, and its context links must keep classifying across restarts).

- **Agent registry + capabilities** — `src/shared/agents/config.ts` holds `AGENT_CONFIG`
  (claude/codex/gemini/copilot/opencode/grok: id, label, spawn command, color, `promptInjectionMode`, …) keyed
  by an **open** `AgentId`
  type (so custom ids fit). Capabilities are membership lists, not flags:
  `AGENT_HOOK_TARGETS`, `RESUMABLE_AGENTS`, `SUBAGENT_CAPABLE`, `RECURRING_CAPABLE`,
  `BRANCH_CAPABLE`, `CONTEXT_LINK_CAPABLE`, `USAGE_CAPABLE`, `CHAT_CAPABLE`,
  `TRANSFER_SOURCE_CAPABLE`, `RENAME_CAPABLE`, `TITLE_READ_CAPABLE`, `CANVAS_CONTROL_CAPABLE`,
  `PERMISSION_MODE_CAPABLE`, `MODEL_SWITCH_CAPABLE`, with helpers (`hasHooks`,
  `canBranch`, `canContextLink`, `canChat`, `canRename`, `canReadTitle`, `hasPermissionMode`, …).
  Branch stays **Claude-only** purely by being in only `BRANCH_CAPABLE`. The ⌘M **ChatPanel**
  transcript view (`CHAT_CAPABLE` / `canChat`) is **claude + grok** since 2026-09: grok's
  `chat_history.jsonl` gets its own reader, and `chat:read-transcript` routes by agent. That list had
  to be SPLIT to do it — `CHAT_CAPABLE` carried two facts that coincided while claude was its only
  member ("we can render this" and "claude's resolver can locate and parse this file"), and the
  second now lives in `CLAUDE_TRANSCRIPT_READABLE` (claude only). Merging them back is a
  cross-session read of someone else's transcript; `config.capabilities.test.ts` pins the pair.
  The other lists span more agents, and the memberships below are the ones to check before assuming
  "claude-only" (all verified against `config.ts`, 2026-09-02): the per-node **context meter** is
  `USAGE_CAPABLE = claude/codex/gemini/grok` — grok states BOTH numbers, and its own percentage, in
  `signals.json`;
  the **permission mode** is `PERMISSION_MODE_CAPABLE = claude/grok/gemini/codex`; the session-name
  sync is **split in two** — `TITLE_READ_CAPABLE = claude/codex/grok/gemini` (read) ⊇
  `RENAME_CAPABLE = claude/grok` (write), because gemini and codex name their own sessions but have
  no rename command (codex's read leg is `readCodexSessionName`);
  **Context Link** spans five builtins
  (`CONTEXT_LINK_CAPABLE = claude/codex/gemini/opencode/grok`; the one builtin outside it is
  copilot). UI gates
  on these helpers — no hardcoded `=== 'claude'`. **Custom agents** (user-defined in Settings,
  `customAgents`) inherit the declared `baseAgent` harness through `capabilityAgentId`; a custom
  agent with no base remains spawn + terminal-title + process status only. Per-agent write-ups:
  **`docs/grok-agent.md`**, **`docs/gemini-agent.md`**, **`docs/copilot-agent.md`** (there is none for codex — its approval mapping
  and every value's reasoning live in `src/shared/agents/approval-mode.ts`);
  the distilled rules are **Adding a new agent** at the end of this section.
- **Model gateway / switcher** — `settings.modelGateway` stores one gateway root + a NON-SECRET
  credential reference: `${env:VAR}` for environment mode or
  `${secret:model-gateway-api-key}` for a literal held by `ModelGatewayCredentialService`. Desktop
  literal keys reuse the GitHub token store's safeStorage encryption / 0600 fallback; Server
  Edition uses the same generic 0600 atomic store. Legacy plaintext settings migrate only after
  the secret write succeeds. `shared/agents/model-gateway.ts` is the ONE mapping from a base
  harness to derived routes, env vars, compatible models and safely quoted model flags. Env
  expansion reuses `shared/agents/expansion.ts` and happens only in core against the host process
  environment; an unset reference fails closed instead of sending a token or partial credential.
  Discovery at `/v1/models` is the **OpenAI Models API convention**, implemented by both LiteLLM
  and Bifrost; the current `/openai/v1` + `/anthropic` launch-route derivation is Bifrost's layout,
  not the source of the discovery convention. Discovery sends the standard bearer header plus
  Bifrost's `x-bf-vk` header (needed by legacy, non-`sk-bf-` virtual keys), and runs in core
  (`agent:discover-models`) so browser CORS cannot block the Server Edition and the key never
  enters a terminal command. Support is a
  capability (`MODEL_SWITCH_CAPABLE = claude/codex/copilot`) resolved through `capabilityAgentId`, so a
  custom agent with a supported `baseAgent` inherits it automatically — the settings UI and canvas
  menu carry no agent allowlist. A model switch SIGTERMs the pane's foreground non-shell process
  group (never types `/exit`) and RECYCLES the tmux session before cold-resume: an existing shell may
  predate the gateway setting, and tmux env changes do not retroactively change that shell's
  environment. Recreating it guarantees the current URL/key applies without typing a secret into
  the pane. Ordinary Restart stays in-place. Custom-agent env is still merged last and may override
  the shared mapping. Desktop and Server Edition use the same core handler; relay tabs deliberately
  do not apply this machine's gateway to another core. Mobile needs a settings/model-picker surface
  before it can expose the feature.
- **Grok** (`@xai-official/grok` 1.0.0, builtin since 2026-08) — in `AGENT_HOOK_TARGETS`,
  `RESUMABLE_AGENTS`, `RENAME_CAPABLE`, `PERMISSION_MODE_CAPABLE`, `CANVAS_CONTROL_CAPABLE`,
  `CONTEXT_LINK_CAPABLE`, `CHAT_CAPABLE`, `TRANSFER_SOURCE_CAPABLE`, `USAGE_CAPABLE` and
  `SESSION_ID_CAPABLE`; NOT in `SUBAGENT_CAPABLE` — subagent cards still need the `spawn_subagent`
  PreToolUse/PostToolUse payload, which nobody has captured. The other four came off the blocked list
  in 2026-09, once a machine with a logged-in grok session produced real fixtures: context links and
  the ⌘M panel read `chat_history.jsonl` (NOT `updates.jsonl` — see below), and the meter reads
  `signals.json`. Its hook config is a **directory** (`$GROK_HOME/hooks/*.json`, all merged), so nodeterm
  **owns one file outright** (`nodeterm-status.json`) instead of merging into a shared settings file —
  which is also why a malformed copy of it is *healed* rather than preserved, locally and on an SSH
  host (`RemoteHooks.installGrokRemote`, under the host's own `$GROK_HOME`). Its dialect is
  **camelCase keys with snake_case event VALUES** (`{"hookEventName":"pre_tool_use"}`) — the SDK path
  flips the keys to snake_case, so `normalizeGrok` canonicalizes the event name and reads every field
  twice, and the shells share one decoder (`grokRawFields`). It carries **no `transcript_path`**, so a
  session directory is DERIVED from `cwd` + `sessionId` (`core/agents/grok-paths.ts`, the one
  `$GROK_HOME` rule — `core/usage/grok-usage.ts` delegates to it) and remembered in the shells' raw
  listener; the name read is `core/grok-session.ts` over `summary.json`, routed per agent by
  `core/agent-session-name.ts`. **The tool-event `matcher` is a regex: `.*`, never `*`** — a bare `*`
  is invalid and silently stops tool events firing (hence `ManagedHookEvent`). Grok also reads
  **`~/.claude/skills`** (Claude compat), which is why canvas control needed no new installer, and
  **`~/.claude/settings.json`**, so every grok event ALSO fires nodeterm's claude hook — an **inert**
  cross-fire (`normalizeClaude` finds neither grok's camelCase keys nor, in the SDK dialect, its
  lowercase event values), pinned by tests; canonicalizing claude's event-name compare would make it
  harmful. The `auto` permission-mode **version gate is claude's alone** (it is fed by a `claude
  --version` probe), and grok's mode flag must go **BEFORE** its `--` separator, which is
  end-of-options. Full picture, dialect traps and the device checklist: **`docs/grok-agent.md`**.
- **Gemini + codex parity** (2026-08-09) — brought both up to grok's level in the lists above. Unlike
  grok, **both CLIs are installed** and gemini **ships its own hook reference**
  (`/usr/lib/node_modules/@google/gemini-cli/bundle/docs/hooks/reference.md`), so almost every fact is
  measured. The load-bearing ones:
  - **Gemini's envelope IS claude-shaped** — `session_id`/`transcript_path`/`cwd`/`hook_event_name`
    (`reference.md:46-58`), the exact opposite of grok's missing `transcript_path`, so the shells just
    jail the path they are handed. The **event names** are gemini's own: eleven exist, `GEMINI_HOOK_EVENTS`
    subscribes **seven**. `AfterModel` is excluded because it fires **per streamed chunk**
    (`reference.md:236`) = one hook process per chunk; `BeforeModel` is **not** per-chunk (it fires once
    per request) and is excluded only because it reports nothing we render.
  - **`Notification` → `blocked`, matched as a CLOSED set** (`notification_type === 'ToolPermission'`).
    Before this, a gemini node sat on RUNNING while it waited for a permission answer. The closed match
    is measured, not cautious: gemini's `NotificationType` enum has exactly ONE member, and it fires
    only after `shouldConfirmExecute` returns details — i.e. only for a real dialog, so an
    auto-approved/`yolo` call fires nothing. **Grok's `includes('permission')` strobed on every tool
    call**; widening this "to be safe" is the unsafe direction.
  - **Context meter from each agent's own transcript** — one tail per agent, each with its own `parse`
    dep on `createContextTail` (`core/gemini-session.ts`, `core/codex-session.ts`), in **both** shells.
    Gemini: `tokens.input` and a window from `geminiWindowFor`, which mirrors the CLI's own
    `tokenLimit()` — a **family rule with a 1M catch-all default**, so an unknown model gets the right
    answer instead of a confident wrong denominator. Codex: `last_token_usage.input_tokens` and its own
    stated `model_context_window`. Two traps: `total_token_usage` is **CUMULATIVE** (would render a
    13%-full session at 79%), and `cached` is **INSIDE** `input` for both — while claude's input
    *excludes* cache reads, which is why claude sums them. **The formulas must not be unified.**
    The transcript jail is widened **per root** (`~/.gemini/tmp`, `<codexHome>/sessions`), never to
    `$HOME` — that predicate exists so a forged hook POST cannot aim a read at `~/.ssh/id_rsa`.
  - **`hasUsage` gated THREE features, not one.** Joining `USAGE_CAPABLE` also switched on
    `context.ensure` and the find bar's transcript index, both of which go through claude's
    `resolveTranscript` — whose **cwd fallback** then handed a codex node *the newest claude transcript
    for that cwd*: a stranger's session as its meter and its search hits. Now gated by the pure
    `readsClaudeTranscript` (`renderer/lib/transcriptGates.ts`), which reuses `CHAT_CAPABLE` rather than
    adding a fourth list. Non-claude agents lose only the mount-time head start.
  - **`TITLE_READ_CAPABLE` was created here**: gemini names its own sessions through its `update_topic`
    tool (the title is in that call's `args.title`, NOT a top-level field) but has no rename command, so
    the read and write legs split. Its read path is the transcript the context tail already tracks
    (injected as `AgentSessionNameDeps.geminiPathFor`, held in a `let` in `src/main/index.ts` to avoid a
    TDZ throw that would kill a node's whole poll chain).
  - **In-place restart** works for gemini: `EXIT_SEQUENCES.gemini = '/quit'` — and it must stay **bare**,
    because `/quit --delete` exits *and permanently deletes* the session history, i.e. exactly what the
    restart exists to resume (pinned by its own test).
  Full picture, measurements, gaps and a device checklist: **`docs/gemini-agent.md`**.
- **Permission mode** (agents in `PERMISSION_MODE_CAPABLE` — claude, grok, **gemini**, **codex**) —
  the mode a session **starts** in (`claude --permission-mode <mode>`; Shift+Tab still cycles it at
  runtime). Membership no longer implies claude's flag spelling: **the per-agent translation lives in
  `src/shared/agents/approval-mode.ts`** (`approvalFlags` / `modeSupported`), which is also where
  `withPermissionMode` now lives — it moved one layer up out of `config.ts` to break a cycle.
  gemini = `--approval-mode default|auto_edit|yolo|plan`, codex = `--ask-for-approval
  untrusted|on-request|never`. Two rules the mapping exists to enforce: a mode the CLI **cannot
  express emits NO flag**, never a substituted nearest match (codex has no `plan` and no
  edit-specific mode; **gemini has no `auto`** — nothing in its vocabulary means "approve most things
  but not edits", and since `auto` is the DEFAULT mode, mapping it to `auto_edit` would have switched
  auto-approve-edits on for every existing gemini node at upgrade time, silently), and "supports"
  must not be a lie either — codex's `manual` maps to
  `untrusted` because its built-in default is `OnRequest` (measured: `codex doctor`, no `approval`
  key in `~/.codex/config.toml`), so leaving it unflagged would deliver "the model decides when to
  ask" under an "Ask each time" label. **codex is the first agent where `manual` emits a flag.** The
  UI copy is DERIVED from the mapping (`permissionModeAgentIds` / `permissionModeAgentsLabel` /
  `unsupportedModesNote` / `bypassSandboxCaveat`) so a sentence cannot drift from what the table
  does — so the note now reads "Auto has no Gemini equivalent…" beside codex's two gaps, and the
  residual wart is only that `auto` and `manual` land on the same gemini policy (the *prompting* one).
  `--sandbox` is a separate axis and deliberately untouched (`--ask-for-approval never`
  still sandboxes).
  `settings.claudePermissionMode` (global, default **`auto`** — a behavior change for existing
  users, who previously got a prompt per action) is overridden per project by
  `project.defaultPermissionMode` (persisted to `.nodeterm/project.json`, so a `bypassPermissions`
  override travels to everyone who clones the repo — the tab menu warns). Modes are
  `manual | auto | acceptEdits | plan | bypassPermissions`, labelled once in
  `PERMISSION_MODE_LABELS` (from which `ALL_PERMISSION_MODES` is derived — the dropdown and the
  validator can't desync). `resolvePermissionMode(project, settings)` is the resolver
  (`renderer/state/permissionMode.ts` `activePermissionMode(agentId)` binds it to the live stores **and
  applies the version gate below — for `agentId === 'claude'` only**), and
  **`withPermissionMode(cmd, agentId, mode)` is the single
  funnel through which every agent-node launch site appends the flag** (new node, cold-restore
  resume, Branch, handoff/transfer, explain-commit, add-agent, canvas-control open-agent + team
  spawn). **WHERE the flag lands is decided at the composed layer** (`createAgentNode`), not in
  `withPermissionMode`: with no `argvPromptSeparator` (claude) it goes LAST, keeping the historical
  command byte-identical; with one (grok's `--`) it must go **BEFORE** the separator, because `--` is
  end-of-options and a flag after it is a positional — silently swallowed into the prompt or a clap
  usage error. Assert that at `createAgentNode`; a `withPermissionMode` test passes while the composed
  line is wrong. (gemini and codex declare no separator, so their flag goes last and their command
  lines stay byte-identical; grok is still the only agent taking the other branch.)
  UI: Settings → Agents, and the tab ⌄ menu for the per-project override.
  **Version gate (`auto` only) — CLAUDE's alone:** `--permission-mode auto` exists only in **Claude Code ≥ 2.1.71**;
  older CLIs validate the value against their own choices list and **exit 1** — and `auto` is the
  default, so an ungated flag would kill every Claude launch on an older CLI. So the CLI is probed
  (`core/claude-cli.ts` → `claude --version`, memoized, registered on `CorePlatform` so **both**
  shells serve it; reached from the renderer via `window.nodeTerminal.claude.cliCaps()`, with a
  **real** ws-bridge implementation) and `gatePermissionMode(mode, autoSupported)` degrades **only
  `auto`**, and only to `manual` = **no flag** = the bare pre-feature command. Everything **fails
  open**: unknown/unreadable version, a probe that failed or hasn't answered yet ⇒ bare command,
  never a blocked launch; the other four modes are never touched by the gate, and the user's
  *setting* stays `auto` (only the emitted command line changes). **SSH projects** are gated on the
  **remote** host's CLI, never the local one: `SshProjectManager.connect` probes `claude --version`
  on the host (through a login shell — an ssh exec channel's rc file usually bails out early — with
  `$HOME/.local/bin` + `$HOME/.claude/local` prepended to PATH: the official installer targets
  `~/.local/bin`, which a stock root `.profile` never adds, so a host whose interactive shells run
  claude fine still probed "not found" and silently degraded `auto` to manual) and
  caches the answer on the connection → `useSshConn`; not connected / not yet probed ⇒ no `auto`
  flag. A FAILED remote probe (claude not found — often a transient login-shell hiccup) **retries
  on a bounded backoff** (`PROBE_RETRY_DELAYS_MS`; every attempt pushes its answer immediately so
  launch waiters never block on the retry tail; a definite version — old or new — never retries),
  and the status event carries `remoteClaudeVersion` (`null` = probe failed) beside the boolean.
  The cold-restore relaunch `await`s the (shell-warmed) local probe because it fires on mount —
  and on an SSH project whose resolved mode is `auto` it also waits (`SSH_AUTO_PROBE_WAIT_MS`,
  bounded, fail-open) for the REMOTE probe's first answer, which races the same mount. Because
  the degrade is silent by design, the tab menu's Auto rows surface it: `sshAutoModeHint`
  (tri-state `useSshConn.autoPermAnswer` + probed version) puts a ⚠︎ + tooltip on "Auto" / "Use
  global (Auto)" for an SSH project whose remote CLI is too old / missing / not yet probed.
  **Security:** mode values come from hand-editable, git-shared JSON and end up interpolated into
  a shell command line (tmux `send-keys`), so `permissionModeFlag` **re-validates** the mode at the
  interpolation site (the type is compile-time only) — an unrecognized mode yields **no flag**, i.e.
  the bare, safe command. `'manual'` likewise yields no flag, reproducing the pre-feature command
  bit-for-bit. The setting and the per-project override apply to **terminal (CLI) agent nodes only**
  (the SDK **chat node**, which never honored it, was removed 2026-07). **No other agent inherits this
  gate:** grok has accepted every mode since 1.0.0 and gemini/codex accept theirs on the versions we
  measured, so gating any of them on a `claude --version` probe would
  downgrade their sessions on a machine whose claude is old or absent — `activePermissionMode` gates
  only `'claude'`, `ensureActivePermissionMode` awaits the probes only for `'claude'`, and
  `sshAutoModeHint`'s copy names Claude in every sentence for the same reason. An agent needing its
  own gate adds one beside claude's.
- **State via each agent's hooks → shared 4-state model** — detection uses the agent's own
  hooks, **not** output parsing. `src/shared/agents/normalize.ts` has per-agent normalizers
  (`normalizeClaude`/`normalizeCodex`/`normalizeGemini`/`normalizeCopilot`/`normalizeOpencode`/`normalizeGrok`) that map each agent's native hook
  events to a `NormalizedAgentEvent` over the shared `AgentState` (`working | waiting | blocked
  | done`) plus subagent/recurring/session kinds. Canvas's listener consumes
  `NormalizedAgentEvent` from `agent:status`, drives the `agentStatus` store, fires throttled
  (5s/node) background notifications, and records the session id. Header shows a pulsing
  **RUNNING** (working) / **NEEDS YOU** (waiting/blocked) badge.
- **Hook server (loopback HTTP)** — `src/core/agents/hook-server.ts` is a main-process
  loopback HTTP server (per-session bearer token, fail-open) that the installed hook scripts
  POST to; it replaced the old `fs.watch` signal-log mechanism. `buildPtyEnv` injects the
  node id + endpoint/token into each spawned session's env; because tmux sessions **outlive
  the app**, the server also writes `<userData>/hook-endpoint.env` so a relaunched main
  process re-advertises the same endpoint (restart handoff). A `setRawListener` channel feeds
  the per-node context-window meter (`context-tail.ts` — **one tail per agent**, each with its own
  `parse` dep: claude's usage records, `codexContextParse`, `geminiContextParse`) and the subagent
  live-transcript (`subagent-tail.ts` — claude via meta-dir `track`, codex via `trackFile` with the
  stateful `codex-subagent-format.ts` formatter). The same events feed the **agent-status mirror**
  (`core/agent-status-mirror.ts`) the mobile companion reads; the mirror carries an optional
  `settings` block (`claudePermissionMode`/`autoSupported`/`claudeAccounts`) so the phone can
  launch agents with the desktop's permission mode + managed accounts, and SSH slices get their
  **per-host** settings (remote CLI caps + host-matched accounts) injected via
  `remote-status-push`'s `settingsFor` dep.
- **Hook installers** — `src/core/agents/hooks/` holds per-agent hook services + an installer
  registry `MANAGED_HOOK_INSTALLERS`. `managed-script.ts` builds the POSIX hook script that
  POSTs to the server (env-gated: a no-op in the user's normal terminals, active only in
  sessions nodeterm spawns; the `claude-signals` string is kept as the idempotency marker that
  migrates users off the old hook). claude → `~/.claude/settings.json` and gemini →
  `~/.gemini/settings.json` (shared `install-helper.ts`, merged/idempotent, preserving other
  tools' hooks); codex → `~/.codex/hooks.json` + `~/.codex/config.toml` trust entries
  (`codex-trust.ts` — the hash gates whether codex runs the hook); **grok → our OWN file
  `$GROK_HOME/hooks/nodeterm-status.json`** (its hook config is a directory whose files are all
  merged, so there is nothing of the user's inside ours — which is also why a malformed copy is
  *healed*, not preserved, on both the local and the SSH path). The per-event **`matcher`** the grok
  installer needs is why events are typed `ManagedHookEvent` (`string | {event, matcher}`): grok's
  tool matcher is a REGEX and must be `.*` — a bare `*` is invalid and silently stops tool events
  firing. Plain-string events keep their byte-identical output for every other agent.
  **Codex is the one agent whose hook command is NOT a POSIX one-liner on Windows** (issue #567):
  it builds the command as `cmd.exe /C <string>` (`codex-rs/hooks/src/engine/command_runner.rs`,
  rust-v0.151.0) unless the session has a shell configured, which a default Windows install has
  not — so `if [ -x '…' ]; then …; fi` answered `-x was unexpected at this time.` and **exit 1 on
  every event**, for the life of the node. Claude is fine there only because Claude Code runs its
  hooks through Git Bash. The fix is a batch entry point (`codex-hook.cmd`,
  `codex-windows-wrapper.ts`) written beside `codex.sh` and named by `buildManagedCommand`'s win32
  branch; it **locates a POSIX shell and runs the same script** — deliberately not a second
  implementation of the hook protocol, which would be two copies of the POST/failover/token/
  permission-poll to drift. Three rules it must keep: pass stdin through, DRAIN stdin on every bail
  (codex writes the payload there; #186/#187), and exit 0 when there is no shell or no script.
  Two traps around it: `buildManagedCommand`'s `platform` is the platform of the machine that will
  RUN codex, so `RemoteHooks.installCodexRemote` passes POSIX explicitly (a Windows desktop must not
  put a `.cmd` command on a Linux host); and `isManagedCommand` matches **both** leaves
  (`codex.sh` AND `codex-hook.cmd`) on every platform — matching only the local one would leave a
  pre-fix entry unrecognized, so the fresh one is appended beside it, which is #558 on a second
  file. Matching both is what REPAIRS an existing Windows install at the next launch. **Both
  sides of the managed-entry match go through `normalizeHookCommand`** — the marker used to be
  folded to `/` while the stored command was compared raw, so on Windows nodeterm never recognized
  its OWN entry and appended a fresh set every launch (#558: nine copies of nine events, nine
  `claude.sh` processes per Stop, nine 45 s `PermissionRequest` waits racing one prompt). Because
  `mergeManagedHook` drops every managed entry before pushing one fresh, the corrected match IS the
  repair for a file already ruined — it runs at boot via `installManagedAgentHooks` and, being the
  ONE shared merge, heals claude/gemini/grok, every managed Claude account dir and all three SSH
  remote installers at once; a second repair mechanism would be exactly the duplicated rule this
  file warns about. It strips only OUR handler out of a definition, so a hook a user hand-merged
  beside ours survives.
- **Per-node hook identity** (`src/core/agents/node-auth-*.ts`, `node-token-*.ts`,
  `node-identity-policy.ts` — full write-up in **`docs/node-identity.md`**) — the shared bearer proves
  "a session on this machine", never *which* session, so every node also gets a capability derived
  from one restart-stable secret (`kid.mac`, domain-separated HMAC over the node id), handed to the
  client as a 0600 file and verified three ways: `verified` / `legacy` / `forged`. `legacy` is "we
  cannot judge this", not a failure. Two invariants come out of this series and both cost real
  incidents to learn:
  - **A credential never rides argv — local or SSH.** Measured 2026-08-13: `buildPtyEnv` put the hook
    bearer in the tmux `-e` argv, which lands in a long-lived tmux client's `/proc/<pid>/cmdline`
    at **mode 444** on a stock Linux with no `hidepid`; combined with `open-terminal --cmd` not being
    in the confirm-gated `DESTRUCTIVE` set, that was arbitrary command execution as the victim from
    any account on the box. A remote command line is argv on **both** ends, so the same rule binds
    every `ssh`/`curl` we generate. Credentials travel by 0600 file or by **stdin**
    (`curl --config -`, already house style in `usage/remote-claude-usage.ts` and
    `codex-identity-proxy.ts`). Never add an argv fallback "for old curl" — that undoes the fix.
  - **Both raw listeners change together** — `src/main/index.ts` and `src/server/agent-status.ts`.
    A new field on the hook event (the `verified` flag was one) that reaches only the desktop leaves
    the Server Edition silently without the feature; the boundary tests cannot tell you a field is
    *missing*. `hook-verified-parity.test.ts` asserts it at source level because this repo has
    shipped a one-shell hook-server change three times.
  - **Every generated sh client reads the token through ONE resolver** (`nt_read_node_token`,
    `core/agents/node-token-sh.ts`) — the managed hook script, `nodeterm.sh` and `context.sh`. The
    token dir is advertised only by the endpoint FILE, and a session is pinned for life to the
    endpoint PATH it got at tmux creation, so a client that reads only what that file advertises
    presents nothing forever when the file is pre-v2 (SSH hosts' shared `~/.nodeterm/hook-
    endpoint.env`, whose per-project socket path is re-bound on every connect, so it stays LIVE) or
    unreadable (a phone-spawned session). Issue #384: the hook script FAILS OVER and re-reads the
    token from the endpoint it adopts, the two shims did neither — so the same node proved itself
    through one client and was refused through the other by the trust-on-first-proof latch, for the
    life of the session. The resolver falls back to `<dir of the endpoint file>/node-tokens` (the
    layout by construction on all three surfaces) and then the well-known data dirs; it is monotone
    — advertised dir first, keyed by node-id filename in every candidate, and a foreign instance's
    dir yields a foreign `kid` = `legacy` = exactly what presenting nothing already gave.
  - **Every generated sh client walks the SAME endpoint failover** (`nt_candidates`/`nt_adopt`,
    `core/agents/hook-endpoint-failover-sh.ts`) — issue #445, the endpoint-level twin of #384: a
    session is pinned for life to the endpoint PATH it got at tmux creation, so an app
    quit/restart (or a retired project id) leaves it POSTing at a dead port while a live endpoint
    file sits right next to it. The managed hook script had the bounded candidate walk (locals
    before tunnels, `nt_fallback_max` 3, token re-read from the ADOPTED endpoint's dir); the two
    shims did not, so hook events healed themselves while every canvas-control verb died with
    "control endpoint unreachable" — in the field, a reviewer launch silently dropped. Now shared,
    one definition. Two server-side halves in `hook-server.ts`: a FAILED `listen()` un-wedges the
    singleton (it used to leave `this.server` set, making every retry a silent no-op at port 0)
    and both `stop()` and the failed-start path delete `hook-endpoint.env` — publication reflects
    listener liveness; a crash skips that, which is exactly what the client walk exists for. An
    HTTP answer of any code is authoritative: only a dead transport (curl 000/'') fails over, so a
    403/400 is never re-sent to another instance. The walk is skipped under
    `CODEX_SANDBOX_NETWORK_DISABLED` (#367 — the sandbox denies every connect, the hint is the
    right diagnosis) and the final error now distinguishes "no endpoint anywhere" from "an
    advertised endpoint that is not listening" (`STALE_ENDPOINT_HINT`). Desktop quit calls
    `hookServer.stop()` on the second before-quit pass, after the flush window.

  Enforcement is dated (`NODE_IDENTITY_STRICT_AFTER`, 2026-10-13, read through `isStrictInstant` so a
  clock years ahead cannot enter strict mode early) with a `settings.hookIdentityStrict` escape hatch
  in Settings → Agents. **Trust on first proof latches a node the moment it authenticates, so it
  refuses TODAY, not on the cutoff** — which is why every token sweep must also call
  `hookServer.forgetProvenNode`. `/hook/*` never 403s a missing token: the phone, the cross-instance
  failover and every pre-token session legitimately have none.
- **Fullscreen TUI (Claude)** — through the SAME `settings.json` seam the hook installer uses,
  nodeterm ensures Claude's `"tui": "fullscreen"` so a session takes the alternate screen + mouse
  and behaves natively in tmux (else a drag falls into copy-mode). Two guardrails: **write-if-absent**
  (any existing `tui` value — e.g. a user's `/tui default` — is never touched;
  `core/agents/hooks/claude-tui.ts` `ensureFullscreenTui`) and **version-gated** to CLI ≥ 2.1.89
  (`supportsFullscreenTui` / `claudeCliCaps().fullscreenTui`; unknown ⇒ don't write). Runs
  everywhere the hook seam does: local `~/.claude` + managed account dirs at launch/add-account
  (`ensureClaudeFullscreenTui{,Into}`), and the remote host + account dirs on SSH connect
  (`RemoteHooks.ensureFullscreenTui{,InAccountDir}`, gated on the connection's cached remote probe).
  **Grok has no analogue** — it runs full-screen by default, so there is nothing to write.
- **Unread + notification** — on a busy→idle edge while the window is unfocused
  (`document.hasFocus()`), the node is marked unread (header dot, minimap stroke, project-tab
  dot). If notifications are enabled, `window.nodeTerminal.notify()` → main `app:notify`
  (shown only when `mainWin.isFocused()` is false); clicking it focuses the window and sends
  `app:focus-node` → `Canvas.focusNodeById` (selects + centers, switching projects via
  `pendingFocusRef` if needed). A one-time consent prompt gates notifications; toggle in
  Settings (`notifyOnClaudeDone`). Selecting, focusing, dwelling into, or opening a session card
  clears `unread` and ACKs the finish across phone/notch surfaces — existing read-on-view behavior.
  This NEVER changes the workflow bucket: read state is independent from agent state.
- **Status-grouped sessions** — three always-visible sections: **Waiting for your response** maps
  internal `done`, `waiting`, and `blocked` together (a completed turn, question, or approval all
  need the user); **Running** maps `working`; **Unknown** means no live hook state is available.
  There is no Done bucket: a normal `done` hook means the turn ended and the agent is waiting for
  another user prompt. Within each section rows sort newest-first by `lastEventAt`, the transition
  clock (same-state hook freshness is `stateAt`), and show its short relative age. Missing clocks
  stay last with no made-up timestamp. A click may clear the glow but cannot move the row.
- **Session name ⇄ node title** — **two lists, because the two directions are separate facts**:
  `TITLE_READ_CAPABLE` (`canReadTitle` — claude, **codex**, grok, **gemini**) is the READ leg,
  `RENAME_CAPABLE` (`canRename` — claude, grok) the WRITE leg, and **read ⊇ write** is an invariant
  pinned in `config.capabilities.test.ts`. Gemini and codex are the reason: they name their own
  sessions (codex via `readCodexSessionName`) but have **no rename command** (gemini's `/chat save
  <tag>` is a checkpoint, not a title), so one list for both legs would light the rename UI on a
  node where the write silently does nothing. The **write** is the same literal
  `/rename <name>` for claude and grok; the **read** legs are per-agent and none may ever
  search another's tree, so the routing lives in ONE place, `core/agent-session-name.ts`
  (`readAgentSessionName(sessionId, accountId?, agentId?, deps?)` — trailing/optional so every pre-grok
  caller is unchanged), serving the desktop IPC handler **and** both shells' session-name sweeps.
  Grok's read leg is `core/grok-session.ts` over `summary.json` in the session dir a hook told us
  about; gemini's is `pickGeminiTitle` (`core/gemini-session.ts`) over the transcript path its context
  tail already tracks — including the `$set` history a **resume** replays, which is exactly the case the
  read leg exists for. Routing is not cosmetic — claude's resolver *scans* `~/.claude/projects` on a
  cache miss, so an unrouted grok/gemini node paid that scan every 60 s for a guaranteed null.
  **The sweep's gate lives in core, not in the shells:** `startSessionNameSweep` defaults `supports` to
  `supportsTitleRead` (`core/session-name-sweep.ts`) and neither shell passes it — the duplicated copies
  drifted, and reverting both to `canRename` left the whole suite green while silently skipping every
  gemini node.
  - **session → title (read, claude):** the authoritative name lives in the transcript `.jsonl`, not the
    OSC terminal title (`/rename` does **not** update OSC — a known Claude gap — so reading the
    file is the only thing that works after a **resume**). `core/transcript-reader.ts`
    `readSessionName(sessionId)` resolves the session file **strictly by sessionId** (no cwd
    fallback — that would make every Claude node in one folder resolve to the same newest transcript
    and adopt each other's names) and `pickSessionName` returns the latest `custom-title`'s
    `customTitle` (the `/rename` name) else the latest `ai-title`'s `aiTitle` (auto name). Exposed
    over `pty.readSessionName`. `TerminalNode` polls it (~4 s) **only once this node's own sessionId
    is known** and **while the title still auto-tracks** (`data.titleAuto`, default true on agent
    nodes), and adopts it as the `title`. `term.onTitleChange` now feeds the `session` chip only.
  - **title → session (write):** the moment the user renames the node by hand (header rename box /
    ✦ AI-name / sidebar / command palette → all funnel through `applyManualTitle` or
    `renameSession`), `titleAuto` flips to **false** (polling stops overwriting) and the chosen name
    is pushed into the live session as `/rename <name>` via `pty.sendText` (tmux `send-keys`, same
    one-way bridge as Branch's `/branch`; works whether or not the node is mounted).
  - The launch command is left bare (no `-n`) — Claude's own name is canonical until the user
    overrides it; `titleAuto` is persisted so an overridden name survives reload/resume.
- **Search** — the command palette (⌘K) matches the session name + tags + `nt-<id>` in the
  hint, and substring-searches each terminal's **visible buffer** (captured via `pty.capture`
  on palette open, cached ~3s); content matches show "found in output".
- **⌘M transcript view (`ChatPanel`) — resolution is three-legged, and each leg fails differently.**
  `chat.readTranscript(sessionId, cwd, accountId, nodeId)` returns `ChatTranscriptResult
  {messages, found}`, NOT a bare array: an empty thread and an unresolvable transcript are
  different facts, and rendering both as "No conversation yet." is what made every failure below
  look like an empty session. (1) **Remote (SSH) nodes** — `remoteTranscriptBySession` is fed
  ONLY by hook POSTs, and a tmux session outlives the app, so after a restart an idle remote node
  has no ref and the local resolvers search the WRONG MACHINE. `remoteTranscriptRefFor` (main)
  therefore asks the host itself: the pure `core/remote-transcript-locate.ts` builds one `sh` line
  (exact `<root>/<encoded cwd>/<id>.jsonl` per root, then a glob; account root before the system
  one; `*` outside the quotes; **exits 0 on a clean miss** — "no transcript" is an answer, not a
  failed ssh), it runs over the ControlMaster, and the reply is jailed by
  `isSafeRemoteTranscriptPath` before it is read. A ref WE located is tracked in
  `locatedTranscriptSessions` so a dead one can be dropped on an empty read (the panel's Retry
  would otherwise replay it forever) — a HOOK-fed ref is never dropped that way, since an empty
  read there is usually a transient master hiccup and forgetting it sends the next read local.
  It is generated shell, so `remote-transcript-locate.test.ts` runs it for real under `/bin/sh`
  against a fake host tree — keep it that way. (2) **The cwd fallback keeps `accountId`** in BOTH
  `resolveTranscript` and `contextEnsure`; without it a managed-account node fell back to the
  system root and could adopt an unrelated session's newest transcript. (3) **Relay tabs** stay
  local-only (a transcript read over the relay would read the GUEST's disk) and reject with
  `E_UNSUPPORTED`; ChatPanel catches it and says so instead of leaving the initial `[]` on screen
  as an empty conversation. Same `nodeId` rides `claude.readTranscript`, so the find-bar searches
  a remote node's transcript too.
  **Both channels live in `core/transcript-ipc.ts` (`registerTranscriptIpc`), so the Server
  Edition serves them too** — it used to have no handler at all, which is why ⌘M in the browser
  read as an empty conversation on EVERY session. The remote leg is an injected dep
  (`readRemote` — `null` = "not a remote session"): `src/main` supplies it, the server passes
  none, which is complete there because it runs ON the host whose transcripts it reads. The
  server registers it in `src/server/index.ts` right after `wireAgentStatus` (which now returns
  its `contextTail`, the hook-fed path authority). The browser's real reader is
  `buildTranscriptApi` in ws-bridge — deliberately NOT folded into `buildClaudeApi`, which the
  relay shares and must not adopt it.
- **Subagent visualization** (agents in `SUBAGENT_CAPABLE`) — `subagent-start`/`subagent-end`
  normalized events (from Claude's `PreToolUse`/`PostToolUse` on tool `Agent`/`Task`, correlated
  by `tool_use_id`) drive a transient `state/agentNodes.ts` store. Claude launches subagents
  **async by default**: that PostToolUse is only a launch ack (`status:'async_launched'`), NOT the
  end — normalize keeps the card working, the transcript tail keeps streaming, and the real end is
  the `<task-notification>` queued into the parent transcript (sniffed by the context tails →
  synthetic `subagent-end` in `index.ts`; the notification's `UserPromptSubmit` is also not a
  `newTurn`, so it doesn't clear the fan-out). Canvas renders each subagent
  as an **ephemeral** `SubagentNode` (display-only card: type + task + working/done) connected by
  an **edge** to its parent agent node. These ephemeral nodes/edges live outside the React Flow
  `nodes` state (merged only at the `<ReactFlow>` prop), so they're never persisted
  (`flowToNodeStates`) nor in undo/dirty. **Two different clears, and the difference is
  load-bearing (issue #547):** the removal paths (node delete, project delete, the cross-project
  close, the orphan-session kill, `SessionEnd`) call `clearForParent`, which drops everything —
  a node that is gone has no work left to represent. A **new turn** calls
  `clearFinishedForParent`, which drops only `state === 'done'`. "The previous fan-out is stale by
  definition" is true of a finished card and false of a working one: Claude launches subagents
  **async**, so *"waiting for N background agents to finish"* is exactly the state in which the
  next prompt gets typed, and nothing rehydrates `byId` afterwards (`start()` fires only from a
  live `PreToolUse`; a subagent past that emits no second one) — the card was gone for the rest of
  the run while the agent kept working. The expensive half is not the missing card: Eco's
  hibernation guard derives `liveSubagents` from this same store, so the wipe let a parent with
  live background agents read as idle and get its CLI `/exit`ed. Keeping an unfinished card then
  **owes a decay** — `useAgentNodes.sweepStaleWorking`, on the same 60 s tick and the same
  `WORKING_STALE_MS` as `agentStatus`'s (imported, never re-chosen: `shared/agents/stale.ts` exists
  because three surfaces each invented their own timeout) — or a subagent whose end never arrives
  pins its card, and its parent, forever. It marks the card **done** rather than deleting it, so a
  late `finish()` is the no-op it already was and the next turn boundary takes it.
  (Subagents share the parent's process — no PTY.) Each card shows
  duration/tokens/tool-uses and **expands** (click) to a **live transcript**:
  `core/subagent-tail.ts` resolves the subagent's own transcript file
  (`<…>/<sessionId>/subagents/agent-<id>.jsonl`, matched by `tool_use_id` via the sibling
  `.meta.json`), tails it read-only, formats each line (assistant text + tool calls + results),
  and streams chunks over `agent:subagent-activity` into the store.
  **Codex** (2026-08-24, `spawn_agent` collaboration — issue #401) joined via its **native
  `SubagentStart`/`SubagentStop` hooks**, measured on codex-cli 0.146.0, keyed by `agent_id` (NOT
  `tool_use_id` — nothing correlates the spawn tool call with the Start it launches; agent_id is
  stable across the child's life, parallel + nested spawns included, and nested children fire
  through the same subscription so every card connects flat to the owning terminal node). Facts a
  refactor must not lose: **(1)** every agent_id-tagged codex event carries the PARENT's
  `session_id` with the CHILD's rollout as `transcript_path` — both raw listeners skip the
  context-meter track for them (else the parent's meter re-points at the child) and `normalizeCodex`
  returns null for child tool events (else a child Bash event flips a finished parent back to
  RUNNING after an async spawn); pinned by `hook-verified-parity.test.ts`. **(2)** the spawn task
  text is **encrypted end-to-end** (`tool_input.message` and the NEW_TASK payload are Fernet blobs)
  — there is no `taskLabel`; the readable `Task name:` header reaches the card via the activity
  stream instead. **(3)** the live tail is `subagentTail.trackFile` (the path is handed to us —
  no meta-dir matching) with the **stateful, per-entry** `createCodexSubagentFormatter`
  (`core/codex-subagent-format.ts`): a spawn child is a FORK of the parent thread, so its rollout
  opens with a replay of the parent's context, suppressed until the
  `inter_agent_communication_metadata` / NEW_TASK gate — per entry, because two concurrent
  subagents sharing one closure would gate each other. **(4)** codex's `SubagentStop` IS the real
  end (no async-launch-ack trap, no task-notification sniffing), carrying
  `last_assistant_message` as the card's result. Remote (SSH) codex nodes get cards but no live
  activity yet (the child rollout is on the host; claude's `remote-subagent-tail` has no codex
  counterpart — follow-up).
  **A child that was already running before this app process started is invisible, by design of a
  hook-driven pipeline** (consort finding on the v0.3.4 merge, ACKNOWLEDGED not fixed): tracking is
  created by `SubagentStart`, that event is one-shot, and a tmux session outlives the app — so
  after a restart the child's later activity and its `SubagentStop` are discarded for want of a
  card. Claude's Task subagents behave identically. This fork briefly did better: the deleted
  `core/codex-agents-tail.ts` read the parent rollout's `SubAgentActivity` records from DISK and
  `liveCodexSubagentActivities` deliberately kept an unpaired `started` as the app-restart pickup.
  It was removed as superseded here because running it BESIDE the native hooks keys the same child
  two ways (`cxagent:<threadId>` vs `agent_id`) and renders **two cards**. Restoring the pickup
  therefore means reconciling the two keyings, not reviving the file.
- **Large fan-outs collapse to ONE aggregate card** (2026-09-02, `renderer/lib/fanoutGroup.ts`,
  `FANOUT_COMPACT_THRESHOLD = 6`): a 17-agent workflow tiled 17 ephemeral cards over the real nodes
  with 17 edges from one parent — unarrangeable by design (ephemeral nodes live outside React Flow's
  `nodes` state) and unreadable [screenshot-measured]. Above six LIVE cards for one parent, Canvas
  renders a single `fanout-<parentId>` card (counts working/done/errored, elapsed) with one edge,
  placed where the first card would have gone; it expands into a scrollable list of the individual
  cards, each still subscribing to its own live transcript, so nothing is lost. Six or fewer render
  individually as before (a hand-sized `parallel()` stays untouched). The aggregate is as ephemeral
  as the cards it replaces: `isEphemeralId` knows the `fanout-` prefix, its size/position overrides
  and selection are dropped on the same new-turn/session-end/close events, and it is never persisted.
- **Workflow (ultracode) agent visualization** — Claude Code's Workflow tool spawns N agents
  in-process; they fire **no per-agent hooks** at all, so there is nothing to normalize per
  agent. Only the PARENT session's `PreToolUse`/`PostToolUse` on `tool_name === 'Workflow'`
  fire, and the shells' RAW listeners (mirroring how `SUBAGENT_TOOLS` is handled there) START
  `core/workflow-agents-tail.ts` on either of them (begin is idempotent). **The Workflow tool is
  a BACKGROUND launch — its PostToolUse is only the ack, ~1 s after Pre, while the agents run for
  minutes — so PostToolUse must never `end()` the tail** (the first ship did exactly that and
  grace-closed the watch before the journal had a record: no cards at all). The real end is the
  `<task-notification>` queued into the parent transcript, which carries the Workflow call's own
  `tool_use_id` = the begin key — `onTaskNotification` in both shells calls `workflowTail.end`
  unconditionally (an unknown key is a no-op, so no workflow-vs-Task discrimination is needed).
  A run whose notification never lands is closed by the tail's own idle backstop (all agents
  ended + disk quiet past `IDLE_CLOSE_MS`; a begin that never grows a dir drops after
  `BEGIN_ORPHAN_MS`), with SessionEnd / node teardown as the last resort. Closed dirs are KEPT
  in the map until release — deleting them would let a still-active begin on the same root
  (concurrent workflows on one node) re-adopt an ended run's dir at offset 0 and replay its
  journal as duplicate cards. The tail fs-tails
  `<transcriptPath minus .jsonl>/subagents/workflows/<wf_runId>/journal.jsonl` for `started`/
  `result` records (undocumented Claude internals — same risk tier as the Task subagent tail
  above; expect to re-measure on CLI upgrades) — a killed/errored agent gets `started` but never
  `result` (`end()`'s grace-window force-close heals it a card + end). Adoption is
  **offset-from-current-size on the begin-time scan**: `begin()` readdirs the root IMMEDIATELY
  (PreToolUse hooks are blocking, so the current run's `wf_*` dir cannot exist yet), adopting any
  dir already there at its journal's current length — a PRIOR run's journal stays silent, only a
  genuinely **resumed** run (which reuses its `wf_*` dir and appends) streams, and a dir appearing
  later reads from offset 0. An ENOENT root at that first look is an ANSWER (no prior run ever
  existed), never a deferred first scan. `end()` mirrors `subagent-tail.finish`: dirs stay OPEN
  and streaming through a 1.5 s grace window (plus one late scan, so a sub-500 ms run is still
  discovered), with the force-close at the window's END; `release()` marks dirs dropped so an
  in-flight async read can never emit into a torn-down node. Dir→begin association is scoped to
  the ROOT (concurrent Workflow calls on different nodes must never cross-attribute). Each event
  re-enters the pipeline as an ordinary synthetic `subagent-start`/`subagent-end`
  (`toolUseId: 'wfagent:<wfDirName>:<agentId>'`, `agentId: 'claude'`) plus chunks on the existing
  `agent:subagent-activity` channel keyed by the same id — the renderer needed **zero** changes:
  `state/agentNodes.ts` and Canvas's `agent:status`/`onSubagentActivity` listeners neither assume
  a toolUseId shape nor gate on `SUBAGENT_CAPABLE` (that list only gates the shells' own decision
  to attempt a tail). **Remote (SSH) sessions are a documented degrade, not wired**: the journal
  lives on the host, and `workflow-agents-tail.ts` reads local disk only — no ControlMaster leg —
  so a Workflow run on an SSH-project node shows the parent tool call's ordinary `working` state
  and nothing more, exactly like before this feature.
- **/loop, /schedule & /cron node** (agents in `RECURRING_CAPABLE`) — detected from the **tools**
  the agent invokes (robust; users often phrase it in natural language so the prompt rarely starts
  with the slash): `PreToolUse` for `Skill` (skill ∈ loop/schedule/cron), `CronCreate` (→ cron,
  label = cron expr · prompt), or `ScheduleWakeup` (→ loop) — plus a `UserPromptSubmit`
  `/loop|/schedule|/cron` prompt-prefix fallback, all surfaced as `recurring` normalized events.
  Sets `agentStatus.loop` ({count, prompt, items, kind}); for in-session `loop` each turn-done
  bumps the count + appends `lastMessage` (schedule/cron run in the background, so they aren't
  counted). Lifetime by kind: `loop` dies with its session; `cron`/`schedule` **outlive turns,
  sessions and app restarts** (`loop` is persisted in the agentStatus localStorage) and are
  cleared by a `CronDelete` `recurring`-end event or the card's own × (dismisses the card only).
  `clearForParent` (new turn) leaves the loop card's dragged position alone. Renders an ephemeral
  **LoopNode** labelled by kind, connected by an edge to the parent, plus a small header badge.
- **Branch conversation** — node action (`IconBranch`, Claude-only via `BRANCH_CAPABLE`): sends `/branch` into the
  existing terminal via `pty.sendText` (tmux `send-keys`) and opens a new Claude node that
  resumes the parked original with `claude --settings … -r <ORIGINAL_ID>`. The original id is
  the session id already known from hooks; `lib/claudeBranch.ts` is the fallback that parses
  `pty.capture` output when the id isn't known. The source node stays on the new branch.

### Adding a new agent (or a new model) — what to watch out for

Every rule below is a mistake the grok branch or the codex/gemini-parity branch **actually made**, and
each one cost a review round or shipped a wrong number to the user. Read the concrete failure, not the
principle. Per-agent write-ups: `docs/grok-agent.md`, `docs/gemini-agent.md`.

**The mechanism**

1. **A capability is a membership list plus ONE leaf.** Add the id to the list in
   `src/shared/agents/config.ts`, write the one per-agent thing that list gates (a normalizer, a
   reader, a table row), and every consumer lights up — the whole point of the design. What you must
   never do is fork behavior at a call site with `=== 'claude'`; ask through the helper.
2. **Ask what ELSE the list gates before joining it.** `hasUsage` gated **three** features, not one.
   Joining `USAGE_CAPABLE` for the context meter also switched on `context.ensure` and the find bar's
   transcript index, both of which resolve through *claude's* `resolveTranscript` — whose **cwd
   fallback** then handed a codex node **the newest claude transcript for that cwd**: a stranger's
   session as its meter (wrong numerator *and* denominator, flapping against the correct tail) and that
   session's messages as its search hits. Preconditions were default-true, so it would have shipped.
   The fix was a new pure predicate (`readsClaudeTranscript`) reusing an existing list, not a fourth
   list meaning the same thing. **Grep every consumer of the helper before you add an id to its list.**
3. **A read leg and a write leg are different facts, and may need different lists.** Gemini names its
   own sessions but has **no rename command**, so `TITLE_READ_CAPABLE` (read) split from
   `RENAME_CAPABLE` (write), with `read ⊇ write` pinned as an invariant. One list would have lit the
   rename UI on a node where the write silently does nothing — the worst kind of feature, one that
   looks like it worked.
4. **State Desktop / Server Edition / Mobile for the capability, even when the answer is "N/A".**
   Put the logic in `src/core` behind `CorePlatform` or the Server Edition silently doesn't have it,
   and give `window.nodeTerminal` a REAL bridge implementation or a documented degrade — a `noop` stub
   compiles fine while doing nothing. (Live example: the session-title READ has no server handler at
   all, so it is stubbed for **claude too** — a pre-existing gap that keeps being rediscovered per
   agent.)

**Measuring the CLI**

5. **Measure the CLI; do not assume claude's shape.** Three real bugs, all from assuming:
   - grok's `--` is **end-of-options**, so a flag appended *after* the prompt separator is a
     positional — silently swallowed into the prompt, or a clap usage error that kills the launch.
     Where the flag lands is decided at the **composed** layer (`createAgentNode`); a
     `withPermissionMode` unit test passes while the composed line is wrong.
   - codex's `total_token_usage` is **CUMULATIVE**, not the live context: against its own window it
     rendered a 13%-full session at **79%** and would have crossed 100% two turns later. The right
     field is `last_token_usage`.
   - `cached` tokens are **INSIDE** `input` for codex and gemini, and **OUTSIDE** it for claude (whose
     reader therefore sums them). Copying claude's formula double-counts. **Do not unify the
     formulas.**
6. **Prefer the agent's own stated number over one you infer.** Codex prints
   `model_context_window` right beside its usage — use it. When there is none, mirror the CLI's own
   resolver rather than building a per-model allowlist: gemini's `tokenLimit()` is a family rule with
   a **1M catch-all default**, so an unreleased model gets the *right* answer where an allowlist would
   be confidently wrong, silently. **And if you cannot establish a trustworthy denominator, ship no
   meter** — a percentage over a guessed window is a wrong number presented as a fact. This used to
   cite grok as the example of having no meter; grok turned out to be the BEST case for this rule,
   stating `contextTokensUsed`, `contextWindowTokens` **and** the resulting `contextWindowUsage` in
   `signals.json` (all three present in 22 of 22 measured sessions, and the stated percentage agrees
   with the division in all 22 — an oracle pinned as a test). What was missing was never the number:
   it was a comment nobody could check, naming the wrong file.
7. **A closed set beats a substring, for notification/event types.** Grok's
   `type.includes('permission')` matched a notification grok fires before *every* tool call, so a
   working node strobed NEEDS YOU: unread dot + chime + OS notification + phone inbox card, per tool
   call. Gemini is matched `=== 'ToolPermission'` and stays quiet on an unknown type. A badge stuck on
   a finished node has no later hook to clear it, so widening "to be safe" is the unsafe direction.
8. **"Supports" can be as dishonest as "doesn't support."** Codex claimed `manual` / "Ask each time"
   while emitting **no flag** — but its built-in default is `OnRequest` ("the model decides when to
   ask"), so two dropdown entries collapsed onto one behavior under a label that promised otherwise.
   Rule: a mode the CLI cannot express emits **no flag** (never a substituted nearest match), and a
   mode it *can* express must actually emit it. Derive the UI copy from the mapping
   (`unsupportedModesNote`, `permissionModeAgentIds`) so a sentence cannot drift from the table.
   **The nearest match is most dangerous on the DEFAULT mode:** gemini has no value for `auto`, and
   `auto` is `DEFAULT_PERMISSION_MODE`, so translating it to `auto_edit` ("auto-approve edit tools")
   would have widened permissions for every existing gemini node at upgrade, with `modeSupported`
   answering `true` so the derived copy stayed silent. Check what an UNTOUCHED setting emits before
   you accept any mapping.
9. **A capability gate that is fed by a version probe belongs to the agent it probes.** Claude's
   `auto` gate is fed by `claude --version`; applying it to any other agent downgrades that agent's
   sessions on a machine whose *claude* is old or absent. `activePermissionMode` gates only
   `'claude'`, and every hint string names Claude for the same reason. An agent needing its own gate
   adds one beside claude's.

**Not writing the same rule twice**

10. **A duplicated rule drifts, and this branch was bitten three times.** The remote installer's hook
    event lists (it subscribed gemini to *claude's* event names, so remote gemini reported nothing at
    all), grok's raw-listener field decoding, and the two shells' session-name sweep gates (reverting
    both to `canRename` left the entire suite **green** while silently skipping every gemini node).
    The fix each time was **one definition in `src/core`** consumed by both shells — a default inside
    core beats an argument each shell passes correctly today.
11. **Both shells' raw hook listeners must stay in parity** (`src/main/index.ts`,
    `src/server/agent-status.ts`). If you add a branch to one, add it to the other or write down why
    not (the desktop's extra skip for remote SSH nodes is a legitimate asymmetry: the server has no
    SSH-project manager).
12. **Widen the transcript-path jail per ROOT, never to `$HOME`.** Hook POSTs can arrive over the
    remote reverse tunnel, and `isSafeLocalTranscriptPath` exists so a forged one cannot aim a read at
    `~/.ssh/id_rsa`. Add the narrowest directory that holds the transcripts (`~/.gemini/tmp`,
    `<codexHome>/sessions`) and honor the agent's own relocation env var — getting that wrong fails
    **closed** (the meter silently never fills), which is the quieter and therefore worse failure.
13. **Re-validate a hand-editable value at the interpolation site, not by its type.** Modes come from
    git-shared JSON and end up on a tmux `send-keys` line. A table lookup guarded only by
    `mode in table` accepted a forged `constructor` and returned a **Function** headed for that
    command line; `isPermissionMode` at the top of `approvalFlags` is what closes it. Same rule as
    `SAFE_SESSION_ID`. An unrecognized value must yield the **bare, safe** command.

**Degrading, and admitting what you did not measure**

14. **A guess must degrade to nothing, never to something wrong.** A title reader that cannot resolve
    returns `null` (the node keeps its own name); an unknown notification type is a no-op; a failed
    probe means the bare command, never a blocked launch. Say in the code which facts are *composed*
    rather than captured (gemini's resumed-transcript shape is) and what the wrong-guess cost is.
15. **Kill the "in place" actions carefully.** An exit sequence must be the CLI's documented primary
    and **bare**: gemini's `/quit` also takes `--delete`, which exits *and permanently deletes the
    session history* — the very conversation the restart exists to resume. It has its own test.
    Refuse the restart while the node is `working` **or** `blocked`: an exit line typed into a
    permission prompt **answers** it.
16. **Write the device checklist for what you could not run.** Every unverified claim becomes a
    numbered item; group the ones that fall out of a single capture run. `docs/grok-agent.md` §9 and
    `docs/gemini-agent.md` §9 are the format.
17. **Extend the base harness mapping, never a frontend allowlist.** Model support is
    `MODEL_SWITCH_CAPABLE` plus the protocol/env/flag leaf in `shared/agents/model-gateway.ts`.
    Frontends call `canSwitchModel` / `modelsForAgent`; they never spell Claude, Codex or a custom
    id themselves. This makes `baseAgent:'claude'` inherit discovery, filtering, environment and
    command grammar as one unit instead of four copies that drift.
18. **A model switch must refresh the shell environment without printing the key.** An already-live
    shell does not inherit a later `tmux set-environment`, and prefixing the resume line with
    `KEY=secret` leaks it into the pane/history. SIGTERM the pane's foreground non-shell process
    group (a typed `/exit` can land in the agent composer as prompt text), recycle the persistent
    session, and let cold restore resume with the new model under the newly injected environment.


---

## Upstream v0.3.7 merge additions (9e76faf84a5f..upstream/main (v0.3.7))

> Appended verbatim during the v0.3.7 upstream merge (2026-09-20). Upstream keeps ONE CLAUDE.md;
> the fork keeps this subsystem's deep reference in this rule file, so its new material lands
> here rather than re-inlining the root. New/changed text only; `[~ replaced N base line(s)
> here]` marks where upstream reworded text this file already carries above — reconcile at leisure.

### From CLAUDE.md § Agent support

    [~ replaced 3 base line(s) here]
  `CONTEXT_LINK_CAPABLE`, `CHAT_CAPABLE`, `TRANSFER_SOURCE_CAPABLE`, `USAGE_CAPABLE`,
  `SESSION_ID_CAPABLE` and `SUBAGENT_CAPABLE`. Subagent cards come from grok's native
  `SubagentStart`/`SubagentStop` hooks, keyed by `subagentId` — measured on 1.0.13 by launching two
  `explore` children in parallel (same type, different ids; the start's `sessionId` is the PARENT's,
  the stop's is the CHILD's own and equals `subagentId`, so that is the only id both events share).
  The spawn tool call is not the card key. The other four came off the blocked list
    [~ replaced 3 base line(s) here]
    for that cwd*: a stranger's session as its meter and its search hits. Gated by the pure
    `readsClaudeTranscript` (`renderer/lib/transcriptGates.ts`) rather than by a fourth list.
    `context.ensure` LEFT that gate in 2026-09 (issue #813) once its handler stopped *being* claude's
    resolver — see **Context-meter rehydration** below; the find bar's index still has no routing and
    so has not moved. The lasting rule is the one the episode taught: **grep every consumer of a
    helper before adding an id to its list**, and when two consumers need different answers, route
    the one that can be routed instead of widening the gate for both.
- **Context-meter rehydration (`context:ensure`)** — the meter is fed by hook events, and a tmux
  session outlives the app, so a continuing session that is idle after a restart emits nothing and
  its meter stays blank until the user's next prompt. The mount-time read that exists to close that
  is `core/context-ensure.ts` (`registerContextEnsureIpc`), **in core so BOTH shells serve it** — it
  used to be inline in `src/main/index.ts` and the Server Edition had no handler at all, so a browser
  node's meter filled only on its next turn too (issue #813; the identical hole
  `core/transcript-ipc.ts` was moved to core to close). Three rules:
  - **It routes per agent; it does not widen a gate.** `agentId` picks that agent's OWN locator and
    tail — claude → `resolveTranscript`, codex → `locateCodex`, gemini → `locateGemini` (the last two
    keyed STRICTLY by session id, no cwd fallback, so neither can adopt a session that is not its
    own). A closed switch: an agent that is not in it gets **no meter**, never claude's resolver.
    That is what let the renderer gate move from `readsClaudeTranscript` to `showUsage` — the danger
    was never the meter, it was one resolver answering for four agents. **grok is deliberately
    absent**: its meter reads a `signals.json` whose directory is learned from a hook event, so after
    a restart there is nothing to rehydrate FROM (`locateGrok` resolves a different file, the
    conversation). Structural, not pending.
  - **A remote node is resolved on its HOST or not at all.** The desktop injects `ensureRemote`,
    which asks the host through `remoteTranscriptRefFor` — the ⌘M path's locator, jail
    (`isSafeRemoteTranscriptPath`) and cache, reused as a second consumer rather than copied. Its
    "could not resolve" is **terminal**: falling through to any local resolver would search THIS
    machine for a file that only ever existed on the other one, and claude's cwd fallback would
    happily meter an unrelated local session under the remote node's id. Remote metering is
    claude-only, the same boundary the hook raw-listener already draws (`remote-context-tail.ts`
    parses claude's records; the locator searches claude's roots).
  - **Nothing negative is ever cached.** A clean miss and a failed ssh call are indistinguishable to
    the locator, so both cache NOTHING and the next mount retries in full — a momentarily dead
    ControlMaster must not be remembered as "this session has no transcript", or the meter stays
    blank until the next turn anyway, which is the bug arriving by another route. The only
    de-duplication is of **concurrent in-flight** calls (a canvas mounts dozens of remote nodes at
    once and each resolve is an ssh exec on someone else's machine); it releases on settle, so it is
    not a cache. **No timer** — one read at mount, the same rule Remote usage and session memory
    follow.
  Surfaces: Desktop full; **Server Edition** full and local-only (it runs ON the host whose
  transcripts it reads — the legitimate asymmetry, stated the way the SSH skip is); kanban card +
  card modal render the same `ContextMeter` from the same store and inherit it; mobile N/A (its own
  context display, separate path). Tests: `core/context-ensure.test.ts` (routing, remote
  fall-through, no negative cache) + `main/context-ensure-wiring.test.ts` (the shell's closure, at
  source level, because it closes over `ptyManager`/`sshProjectManager`).
- **DROPPED — the CLI died and nobody told us** (`renderer/terminal/agent-liveness.ts`, issue #616).
  Every ORDERLY exit announces itself: Eco's `/exit` sets `hibernated`, "Pause session" sets
  `paused`, and a user typing `/exit` fires the CLI's own SessionEnd, which `setState(id, undefined)`
  records. A KILL announces nothing — the process is gone before it can run a hook, and tmux's shell
  still owns the pane so the PTY never closes. The node therefore kept rendering its last badge over
  a dead conversation, with the CLI's parting `Resume this session with: claude --resume <uuid>` and
  a stray `^[%` in the pane as the only evidence. Not exotic: measured on the reporting host
  (2026-09-04) 62 GB RAM with swap fully consumed, kernel `oom_kill` at 187, 147 live `claude`
  processes holding 44 GB. The signal is `#{pane_current_command}` reading as a shell while the
  status table still believes an agent is parked there, and the four refusals are the feature:
  a `null` pane read is NEVER evidence (a downed ControlMaster must not make a canvas of healthy
  remote nodes claim they died); `hibernated`/`paused` are our own exits and already have chips;
  **only `done`**, never `working` — a turn in flight is exactly when a tool subprocess can own the
  pane's foreground, so the alarm would fire on a healthy agent running a shell command; and the
  agent must be in **`SESSION_END_CAPABLE`**. That last list is the false-positive gate and is
  DERIVED from `normalize.ts`, not chosen: exactly four normalizers map `sessionPhase: 'end'`
  (claude, gemini, copilot, grok) and **codex and opencode map none**, so on those two a deliberate
  `/quit` and an OOM kill leave byte-identical evidence and the chip would be a coin flip shown as a
  fact. Adding an id without first adding its normalizer branch puts a chip on every session its
  owner quit on purpose — `agent-liveness.test.ts` asserts the list against that source. The verdict
  (`agentStatus.dropped`) is TRANSIENT, a stronger call than the other clocks: it is a claim about a
  pane, panes are re-measurable in milliseconds, and a persisted one would strand a stale chip on a
  node someone resumed by hand. ANY hook event withdraws it — the one self-heal that deliberately
  does not gate on `alive`, since `done` disproves "there is no CLI in this pane" even though it must
  not clear `hibernated`. Cost is bounded by asking only for a node that is BOTH watched and already
  believed to be a parked agent. Resume reuses the hibernation wake closure unchanged, which
  re-reads the pane and refuses anything that is not a shell. Chip on the node header, the kanban
  card and the card modal; Desktop and Server Edition identical; relay tabs answer `null` and are
  never judged. **A second thing this catches, unplanned:** in the same sweep 9 of 149 panes sat at a
  bare shell because a cold-restore `--resume` had answered *"No conversation found with session
  ID"* — the persisted `sessionId` outlived its transcript. The chip surfaces those too, but the
  Resume it offers still replays that dead id — but cold restore no longer creates the state: it
  probes `transcript:exists` first and launches bare on a positive `absent`, saying so on the node
  (see **Cold restore** above). Re-measured on the same host 2026-09-09: **20** of 108.
- **A reused ControlMaster is not evidence of a live hook tunnel** (issue #735 — remote sessions
  stuck on **Unknown**, no completion notifications, no unread dots). `connect()`'s reuse branch
  returned the cached `hookEndpointPath` whenever `ssh -O check` answered, on the written-down
  assumption that *"a master that answered `-O check` never lost its tunnel"*. That is false, and
  the mechanism is **our own self-heal**: `childArgs` uses `ControlMaster=auto` + `ControlPersist`
  precisely so a dead master is rebuilt by the next child command (a status poll, a mirror push, a
  remote git call) on the same ControlPath. The rebuilt master answers `-O check` — and carries no
  `-R`, because `RemoteHooks.setup()` is the only caller of `hookForwardArgs` and it runs only on
  the branch where a master has just come up. The 45 s watchdog then parks on the reuse branch
  forever. Nothing reports it: the project says `connected`, terminals work, the mirror pushes, and
  only the hook POSTs die — into a socket file that still EXISTS with nobody listening.
  **MEASURED on the host that prompted the fix**: 10 per-project hook sockets on disk, exactly ONE
  with a listener (`ss -lxp`); the dead project's socket answered `curl` exit 7 while that same
  project's status mirror was being written the same second; **107 of 128** live `nodeterm-rmt`
  tmux sessions were pinned to that dead endpoint. Sessions are pinned for life
  (`new-session -A -e …` — tmux ignores `-e` on an existing session), so every one of them stayed
  dark until the app restarted. The reuse branch now probes the tunnel (`RemoteHooks.tunnelAlive`,
  one `curl` over the already-multiplexed master) and re-runs the idempotent `setup()` when it does
  not answer, firing `onTunnelVerified` so the working agents resync. **The retry is backed off**
  (`tunnel-repair.ts`, pure + tested): the FIRST failure repairs immediately — that is the common
  case — while a host that can never forward (`AllowStreamLocalForwarding no`, no `curl`, a `$HOME`
  the validator refuses) settles at one attempt per 15 minutes instead of rewriting every agent's
  hook config every 45 s. A missing spec answers "not alive" rather than "unknown": nothing of ours
  is bound, which is a tunnel that cannot deliver.
- **The per-agent hook installs run CONCURRENTLY, and the order that still matters is the one above
  them.** `RemoteHooks.setup()` is the chain `connectOnce` awaits before a project reports
  `connected`, so every terminal of a switched-to project waits through it. Its shape was: resolve
  `$HOME`, open + VERIFY the reverse tunnel, write the endpoint file — and then install five agents'
  hooks strictly one after another, ~16 more remote round trips in a row. MEASURED against a real
  sshd through a 25 ms one-way delay proxy (50 ms RTT), 5 runs each: **3281 ms serial → 1471 ms
  concurrent** over the same 22–24 ssh children. The installers are independent by construction —
  each writes its own script under `<remoteDir>/agent-hooks/` and merges its own agent's config; no
  two touch the same remote path, and the only shared statement is an idempotent `mkdir -p` — and
  the `SshChildGate` (cap 6 per ControlMaster) is what makes the fan-out safe against a stock host's
  `MaxSessions`, which is the whole reason it exists.
  - **The tunnel and the endpoint file stay strictly BEFORE the fan-out**: that file is what every
    hook this installs POSTs through, and it is written only once the tunnel has verified end to
    end. `remote-hooks.test.ts` pins that ordering AND the overlap (a gated fake runner, so
    concurrency is observed rather than inferred from wall-clock; the overlap test fails on the
    serial version, checked by mutation).
  - **`allSettled`, not `all`.** By the fan-out the tunnel is verified and the endpoint written, so
    one installer failing must cost that agent its hooks and nothing else — not discard a working
    setup for every other agent, which is what a rejection propagating to `setup`'s outer catch
    would do (`return null` ⇒ no hooks at all, and post-#735 a repair retried on backoff forever).
    Every installer catches its own errors today; this is the guard for the next one that forgets.
  - The claude/gemini loop body became `installJsonAgentRemote`, with the same fail-open try/catch
    its three siblings already had. Its three steps stay strictly ordered inside: the merge reads
    the file the write then replaces.
  - **Every LOCAL generated sh client recovers shared-Codex identity before its env gate.** A tool
    shell forked by the account-scoped app-server carries `CODEX_THREAD_ID`, not the pane's
    `NODETERM_*`. Managed hooks, local `nodeterm.sh`, and local `context.sh` therefore prepend
    `codexThreadIdentityResolverSh(codexThreadIdentityRoot())` before testing
    `NODETERM_NODE_ID`/`NODETERM_CANVAS_CONTROL`. Before this was shared, status hooks recovered the
    node while both user-facing shims declared that same first-class Codex session outside
    nodeterm. The SSH constants remain machine-neutral: the local record root is not valid on a
    remote host and must never be baked into its copy — enforced by
    `main/remote-ssh/remote-shim-neutrality.guard.test.ts`, two legs (the exported neutral bodies
    carry no record root or prelude, and `remote-hooks.ts` cannot even NAME a parameterised
    builder), because the failure is silent and one-sided: a remote shim carrying the prelude keeps
    working, and the only symptom is this machine's userData layout sitting in a file on someone
    else's server. **The prelude is shared; the RECORD it reads is desktop-only.** Those writers are
    the two hook-server handlers `src/main/index.ts` registers — and, since the daemon-reset work,
    the ones `wireServerCodexSharedIdentity` (`src/server/codex-shared-identity.ts`) registers at
    Server Edition boot as well. That shell used to answer a flat `shared: false`
    (`UNKNOWN_CODEX_IDENTITY_CAPS`) as a DELIBERATE degrade: its Codex nodes ran their own
    app-server, so no tool shell needed recovering. It no longer does. The Server Edition has the
    same local app-server, the same signed node tokens and the same persistent canvas store, so it
    wires the shared-thread spine **after** those secrets exist and its panes get the same
    supervisor. The registration is deliberately late for that reason, and `registerCodexIdentityIpc()`
    now answers from the live resolver instead of a constant — an early browser caller waits for the
    refresh rather than being pinned to a false "plain Codex" answer for the whole app run. What
    remains desktop-only is the record's REMOTE leg (SSH shims carry no record root or prelude, the
    paragraph above).
  - **That prelude EXPORTS WHAT THE RECORD SAYS — it never decides.** `NODETERM_AGENT_ID` and
    `NODETERM_CANVAS_CONTROL` were once constants there (`codex`, granted); both are
    `buildPtyEnv`'s answers about the PANE, which labels a node with its OWN agent id
    (`custom:<uuid>` for a custom agent whose `baseAgent` is codex, not `codex`) and gates the grant
    on `canControlCanvas`. The constants therefore mislabelled every custom codex-based node and
    asserted a grant that agrees with the pane only because
    `SHARED_IDENTITY_CAPABLE ⊆ CANVAS_CONTROL_CAPABLE` — a coincidence that list's own comment
    invites the next shared-identity agent to break, and breaking it hands a tool shell a capability
    its pane was denied. So the record carries `agentId` + `canvasControl` INSIDE the 6-tuple HMAC,
    and the prelude reads them; the grant is exported only when the record grants it and is left
    UNSET otherwise (absent, never `0` — the shape both shims' `[ -z … ]` gates expect). The **pane
    echoes its own label** on `/codex-thread/{start,bind}` (a tmux session outlives the app, so
    after a restart nothing server-side still knows what agent a node runs), but the **grant is
    never echoed**: the route derives it with `canControlCanvas`, so there is ONE decider and a
    forged id cannot manufacture a grant the table refuses. The three preimage generations are
    **selected by the record's shape, never tried in turn** — a record naming an agent must not
    verify under a preimage that ignores one — and a pre-agent record's implied `codex` + grant is
    keyed on the LINE being absent, never on the value being empty, so nothing that names an agent
    falls back to the guess. The env vars were never a security boundary in any case (anyone who can
    run the shim can `export` them by hand); the per-node token is, and
    `docs/shared-codex-node-identity.md` states that argument in full.
  - **A shell that forwards this identity cannot be type-checked into correctness.** A handler that
    destructures the request without `agent`, and a record write that omits its optional trailing
    argument, are BOTH well-typed — so the whole dimension can be plumbed through core, the route,
    the launcher and the prelude, pass `npm run typecheck` and every unit test, and ship INERT.
    `main/codex-identity-record-wiring.test.ts` pins it at source level, the same remedy
    `hook-verified-parity.test.ts` uses for the same class of hole.
  **A third removal path is opt-in:** `settings.autoHideFinishedSubagentCards` (default OFF, and
  off reproduces the two paths above exactly) mirrors into the store as `autoHideFinished`, and
  with it on a card is dropped the moment its subagent REPORTS done, with no turn boundary. Only a
  DONE card is ever dropped, so #547's rule (a new turn keeps the cards of subagents still running)
  and Eco's `liveSubagents` are untouched. **The decay is deliberately NOT one of the paths it
  gates**: `sweepStaleWorking` fires precisely because the end never ARRIVED, which is the opposite
  of what the setting promises, and it is the one case where a visible card carries the most
  information — drop it and a fan-out whose subagents died silently leaves nothing on the canvas
  saying one was ever launched. It costs Eco nothing either way, since an absent card and a `done`
  card are the same answer to `liveSubagents`. Renderer only: Desktop and Server Edition identical,
  Mobile N/A.
  **Grok** (2026-09) joined via its own native `SubagentStart`/`SubagentStop`, measured on
  grok 1.0.13 by launching two `explore` children in parallel. Keyed by `subagentId` occupying
  the same `toolUseId` slot the store already uses (claude correlates by `tool_use_id`,
  codex by `agent_id`; grok has no tool call behind a subagent). Facts a refactor must not
  lose: **(1)** the start's `sessionId` is the PARENT's and the stop's is the CHILD's own
  (equal to `subagentId`) — keying on it files start and stop under different cards and the
  started one never closes. **(2)** the child's transcript is DERIVED from `subagentId` as
  `chat_history.jsonl` (`core/grok-subagent-format.ts`); the start's `transcriptPath` is the
  PARENT's, and even the stop names `updates.jsonl`, which parses to nothing. **(3)** a
  `session_end` bearing `subagentType` returns early in both raw listeners — without that a
  child finishing tears down the PARENT's session state. **(4)** `description` arrives only
  on the start. The four captured payloads live in
  `src/shared/agents/__fixtures__/grok/hook-payloads.json`, pinned by
  `normalize.grok.capture.test.ts`. Remote (SSH) grok nodes get cards from the hook but no
  live tail yet (the child dir is on the host; same gap as codex).
  **Server creator ownership (2026-08 incident hardening):** enabled Server control accepts only
  verified node identity. `HeadlessNodeFactory` records which source node opened each new node in a
  process-local ledger; link/group/rename/color/sticky-update, message delivery, and close validate
  the whole target set as current-run creations before writing or killing anything. Queued messages
  revalidate creator ownership before flush. The ledger is intentionally empty after restart —
  project JSON, titles, hook history and tmux names are not creator proof — so
  boot neither attaches/creates backends nor sends persisted queued commands. A live backend with a
  durable arm remains untouched until an explicit owner action or browser view. `open-terminal` and
  `open-agent` are verified-only at the Server handler boundary. A plain terminal keeps generic
  node hook wiring but receives neither `NODETERM_AGENT_ID` nor `NODETERM_CANVAS_CONTROL`; missing
  identity never defaults to Claude.
  **NO VERB MAY ACTIVATE A PROJECT TAB** (`src/shared/control-off-screen.ts`). Routing is by
  SOURCE — the request names the agent's own node, and the dispatch must find the canvas that owns
  it — so for years "that canvas is not on screen" was answered by `travelToProject`. The user was
  typing in project B; a background agent in project A issued a `close`; the tab switched and A's
  saved viewport was applied. Their focus, camera and typing context were taken by a call they did
  not make. Two carve-outs (the cold open for `open-*`, then the display verbs) were each written
  as if it were the last, because nothing walked the whole table — twenty-one verbs still
  travelled. Every verb now has a decided disposition and NONE of them is travel:
  `STORE_ANSWERED_VERBS` (no canvas at either end), `COLD_OPENABLE_VERBS` (a session node, armed
  and inert until shown), `OFF_CANVAS_VERBS` (a display node, complete when written),
  `STORED_NODE_VERBS` (`write`/`close`/`rename`/`color`/`link`/`board`/`assign` — each reaches a
  pane, a store writer or the board file), and `OFF_SCREEN_REFUSALS` (the eleven that genuinely
  need live React Flow, each with its own reason in the refusal the agent reads). A refusal an
  agent can act on is strictly better than hijacking someone's screen. Load-bearing details:
  (1) **`ctlNodes()` is the one name for "the node array this call acts on"** — on screen it is
  `nodesRef.current` verbatim, off canvas it is the owning project's serialized nodes hydrated by
  `nodeStatesToFlow`. A verb body that resolves `--node` against the live array while answering
  for another project does not throw and does not travel; it silently renames, closes or reports
  on whatever the human happens to be looking at. `control-stored-node.source.test.ts` pins that
  no stored-node case mentions `nodesRef.current`. (2) **`board`/`assign` read `ctlProject`, not
  `activeProjectId`** — a second bug that was hiding behind the first, invisible while the travel
  made the two projects the same. (3) **`closeStoredNodes` is the ONE cross-project teardown**,
  shared with the sessions sidebar's `closeSession`; it is `deleteNodes` minus the closed-session
  ledger and ⇧⌘T history, which `deleteNodes` files against the ACTIVE project. `close` still ends
  the session off canvas because `transport.destroy` resolves a REMOTE node's host from the
  persisted index with no live client (`core/remote-end.ts`). (4) **There is no
  `travelToProjectRef` and there must not be one again**; `travelToProject` survives only for the
  facepile, the user's own navigation. (5) **The regression guard is
  `test/acceptance/control-verb-disposition.test.ts`**, cross-layer on purpose: it walks MAIN's
  `VERBS_FOR_TEST` against the RENDERER's disposition, which is the only way "every verb" is a
  checked claim rather than a list kept by hand. That is what nobody had, and why two carve-outs
  could ship without anyone noticing the other twenty verbs.
    [~ replaced 2 base line(s) here]
  (`messagingGuidanceLines`) so a new outcome kind lands in the text the day it is added, and the
  off-screen paragraph renders from the verb table itself (`offScreenGuidanceLines`, which is why
  that table lives in `src/shared` — core cannot import the renderer) — prefer that shape over
  prose you have to remember to edit. `canvas-control-core.test.ts` walks both
  **WHICH CANVAS ANSWERS, and why an open never moves the camera** (`renderer/lib/controlRouting.ts`
  + `renderer/lib/coldOpen.ts`). React Flow holds only the ACTIVE project's nodes, but every other
  open project's tmux sessions keep running, so a control call routinely arrives from a node the
  live canvas has never heard of. `routeControlSource` resolves the OWNING project
  (`active | switch | reopen | blocked | unknown`) — before that, every agent outside the project
  the app happened to come up on was rejected as *"source node is not a control-capable agent"*,
  which is a capability sentence for a routing failure. **That fix must not regress.** What it
  originally did with the answer was TRAVEL there (`travelToProjectRef`), and that was a screen
  hijack: the user looks at project B, an agent in project A runs `open-claude`, the tab switches
  and A's saved viewport is applied, so the camera appears to jump and zoom on a background agent's
  say-so. THREE membership lists now decide, and their differences are the whole design:
  - `STORE_ANSWERED_VERBS` (`needsLiveCanvas` false) = **no canvas is needed at either end** —
    `list` reads names, `send`/`reply` deliver into a tmux PANE, `sticky` rewrites a note,
    `open-project` acts on the projects store.
  - `COLD_OPENABLE_VERBS` (`canColdOpen` — `open-terminal`/`open-claude`/`open-agent`) = **a canvas
    IS needed, but the serialized one will do.** `needsLiveCanvas` stays TRUE for them; they take
    the `--project` cold-open path (issue #338 §2.2) applied to their own project: the composed
    launch MOVES into `pendingLaunch` (`armForColdOpen` — `initialCommand` is never serialized), the
    node is upserted through `applyNodeMutation`, edges go through `appendCanvasLinks` (the edge
    counterpart, so the opener's rope and the fan-in bridge are not lost), `writeDisk` persists, and
    the reply is the ONE shared `coldOpenMessage` sentence with `queued: true`.
  - `OFF_CANVAS_VERBS` (`answersOffCanvas` — `show-image`/`show-video`/`show-web`/`open-browser`)
    = **a canvas is needed, the serialized one will do, and there is nothing to defer.** The node
    these make has no session behind it: a page, a video, an image, a browser node is inert
    wherever it sits, so writing it into the owning project's serialized nodes IS the whole effect
    and it is complete when `writeDisk` returns. That is why it is a third set and not four more
    entries in the second one — a cold open reports `queued: true`, and a caller told its
    screenshot is queued waits for something that already happened. It gets
    `offCanvasReplyClause` and `offCanvas: true` instead. **This was the half the cold-open fix
    left open, and it is the half an agent meets most often**: a skill that renders its report as
    HTML reaches for `show-web` every time it finishes, and every one of those calls used to yank
    the user out of the project they were typing in. The verb bodies are untouched; three things
    they read from the canvas are staged — the colour index (`nodeCount`), the placement source
    (the stored node, hydrated through `nodeStatesToFlow` so its shape cannot drift from a live
    one's) and the append, where `applyNodeMutation` + `appendCanvasLinks` + `writeDisk` replace
    `setNodes` + `connect` + `markDirty`. The opener's edge is a **rope** and only a rope: a
    display node has nothing to read, so a bridge there would grant a context link the live path
    never draws. **`ctlProject` resolves from the SOURCE's project**, not the active one — off
    canvas it decides the ssh flag, the browser session key and the media allowlist route; on
    every other path the travel has already made the two the same project. None of the four takes
    `--group`, which is why this set owes no worktree question; a verb joining it that does would,
    because `cwdForNewNodeIn` subtracts `staleGroupIds`, which is epoch-scoped to the ACTIVE
    project.
  Everything else keeps travelling **on purpose**: `write`/`close`/`group`/`move`/`arrange`/
  `align`/`verify`/`spawn-team`/`open-worktree` read live canvas state the serialized copy does not
  carry (measured node sizes, worktree staleness, the React Flow edge arrays). **`browser` is the
  pair worth stating beside `open-browser`**: it NAVIGATES a mounted `<webview>` guest, which
  exists only while its project is on screen, so it travels; `open-browser` merely places the node
  and its guest is created when that project is next shown, exactly as a cold-opened terminal's PTY
  is. Route `active` is byte-identical to before.
  **The human is told, once, in the other voice.** The reply goes to the agent; without a strip the
  person sees nothing at all, and the whole point of not travelling is that the choice to go and
  look stays theirs — a choice they can only make if they are told there is something to look at.
  `offCanvasNoticeText` names the project and the button is `travelToNode` (which reopens a closed
  project first and resolves off the SERIALIZED nodes the write has already made). It is **sticky**:
  every other info strip reports something the user just did and is watching, this one reports work
  that landed while they were busy elsewhere, and once it fades nothing anywhere says it happened. Route **`reopen` (a CLOSED project) cold-writes
  too and does NOT reopen the tab** — closing is the user's explicit "park this, keep it running", so
  restoring the tab *and* activating it is the loudest form of the hijack; the reply names the closure
  so a caller does not report a session as started. On the cold path `--group`/`--after` ARE resolved
  (unlike with `--project`, where the ids would live in another project) against the serialized
  nodes, defaults come from the OWNING project (`projectPermissionMode(owner, …)`, its account,
  its `ssh`), and `--after`'s dep ropes are left to `missingDepRopes` at that project's next load.
  **The destructive confirm, and who may waive it** (`@shared/control-confirm`, 2026-09). The
  dialog `write` / `close` / `open-project` raise is the ONLY place a human stands between a
  canvas-control agent and the workspace — per-node identity is not enforced until
  `NODE_IDENTITY_STRICT_AFTER`, so a `legacy` caller still reaches the dispatch — and it used to
  ask EVERY time with no way to say "yes, all of them". Closing 14 finished stations was 14
  dialogs, and the 15th request was refused with `a confirmation is already pending`. Three things
  changed, and the last one was the actual bug:
  - **`close --node a,b,c` is ONE dialog** (`lib/closeTargets.ts`, pure). The grammar is not new —
    the Server Edition's headless `close` has read a comma list since it shipped, including its
    "validate the whole list before killing anything" rule; the DESKTOP dispatch read the flag as
    one id, so a comma list called `deleteNodes(['a,b,c'])` (a no-op) and answered `closed a,b,c`.
    A destructive verb reporting success for work it did not do is worse than either doing or
    refusing it. The single-id form is bit-identical, **deliberately including its lack of an
    existence check**; the bulk form refuses the WHOLE list on an unknown id and names it, because
    with 14 ids the user cannot audit the list themselves. Capped at `CLOSE_BULK_MAX` (50) and the
    dialog spells out at most 12 names then counts the rest — a name the user cannot see is not
    consent.
  - **"Don't ask again" is bounded by SCOPE, not by permanence** (2026-09, revised). The checkbox
    offers two reaches and defaults to the narrower: **"while nodeterm is running"** — the
    transient `state/controlConfirm.ts`, memory only (not `settings.json`, not `localStorage`), per
    VERB, so quitting restores the gate — or **"always in <project name>"**, persisted in
    `settings.controlConfirmWaivers.projects` as `{ [projectId]: verbs }`. The machine-WIDE
    `always` is still reachable only from Settings → Agents, where the option says "permanently":
    a dialog that appeared under the user's hands must not switch a destructive gate off
    *everywhere* on one stray click. The per-project scope is what makes the offer honest — an
    app-run waiver is not what a user who ticks "don't ask again" means, and with only that and a
    machine-wide switch the real choices were "be asked forever" or "turn it off everywhere".
    Load-bearing details: (1) the waiver is keyed on the project the call **acts on**
    (`ctlProject`), not the active one — canvas control answers a background agent in its own
    project without moving the user's tab (@shared/control-off-screen), so reading the project on
    screen would grant, or honour, a waiver in the wrong repo; the same argument applies to the
    permission MODE the bypass lock weighs, which is why `controlConfirmDecision` takes a project
    id and resolves both from it. (2) It is **machine-local** — never `.nodeterm/project.json`,
    which is git-shared; the whole trap `bypassMode` needs two locks for. (3) It is **pruned** on
    every write (`pruneControlConfirmWaivers`, the rule `pruneCollapsedItems` states for
    `sidebarCollapsedItems`) against EVERY project including CLOSED ones — a closed project is
    parked, not gone — because settings.json is forever and a stale entry is a live security
    waiver keyed to an id nothing can name. The id being granted survives that prune because the
    merge happens after it, not by an exemption inside it; a safeguard no test can turn red is a
    comment, not a mechanism. (4) Precedence is narrowest-first among the persisted grants
    (session → project → always → bypass), so the notice names the waiver the user most likely
    wants back. (5) A waiver granted by a CANCEL must not exist at all (the grant hangs off
    `onConfirm`, pinned by `control-destructive.test.ts` and
    `control-confirm-scope.source.test.ts`), and a per-project grant that cannot be made (no
    project owns the call) falls back to the app-run waiver rather than silently to nothing.
    Waiving is not silence: every waived application raises the info strip through `waivedNotice`,
    which names the waiver that let it through — and, for the project scope, the PROJECT, since
    "this project" would point at whatever the user happens to be looking at — and every
    per-project waiver is listed with a Revoke in Settings → Agents.
  - **`bypassPermissions` needs TWO locks, and this is the trap to understand before touching it.**
    The permission mode is persisted to `.nodeterm/project.json`, which is **git-shared** — so
    keying the waiver on the mode alone would let a repository the user CLONED silently disable
    their destructive-action gate. It therefore requires a machine-local opt-in
    (`controlConfirmWaivers.bypassMode`, default off) **and** a mode that came from the user's own
    GLOBAL setting: `resolvePermissionModeWithSource` answers `project | global | default`, and
    only `global` can waive. `default` is its own answer rather than folded into `global` because
    nobody chose it, and reading an unset setting as a deliberate choice is reading consent into
    silence. The claude version gate is deliberately NOT applied here (it exists to degrade `auto`
    for an old CLI; a security decision must not hang on a `claude --version` probe).
  - **`open-project` can never be waived**, by table (`CONFIRM_WAIVABLE_VERBS`) rather than by a
    line somebody forgot at one of three call sites. It widens the app's blast radius (a new
    directory registered as a project, plus a grant the caller feeds to `--project`) instead of
    acting inside it, and it cannot produce the dialog storm the waiver exists to end —
    `recordAttachConsent` already dedupes it per (caller, project).
  **An agent-requested dialog knows its own request's lifetime** (`ConfirmState.expiresAt` /
  `onExpire`, `CONTROL_REQUEST_TIMEOUT_MS` now shared with main). Main abandons a control request
  after 120 s and tells the renderer NOTHING, so the dialog stayed on screen asking about work
  nobody was waiting for — and, worse, kept `confirmBusy()` true, which refused every later
  `write`/`close` with `a confirmation is already pending — try again` for the rest of the app run.
  **That is the "the same dialog keeps coming back" report**, and it is a single-canvas loop: the
  reply says retryable, the agent retries, every retry is refused by the orphan, and the moment the
  user finally answers it a queued retry raises a fresh dialog for the same node. The deadline is
  measured from the RENDERER's receipt, so it always fires a hair AFTER main gave up, never before
  (the other direction would abandon a dialog whose answer main would still accept); it replies
  `expired` rather than `denied by user` (nobody denied anything, and a reply main has already
  timed out is simply dropped); and the notice is a fading info strip, because raising an alert
  would keep `confirmBusy()` true — i.e. reproduce the bug with better wording.
  **`close-worktree --mode remove`'s dialog expires too** (2026-09-11), through the SAME
  `renderer/lib/useExpiringDialog.ts` the confirm uses — the rule was extracted rather than copied,
  because a second effect beside the first is how one gains a fix the other silently lacks. Three
  differences to keep in mind, all deliberate: it carries **no `onExpire`** (the verb replies
  "removal confirmation shown to the user — they decide" the instant the dialog opens, so nobody is
  waiting on an answer and an `onExpire` would be a reply to a call that finished minutes ago); its
  clear must also release **`removePendingRef`**, the guard covering the async `git.status` gap
  before `removeTarget` exists, which `confirmBusy()` reads directly — dropping the state while
  leaving that ref latched closes the dialog and keeps refusing every later destructive verb, i.e.
  the bug minus the only thing on screen that explained it; and the deadline is set **only when
  `requestedBy` is present**, because a removal the USER opened from the group menu must never
  vanish under them. It reuses `confirmExpiresAt` rather than inventing a second timeout: the fact
  is the same class ("an agent asked and the human is not at the machine"), and this is the most
  dangerous dialog to leave lying around — the one carrying a pre-ticked delete-from-disk choice on
  a worktree the human never asked about.
  **MEASURED, and the answer is no: two canvases cannot raise two dialogs for one request.** The
  suspicion was worth checking because the same project can be open on a desktop and in a Server
  Edition browser at once. Desktop main forwards each request to `getMainWindow()` — one
  BrowserWindow, so at most one dialog exists per request; the Server Edition raises none at all
  (its control is HEADLESS — `HeadlessNodeFactory.close` is gated by verified identity plus
  process-local creator ownership, and the browser bridge's `onAgentControl` is `noopUnsub`); and
  the shim's endpoint failover cannot duplicate a request either, because the control POST carries
  **no `--max-time`**, so a POST waiting on a human eventually gets an HTTP answer and
  `nt_reached()` is true — failover fires only on a dead transport (`000`/empty). If a future change
  gives that curl a timeout, this paragraph stops being true: a confirm-gated verb would then fail
  over mid-wait and a second instance WOULD open a second dialog for the same logical request.
    [~ replaced 3 base line(s) here]
  Pure logic + refusal matrix in `renderer/lib/pendingLaunch.ts` (unit-tested);
  the dep→node edge is a **rope** (`ctrl-<dep>-<node>`, persisted in `project.ropes` like the
  opener's) whose LOOK is derived: dashed + ⏳ while the node's `pendingLaunch.after` still lists the
  dep, solid once it has launched (`lib/edgeModel.ts` `ropeVisual`, over the ONE `ropeInfoOf` lookup
  the render and BOTH delete paths ask — two builders would be two answers, and the label the user
  reads would stop describing what the delete does). The fan-in bridge `--after` also writes hides
  under that rope (`hiddenLinkIds`), so ONE edge per pair holds on the canvas. Deleting a WAITING
  rope drops that dep from `after` (`dropAfterDep`) and takes **nothing else** — the covered bridge
  survives, because "stop waiting for it" is not "stop being able to read its work"; an emptied
  list fires. Only the `open-*`/`verify` verbs write the rope, so `missingDepRopes` heals an armed
  node that has none at **project load**: `pendingLaunch` is persisted and the rope is not, so a node
  armed by any other path — or by a build older than this one — would otherwise hold a launch with
  no arrow saying what for. All edges route through the single `floating` edge type
  (`canvas/FloatingEdge.tsx`, a bezier between the MIDPOINTS of the two nodes' facing sides — one
  anchor per side, so a hub's arrows converge instead of fanning along its border; context and note
  links are restricted to the left/right sides, where the bridge handles sit; an unmeasured node
  draws nothing rather than a path to the origin) — no family sets a handle side;
  and a node whose eye is closed (`hideFanout`) hides every edge touching it as well as its cards
  (2026-09-02 edge model, spec in docs/superpowers/specs).
  **Settings (`settings`, 2026-09):** `settings [--project <id>]` lists, `settings --get <key>`
  reads, `settings --set <key> --value <v> [--project <id>]` asks to change — flags only, because the
  shim drops a positional sub-action for an unlisted verb and an SSH host keeps the shim it got at
  connect. The pure `@shared/settings-verb` is the whole rule set, shared by the desktop dispatch, the
  Server Edition and main's `parseControlRequest`: an **allowlist** (`agentMessaging` per project;
  `snapToGrid`/`gridSize`/`defaultNodeWidth`/`defaultNodeHeight` machine-wide, bounds = the UI's) with
  a required `why` per entry, and a **forbidden set + name pattern that outranks it** (permission
  modes incl. `bypassPermissions`, `hookIdentityStrict`, `agentBrowserControl`, accounts/credentials/
  gateway/launch commands, telemetry, keybindings, confirm waivers, `capabilityAck`) — the test walks
  the table against both. Four load-bearing rules: (1) **every `--set` confirms**, and `settings` is
  in `DESTRUCTIVE_VERBS` (one dialog at a time) but NOT in `CONFIRM_WAIVABLE_VERBS` — no waiver of any
  scope, bypass included, answers for the user (`control-destructive.test.ts` pins no `waiveVerb`/no
  `controlConfirmDecision` in its block, and the write only on the confirm leg). (2) A capability read
  is the **grant** (`projectCapabilityGrantedFor`), never the file bit, and a capability write goes
  through `applySettingsChange` → the UI's own `setProjectCapability` (flag + `'kept'`), pinned by
  `settingsVerb.test.ts` comparing the two resulting projects. (3) Verified-only (`requiresVerified`)
  and `--project` is own-or-granted via `PROJECT_TARGETABLE_VERBS`/`gateProjectTarget`. (4) **Server
  Edition refuses every `--set` by name** — its headless opt-in (#537) is not consent to grant
  capabilities, and there is no dialog; `--get` answers from `capabilityProjectFor`, own project only.
  Mobile: N/A (the phone issues no control verbs).
  **Agent messaging's MACHINE DEFAULT (`settings.agentMessagingDefault`, 2026-09, ships OFF).** A
  project whose `.nodeterm/project.json` carries NO `agentMessaging` value is answered by this
  machine's settings.json; the rule is ONE function, `projectCapabilityEffective`
  (`@shared/project-capability-consent`), and `projectCapabilityGrantedFor` now REQUIRES the
  defaults argument so a consumer that forgot it fails to compile instead of reading every
  unconfigured project as off while Settings reads it as on. Four rules: (1) an explicit `true` still
  needs this machine's `'kept'` — `needsCapabilityNotice` is untouched and stays keyed on an explicit
  `true`, so a cloned file still notices and a project on only by default never does; (2) OFF is now
  WRITTEN — `setProjectCapability(…, false)` stores a literal `false` for a capability in
  `CAPABILITY_MACHINE_DEFAULTS` (browser control has none and still deletes the field), because
  absence now means "use the default"; `readProjectCapabilities` carries that `false` through the
  file; (3) an ABSENT field with a recorded `'declined'` stays off — that is how every pre-default
  build wrote "off", and a user's explicit no must not be undone by a default switched on later;
  "Use this machine's default" (`resetProjectCapabilityToDefault`) therefore clears the field AND the
  answer; (4) the default is forbidden to the `settings` verb (a grant over every project, clones
  included). **This does not trip the `project-capabilities.ts` header's trigger**: the notice is not
  dropped, and what the default answers is absence, whose value lives in machine-local settings.json.
  **Why it ships OFF:** `core/agents/pane-ownership.ts` records a pane's owner only on a FRESH spawn,
  so after an app restart or update every surviving pane is `unproven-target-owner` and refused —
  "on by default" would be false after every restart. The flip is a separate one-line change that
  waits for a cross-restart ownership proof (#659's signed record is the candidate). Settings →
  Agents shows the machine switch, and the per-project row is a three-way choice (default / on /
  off) plus "On in <project> (this machine's default)" — a two-position switch cannot draw absence.
  Downgrade: a pre-default build writes `false` back as a deleted field, which this build then reads
  as "use the default". Server Edition reads the same grant from its own settings.json; Mobile: N/A
  (the phone has no capability switch).
    [~ replaced 2 base line(s) here]
  Edition IS wired (`src/server/context-link.ts` calls `initContextLink(ptyManager, {})`) but
  passes no remote deps → **local-only**, which is the complete answer there: that shell runs ON the
  host whose transcripts and tmux it reads, and SSH projects are a desktop-only concept. Discovery is per-agent: claude installs a
    [~ replaced 2 base line(s) here]
    `core/claude-accounts-service.ts` owns the five `claude-accounts:*` channels (add / wait-login
    / cancel-wait / remove / link) behind `platform().handle`; `main/claude-accounts.ts` is a thin desktop
    [~ replaced 3 base line(s) here]
    deps carry everything core cannot reach: `installSkill` (desktop passes `installCanvasSkillInto`;
    an enabled Server canvas-control runtime installs its Server-specific skill separately) and
    `remote`, a **thunk** resolving the SSH legs
  - **Shared system skills (`shareSystemSkills`, issue #643, OFF by default)** — Claude Code resolves
    user skills as `join(CLAUDE_CONFIG_DIR ?? ~/.claude, 'skills')` (MEASURED, 2.1.266), so an
    account dir **replaces** `~/.claude/skills` rather than adding to it and a fresh managed account
    shows only the skills nodeterm installed (that was #438). The isolation is correct and often the
    point; this per-account switch (Settings → Accounts) is the way back in.
    **Each system skill is linked INDIVIDUALLY** (`<accountDir>/skills/<name>` →
    `~/.claude/skills/<name>`), never the whole `skills` directory, and that choice is what makes
    everything else safe: `installCanvasSkillInto` writes *into* `<configDir>/skills/`, so a
    directory-level link would put nodeterm's canvas skill in the user's SYSTEM skills folder, and
    "turn it off" would have to restore a directory it had first moved aside. Per-skill links keep
    the account's `skills/` a real directory and make the off-switch a link removal.
    MEASURED with strace: Claude Code opens a symlinked entry inside `skills/` as a directory and
    reads its `SKILL.md` exactly like a real sibling — per-skill links are equivalent to the
    whole-directory link for discovery, not a compromise.
    - **Ownership is name-anchored**: an entry is ours iff it is a symlink whose target normalizes
      to exactly `join(systemSkillsDir, <that entry's own name>)`. What ON creates is precisely what
      OFF removes; a real directory is never ours, whatever its name — so "never delete through the
      link" is a property of the plan (`core/claude-skill-share-core.ts`, pure + mutation-tested),
      not a promise about the applier. Removal is `unlink` then `rmdir` (a Windows junction refuses
      `unlink`); both fail on a real non-empty directory, which is the second line of defence.
    - **`NODETERM_OWNED_SKILLS` (`manage-nodeterm-canvas`, `get-linked-context`) is never linked and
      never pruned.** Their presence in an account dir is decided by nodeterm's own installers; if
      sharing linked them, the off-switch would delete a skill the canvas-control installer had put
      there and the two owners would fight over the name at every launch.
    - **The realpath refusal is load-bearing.** The issue's manual workaround
      (`mv skills skills.bak && ln -s ~/.claude/skills skills`) makes the account's `skills/`
      RESOLVE to the system one; linking into it would plant links in the user's own folder and let
      the off-switch delete them from there. The planner compares REAL paths and refuses
      (`same-directory`), which also covers a linked account whose `configDir` was hand-edited to
      `~/.claude`.
    - **Windows uses a directory JUNCTION** (`fs.symlink(target, path, 'junction')`), not the `'dir'`
      symlink `worktree-shared-paths.ts` must use: a junction needs neither Developer Mode nor
      elevation, and every target here is an absolute directory — the two conditions it has. On
      POSIX Node ignores the type. So the feature is available on every desktop platform rather than
      gated off one.
    - **The launch sweep re-links but NEVER removes** (`installHooksIntoLocalAccounts`). ON has real
      work at boot (a skill added to `~/.claude/skills` since the last run; a stale link to prune);
      OFF is a removal, and ownership here is inferred from a link's SHAPE, which cannot tell our
      link from an identical hand-made one — and a LINKED account's dir is the user's own
      `~/.claude-2`, where exactly that is a normal thing to find. Removal therefore happens only
      through `claude-accounts:set-skill-sharing`, where the intent is explicit. The cost: a
      settings.json hand-edited to `false` while the app was closed keeps its links until the switch
      is flipped.
    - **The switch flips the filesystem FIRST and persists the flag only if that returned** — the
      flag is what the sweep replays, so a stored `true` whose links were never made would make the
      switch lie until the next boot. A refusal stores nothing.
    - **The copy says the edits flow both ways**, because a link is not a copy: editing a shared
      skill from inside the account edits the machine's own file. A user who reads "share" as "copy"
      finds that out by losing work. Result sentences are the pure `renderer/lib/skillSharing.ts`.
    - **Surfaces.** Desktop: full. **Server Edition: full** — the whole implementation is core, so
      the ws-bridge leg is a real passthrough and the machine the browser is served from is exactly
      the machine whose `~/.claude/skills` is shared (the canvas skill is not installed there, but
      its name stays reserved: a reserved name that is never created is inert). **SSH accounts:
      explicitly out of scope for v1** — their config dir is on the host, so the option would have to
      link that host's skills over the ControlMaster, with its own generated-shell proof obligation.
      The switch is DISABLED with that reason (never hidden), and core refuses (`remote-account`) as
      the backstop for a hand-edited settings.json. **Mobile: N/A** — the phone never mints an
      account and carries no skills concept.
  - **Linked accounts** (`ClaudeAccount.configDir`) — a PRE-EXISTING local config
    dir the user already drives themselves (`export CLAUDE_CONFIG_DIR=~/.claude-2; claude …` in a
    plain terminal) adopted as a first-class account without a login node. Settings → Accounts →
    **Link existing config dir…** (or one click on a **Detected** dir) calls `claude-accounts:link`
    (core service): `~` expansion → `normalizeLinkedConfigDir` → string-only refusals (the system
    `~/.claude`, anything under `{userData}/claude-accounts`, an already-linked path) → `stat` →
    email from `<dir>/.claude.json` (missing = `email: null`, not an error) → managed hook install.
    `claudeConfigDirFor(id)` consults a **registered accounts source**
    (`registerClaudeAccountsSource`, both shells right after `settingsStore.init()` — BEFORE the
    mirror settings provider can flush, or the phone would be advertised a non-existent managed
    dir), so env injection, `transcriptRootFor`, the transcript index, usage rows and the pickers
    all resolve a linked id to the user's own dir with no per-caller branch. The transcript jails
    (`isSafeLocalTranscriptPath`, both raw listeners) accept `<linkedDir>/projects/**` for dirs
    **from settings only** — never a dir named by the POST. **Removing a linked account only
    forgets the record**: the `rm -rf` names `accountConfigDir(userData, id)` directly, so it is
    structurally incapable of reaching outside the managed root even if the settings row is gone
    before the IPC lands. The hook installer writes `settings.json` THROUGH a symlink
    (`writeFileSync`) — a profile whose `settings.json` symlinks to `~/.claude/settings.json` (the
    two-profile layout) stays a symlink; pinned by `claude-accounts-link-symlink.test.ts`, and
    switching that write to `renameAtomic` would be the regression (it replaces the link).
  - **Observed account** (`ObservedClaudeAccount`, `NormalizedAgentEvent.account`) — which account
    a session is ACTUALLY on, derived by the hook server from the payload's `transcript_path`
    (`<configDir>/projects/<slug>/<session>.jsonl`; `configDirFromTranscriptPath` walks up to the
    LAST `projects` segment, so `~/projects/.claude/projects/…` names `~/projects/.claude`, not
    `~`). `classifyClaudeConfigDir` is pure string matching, host-agnostic: managed local root →
    managed remote pattern (`…/.nodeterm/claude-accounts/<id>`) → linked (settings) → any
    `…/.claude` ⇒ system (`accountId: null`) → else `known: false`. It is a **LABEL** exactly like
    `verified`/`clientRevision`: attached to the normalized event in ONE place (the hook server),
    so both shells inherit it and neither raw listener changes; claude events only; never throws;
    **never reads the filesystem** (a forged POST naming `~/.ssh/projects/x` gets `known: false`
    and nothing is opened). Recorded by the mirror (`MirrorEntry.account`) and the renderer store
    (`agentStatus.account`, persisted like `agentId` — a hand-launched claude's identity exists
    nowhere else). **Effective account for READERS** = `data.accountId ?? observed.accountId`
    (`renderer/lib/accountChip.ts` `effectiveAccountId`): `readSessionName`, `context.ensure`, the
    transcript search and the ⌘M view use it; **spawn/env never does** (launch identity stays
    creation-time). The **account chip** (`components/AccountChip.tsx`, ONE component on the node
    header, kanban card, card modal and sidebar row) shows for any non-system account, and for
    system panes only when ≥ 2 distinct account keys (`sys` / `<id>` / `ext:<dir>`) are live on the
    core (`hasMultipleAccountKeys`, a primitive selector so headers don't re-render on every hook
    event). An unlinked dir is named by its last path segment (`.claude-2`, dashed chip) with a
    tooltip pointing at Settings → Accounts, where **Detected config dirs** lists it for one-click
    linking. Mobile: N/A (additive mirror fields).

