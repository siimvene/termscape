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
  - "src/core/subagent-replay*.ts"
---
# Agent support: registry + capabilities, hooks, permission mode, transcripts, subagent/workflow viz, adding a new agent

> Moved verbatim from the root `CLAUDE.md` on 2026-09-01 (see its "How this documentation is
> organized" section). Loads automatically when a file matching the `paths` above is read;
> when the root routing table points here, read this file before touching the subsystem.
<!-- moved-verbatim-from: CLAUDE.md -->

## Agent support (Claude / Codex / Gemini / Copilot / opencode / Grok / Pi / custom)

The app is a pluggable multi-agent system: Claude Code is one builtin of
several. Extra terminal-node behavior is driven per agent by a registry + capability lists, a
shared 4-state model, and a **transient** zustand store `state/agentStatus.ts`
(`{state, agentId, unread, session, sessionId, loop, hibernated}` per node id; the live `state` is
**not** persisted — only `unread`/`session`/`sessionId`/`agentId`/`loop`/`hibernated` go to
localStorage under `nodeterm.agentStatus`, migrated once from the legacy `nodeterm.claudeStatus`
key. `agentId` is durable because a hand-launched `claude` in a plain terminal is known nowhere
else, and its context links must keep classifying across restarts).

- **Agent registry + capabilities** — `src/shared/agents/config.ts` holds `AGENT_CONFIG`
  (claude/codex/gemini/copilot/opencode/grok/pi: id, label, spawn command, color, `promptInjectionMode`, …) keyed
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
- **Pi** (`@earendil-works/pi-coding-agent` 0.84.1, builtin since 2026-09) — the first agent whose
  status comes from an EXTENSION nodeterm owns (`<agentDir>/extensions/nodeterm-status.js`, `.js` because
  pi's discovery ignores `.mjs`) rather than a hook file, and whose hook payload STATES its context
  usage (no transcript tail). Managed Pi accounts are config-dir isolation like Claude's. Full per-CLI
  reference: **`.claude/rules/agents-pi.md`** and **`docs/pi-agent.md`**.
- **Grok** (`@xai-official/grok` 1.0.0, builtin since 2026-08) — full per-CLI reference (capability
  memberships incl. `SUBAGENT_CAPABLE` since 2026-09, the hook-DIRECTORY dialect, `cwd`+`sessionId`
  session-path derivation, the inert claude-hook cross-fire, and native `SubagentStart`/`SubagentStop`
  card keying) lives in **`.claude/rules/agents-grok.md`** and **`docs/grok-agent.md`**. It loads when
  grok code is touched, so it is not duplicated here.
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
    `context.ensure` and the find bar's transcript index, both of which went through claude's
    `resolveTranscript` — whose **cwd fallback** then handed a codex node *the newest claude transcript
    for that cwd*: a stranger's session as its meter and its search hits. The find bar's index is
    gated by the pure `readsClaudeTranscript` (`renderer/lib/transcriptGates.ts`), which reuses
    `CHAT_CAPABLE` rather than adding a fourth list; **`context.ensure` LEFT that gate in 2026-09
    (issue #813)** once its handler stopped *being* claude's resolver and started routing per agent
    (see **Context-meter rehydration** below). The lasting rule: grep every consumer of a helper
    before adding an id to its list, and when two consumers need different answers, route the one that
    can be routed instead of widening the gate for both.
  - **`TITLE_READ_CAPABLE` was created here**: gemini names its own sessions through its `update_topic`
    tool (the title is in that call's `args.title`, NOT a top-level field) but has no rename command, so
    the read and write legs split. Its read path is the transcript the context tail already tracks
    (injected as `AgentSessionNameDeps.geminiPathFor`, held in a `let` in `src/main/index.ts` to avoid a
    TDZ throw that would kill a node's whole poll chain).
  - **In-place restart** works for gemini: `EXIT_SEQUENCES.gemini = '/quit'` — and it must stay **bare**,
    because `/quit --delete` exits *and permanently deletes* the session history, i.e. exactly what the
    restart exists to resume (pinned by its own test).
  Full picture, measurements, gaps and a device checklist: **`docs/gemini-agent.md`**.
- **Claude session context capacity (#818)** — the managed hook reports only
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS` from the effective Claude process environment (including
  `--settings` env), never the GUI/server process environment. HookServer validates decimal safe
  integers and verified node identity before passing optional `contextWindow` metadata to BOTH
  shells. Missing metadata means an older/unverified hook; explicit null means the current hook
  observed no valid override and clears the old observation. Local and SSH tails apply the exact
  per-session limit before the family estimate, including SMALLER limits; equal model ids do not
  share configuration. The renderer labels family fallbacks as estimates. Claude observations are
  not loaded from localStorage: `context.ensure` rehydrates usage, and until another verified hook
  observes the session env an idle Claude session has only an estimated window. No arbitrary
  endpoint fields, credentials, config-file reads or CLI commands are involved. A changed transcript
  starts fresh tracked state; unchanged hook observations never replay usage. Only `context.ensure`
  explicitly replays the live snapshot for a remounted consumer. Async reads from replaced/untracked
  entries cannot publish.
  Desktop and Server share validation; the SSH tail receives the remote hook's own env. Canvas and
  kanban share ContextMeter. Mobile's separate implementation needs the same provenance distinction.
  Gateway catalogue/accepted-launch work remains in #723/#725; this does not replace those PRs.
- **SSH context polling is a bounded byte protocol** (issue #816). The initial snapshot reads
  only the last 1 MiB and records the absolute end offset; subsequent polls process at most
  1 MiB. `core/remote-ssh/transcript-window.ts` measures size and uses block-aligned POSIX `dd`
  with base64, transferring less than 1.6 MiB including alignment/framing; idle replies contain
  only the size/range header. The encoded dd exit status must survive the shell pipeline:
  pipeline success alone can hide a failed read. Short/malformed replies and SSH failures throw,
  retain the cursor, and back off from 2s to 60s with payload-free diagnostics. A SEPARATE idle
  backoff (`idleDelayMs`) stretches the 1 s poll after three consecutive empty successful reads
  (2/4/8 s, capped at 10 s) and is reset by any data-bearing read and by every same-ref `track()`
  — i.e. every hook POST for the session, which is what keeps a `<task-notification>` (it rides
  a UserPromptSubmit hook) at ~1 s latency; never merge it with the failure backoff. Bootstrap and
  detected truncation restore usage without replaying historical task notifications/tool results,
  including a historical partial line completed later. A changed remote reference replaces its
  tracking generation so stale in-flight replies cannot publish. Server Edition uses the local
  core tail on its host (no SSH-project manager); mobile has its own direct-SSH implementation,
  so this desktop fix makes no claim about that separate path. Real `/bin/sh` fixtures cover
  >20 MiB idle files and a new notification split inside UTF-8; BSD/macOS SSH remains a device check.
- **Permission mode** (agents in `PERMISSION_MODE_CAPABLE` — claude, grok, **gemini**, **codex**) —
  the mode a session **starts** in (`claude --permission-mode <mode>`; Shift+Tab still cycles it at
  runtime). Membership no longer implies claude's flag spelling: **the per-agent translation lives in
  `src/shared/agents/approval-mode.ts`** (`approvalFlags` / `modeSupported`), which is also where
  `withPermissionMode` now lives — it moved one layer up out of `config.ts` to break a cycle.
  gemini = `--approval-mode default|auto_edit|yolo|plan`, codex = `--ask-for-approval
  on-request|never` (and `untrusted` too, but only on a codex that still has it — see the next
  paragraph). Two rules the mapping exists to enforce: a mode the CLI **cannot
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
  does — so the note now reads "Auto has no Gemini equivalent…" beside codex's gaps, and the
  residual wart is only that `auto` and `manual` land on the same gemini policy (the *prompting* one).
  `--sandbox` is a separate axis and deliberately untouched (`--ask-for-approval never`
  still sandboxes).
  **AN AGENT'S VOCABULARY IS NOT A CONSTANT — codex's moved, and the table is gated on a probe of
  the binary in front of us (#785).** Measured release by release on the published linux-x64
  binaries: 0.146.0 / 0.147.0 / 0.148.0 advertise `untrusted, on-request, never`; **0.149.0**
  through 0.154.0 advertise `on-request, never`. clap does not ignore a value it does not know, it
  prints `error: invalid value 'untrusted'` and **exits**, so a Manual-mode Codex node launched from
  the pinned table died at the prompt and left the pane at a bare shell. The gate is codex's OWN and
  sits beside claude's, never inside it (a gate fed by `claude --version` belongs to claude):
  **`core/codex-cli.ts`** reads `codex --help` once per app run — FEATURE-detected, not
  version-compared, because a floor guesses about builds that are not on npm — parses the option's
  own slice with `codexApprovalValuesFrom` (the neighbouring `-s, --sandbox` carries its own
  `[possible values: …]` two lines up, and a page-wide scan emits `--ask-for-approval read-only`),
  and publishes `CodexCliCaps` over `codex.cliCaps()`, registered by **both** shells. Every emitter
  threads it as `ApprovalCaps` — `approvalFlags` / `modeSupported` / `withPermissionMode` /
  `unsupportedModesNote` all take an optional trailing `caps`, and the **omitted** form resolves to
  the BASELINE `['on-request','never']`, the two values every measured codex accepts. That default
  is the design: a call site that forgets to thread its probe result loses a mode, never a launch.
  On 0.149.0+ `modeSupported('codex','manual')` is **false** and the derived note says so —
  measured before concluding it: `-a unless-trusted` is refused, `-c approval_policy=untrusted`
  fails config load, and `--approve-for-me` routes approvals through *automatic* review. **Remote is
  unknown, never guessed**: an SSH node runs the HOST's codex and there is no remote codex probe yet
  (claude has one, at connect), so `codexApprovalCaps(ssh)` and the mirror's SSH slice publish
  nothing and fall to the baseline. Same for a relay tab (the guest's machine) — its stub answers
  unknown on purpose. Three surfaces: **Desktop** and **Server Edition** both probe their own
  machine (the server's `registerCodexCliIpc` is REAL, unlike its deliberately-false
  `registerCodexIdentityIpc`); **Mobile** gets the vocabulary as `MirrorSettings.codexApprovalValues`
  — the desktop/server now publish it, the iOS reader is the follow-up. The app-server **usage
  tier** (`usage/codex-usage.ts`) carried the same dead `-a untrusted` and silently returned null on
  every current CLI; it is now `-a never` with **no probe**, because `never` is in both vocabularies
  (measured against 0.148.0 / 0.151.0 / 0.154.0) and `-s read-only` is what actually guards the
  user's files.
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

**Command-bearing terminal opens (issue #653):** the shared hook-server route requires verified
node identity whenever `open-terminal` carries `cmd`, including an empty value or a dry run.
The strict-policy override and foreign-instance fallback cannot release this gate. Desktop plain
terminal opens keep their existing identity policy; Server Edition still requires verification
for every control verb. Legacy mobile/SSH callers must present this instance’s node token for
command-bearing opens; this does not add a human-confirm dialog or change mobile transport APIs.

- **Hook-reply answers: plans and questions** (`core/agents/permission-decision.ts`, full write-up in
  **`docs/hook-reply-approvals.md`**) — the managed hook holds a Claude `PermissionRequest` and polls an
  answer file. For `ExitPlanMode` / `AskUserQuestion` (`requiresUserInteraction`) Claude **DROPS a bare
  allow**, so the answer must carry `updatedInput`: plan = `{}` (+ optional session `setMode
  acceptEdits|default`, never `auto`), question = the request's own `questions` + `answers`. Rules a
  refactor must not undo: (1) **only core builds decision JSON**, from the pending request file on the
  agent's host (never renderer-echoed questions), validating every field; (2) the script prints only the
  fixed words' decisions or a file that passes the strict prefix/size/one-line bound
  (`isBoundedAnswerContent` is the TS twin — both writers refuse anything the script would ignore);
  (3) answer content never rides an argv (the answered POST carries the decoded verb; SSH writes go on
  stdin); (4) a plain `allow` maps to `updatedInput:{}` for a plan and is swallowed (hook keeps
  holding) for a question — core refuses to write it and the header hides ✓ Approve for that ticket;
  (5) these two tools hold 540 s (`PERM_WAIT_SECS_INTERACTIVE`) under the explicit `timeout: 600` we
  write on the PermissionRequest handler — except a subagent's request (payload carries `agent_id`),
  whose dialog awaits the hook; (6) structured answers are gated on the SCRIPT REVISION: an old script on
  an SSH host (rewritten only at connect) silently ignores JSON while the write succeeds, so the hook
  server keeps `held` only for `clientRevision >= MIN_STRUCTURED_ANSWER_REVISION` and core refuses a
  structured answer (or a plain plan allow) for a ticket it did not record as capable — never a false
  "answered". The renderer gets `held: {pendingId, toolName, questions?}` on the event/store (kept while blocked
  OR waiting), separate from the approve/deny `pendingId` the mirror strips from a question;
  `questions` (a held AskUserQuestion's exact question texts, from the one `readQuestions`) is what
  the ⌘M answer controls match their card by — absent = unreadable input = no controls. Desktop local + SSH, Server Edition local;
  relay unchanged; phone keeps `allow`/`deny` (its plan approve now works via the script mapping).
An unanswered Claude `AskUserQuestion` is correlated by session and tool-use ID in the core
mirror, independently of its short-lived display stash. Ordinary hooks, subagent activity and
unrelated transcript results must not clear attention or archive its inbox card. Both shells
use `recordQuestionResult` for transcript rescue (including Escape/decline), and broadcast the
mirror's effective event. Keep result IDs through local and SSH tails; a boolean “some tool
finished” is insufficient. Explicit new user turns, interrupts and session boundaries reset it.

Claude child `PreToolUse`/`PostToolUse`/`PostToolUseFailure` hooks must not drive parent state.
Child `PermissionRequest` and attention `Notification` hooks still reach needs-you and phone
approvals, including the raw approval summary and deterministic reply ticket. Keep raw summary
recording before the child transcript-association guard in both shells.

A held parent question can overlap child permissions: retain its question card and waiting
state while publishing each approval ticket separately. Approval replies resolve only their
own ticket; the picker stays pending until its correlated answer or explicit reset.
When the parent answers first, retain concurrent approval tickets and blocked attention until
their own replies; ordinary tool activity cannot settle them. Explicit turn/session resets
still cancel both kinds of pending attention.

Held approval attention must not replace subagent, recurring or background-task events, or refresh
state evidence from those lifecycle hooks. A parent may ask several questions while a child ticket
is outstanding: track each new picker and preserve child approval cards independently, including
when their display titles match. Answering either resolves only that question or ticket.

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
    and `stop()` deletes only the endpoint contents this run published — a failed start cannot
    erase another owner's advertisement. A crash skips cleanup, which is why clients still walk
    the candidates.
    HTTP 421 means the bearer belongs to a different endpoint and is rejected BEFORE dispatch;
    it joins dead transport (curl 000/'') in the bounded discovery walk. A node-identity 403/400
    remains final and is never re-sent to another instance. The walk is skipped under
    `CODEX_SANDBOX_NETWORK_DISABLED` for transport failures (#367); an explicit 421 proves
    transport worked and still permits discovery. The final error distinguishes "no endpoint
    anywhere" from "an
    advertised endpoint that is not listening" (`STALE_ENDPOINT_HINT`). Desktop quit calls
    `hookServer.stop()` on the second before-quit pass, after the flush window.

  - **Hook endpoint ownership (#826):** startup first probes every transport in an existing
    endpoint advertisement and preserves a live or uncertain owner. The local Unix listener probes its socket before
    cleanup. Only `ECONNREFUSED` plus the same device/inode permits removal; a live listener,
    non-socket, symlink or uncertain probe disables hooks without replacing its endpoint.
    Both shells use `startForApp`: Desktop creates its window and then shows an actionable warning;
    Server Edition logs the same warning and continues boot. An authenticated owner must answer
    `/verify` with 204 for the advertised bearer AND reject a random bearer (403/421); unrelated
    HTTP responses are uncertain listeners, not authenticated nodeterm. Probes have a hard deadline.
    Endpoint writes are atomic and stop removes only the run's own advertised contents. SSH setup
    never removes a socket before binding: every forward gets a fresh random path, while discovery
    is stable per project + installation identity hash. Only a verified replacement is advertised;
    then this run cancels its previous forward. A legacy project endpoint is migrated only when its
    bearer matches the current run, the previous installation-qualified advertisement, or a stale
    conventional local advertisement retained at boot. Publication rechecks the snapshot digest,
    refuses symlinks, uses a migration lock and a private temp, and never places credentials in argv.
    Without ownership proof (including a first upgrade after the old local advertisement was deleted),
    it preserves the file and logs instructions to restart affected agent sessions; discovery still
    works but may incur the old dead-tunnel delay until then. No real-host upgrade is claimed by unit tests. A reused tunnel that loses bearer verification
    emits hook-only health updates: the desktop shows a warning and clears it after repair, without
    reconnecting terminals. These changes share the core listener in Desktop and Server Edition;
    the mobile wire protocol and node-identity rules are unchanged.

  Enforcement is dated (`NODE_IDENTITY_STRICT_AFTER`, 2026-10-13, read through `isStrictInstant` so a
  clock years ahead cannot enter strict mode early) with a `settings.hookIdentityStrict` escape hatch
  in Settings → Agents. **Trust on first proof latches a node the moment it authenticates, so it
  refuses TODAY, not on the cutoff** — which is why every token sweep must also call
  `hookServer.forgetProvenNode`. `/hook/*` never 403s a missing token: the phone, the cross-instance
  failover and every pre-token session legitimately have none.
- **Shared Claude/Gemini settings are user data (issue #851).** The local hook install/remove
  and Claude fullscreen writers share `core/agents/hooks/settings-file.ts`; SSH system/account
  hook installs and fullscreen writes share `remote-settings-file.ts`. Only ENOENT / the remote
  explicit missing-file status or a successfully read empty/whitespace file starts from `{}`.
  Malformed/non-object/read-error settings are preserved. Each transaction stages the complete output, takes a `.nodeterm-lock` directory,
  compares its original bytes before rename, and preserves the file mode. Remote snapshots and
  replacements travel on stdin, with a byte-count check against truncated transport; the shell
  needs no Python/Node/jq. Local profiles resolve symlinks and lock/update the shared target,
  rechecking resolution before publication. SSH does the same with plain readlink + cd -P
  (macOS-compatible, no GNU -f), bounding cycles and refusing dangling links/newline paths.
  Grok's owned file heals malformed JSON and hook shapes by rebuilding its managed config.
  A held or crash-left lock skips the update with a diagnostic naming the lock and instructing
  the user to stop writers before inspecting/removing a stale lock; it never gets stolen. External editors need not honor our lock: the final comparison detects edits
  during merge/staging, but cannot eliminate an external write between comparison and rename.
  No claim that the reporter's historical wipe was proven to take this path: the catch-to-empty
  writer and its data loss were reproduced in fixture homes.
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
    **A poll of an unchanged transcript reads no bytes**: the local read is gated on the resolved
    path's (size, mtime) (`titleCache`, bounded at 500, a failed tail read never cached), and the
    remote one (`main/remote-title-reader.ts`) on the remote context tail's `offsetFor` for the SAME
    path — that offset is the file size at the tail's last read, so a remote `/rename` lands within
    the tail's idle backoff (real gaps between idle reads ≈3/5/9/11 s) PLUS one title poll
    (4–15 s); an untracked session (offset unknown) always reads.
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
  **Paged reads (2026-09).** `chat.readTranscript` takes a trailing optional `page`
  (`{before?, maxBytes?}`, `shared/chat-page.ts`). Absent = the legacy 5 MB-tail read, byte for byte
  (result is exactly `{messages, found}`). Present = ONE window of at most `maxBytes` (clamped
  64 KB…5 MB — it is untrusted IPC/WS input; an invalid `before` REJECTS rather than being coerced
  to "end of file") ending at byte `before`, and the result adds `olderCursor` (where the window's
  first complete line starts — the next page's `before`; `null` = reached the start), a per-message
  `key` (the line's ABSOLUTE byte offset — stable across prepends and appends), `id` on tool parts,
  and `unmatchedResults` (tool results whose `tool_use` sits in an OLDER window: the newer page is
  read first, so the renderer holds them until that page arrives). Parsing is the pure
  `parseChatWindow` over BYTES (a multi-byte char cut by the window edge only lands in the dropped
  partial line), and every window is read with **one byte of lookbehind** — the only way to know a
  line begins exactly on the edge; without it that line is dropped as "partial" and lost. A window
  with **no complete line** (one record bigger than the window — in practice a `type:user` line
  carrying a pasted screenshot or an image tool_result; 181 lines over 512 KB in 30 days on one
  host) is flagged `noCompleteLine` and **re-read at the same `before` with ×4 the bytes, up to the 5 MB cap**
  (`parseGrowingWindow` in `core/transcript-ipc.ts` — local AND SSH leg; a failed re-read is
  not-found, never the skip). Only a line **longer than 5 MB** is skipped (`olderCursor = window
  start`, never the window end, which would re-request the identical window forever) — before this,
  every line bigger than the page vanished, a regression against the legacy 5 MB read. The **SSH leg** is a ranged read
  (`transcriptPageCommand`, `core/remote-ssh/transcript-window.ts` — size + window in ONE round
  trip, dd status inside the base64 like the context-tail's window command) instead of pulling the
  5 MB tail on every open and every turn-end reload; its `{ok:false}` is terminal (never the local
  disk), and it is tested under a real `/bin/sh` (`transcript-page.realsh.test.ts`). **Grok does not
  page**: a paged request gets its whole capped read with `olderCursor: null` and no keys.
  Server Edition passes `page` through ws-bridge to the same core handler; relay still refuses.
  **ChatPanel consumes it progressively** (pure state in `renderer/lib/chatPaging.ts`): the first
  read is a 256 KB tail (`CHAT_TAIL_PAGE_BYTES`, with a "Loading conversation…" row), older 512 KB
  pages load when the user scrolls within 200 px of the top (or by themselves while the thread is
  shorter than the viewport — it cannot scroll), one at a time behind their own token, prepended
  with the scroll position ANCHORED on the scrollHeight delta (the loading row's own appearance
  included). A turn-end reload / ↻ re-reads only the tail and **merges by key**, keeping the older
  pages already loaded — unless no rendered message reaches into the new window (the turn wrote
  more than a whole window, so the bytes in between were never read): then it RESETS to the tail
  rather than stitch over a hole. Carried tool results are held until their tool's page arrives and
  dropped at the start of the file. `found:false` on an OLDER page is a failed page load (retry row,
  thread kept), not a missing transcript; a reload that fails to resolve never blanks a rendered
  thread — only a read with nothing on screen says "No transcript found". The remote leg's
  forget-a-located-ref rule lives in `main/remote-transcript-page.ts` (a hook-fed ref is never
  dropped on a failed read, and a hook event re-marks a located ref as hook-fed). Grok: one
  unkeyed read, no older pages, no "Beginning of conversation" marker (a capped read cannot know).
  **Loading surfaces (2026-09).** The lazy ChatPanel chunk suspends into `ChatPanelFallback` at
  ALL THREE mount sites (canvas node, kanban card modal, closed-transcript dialog — it replaced a
  `fallback={null}` that left the ⌘M face blank over the terminal): the panel's own shell plus
  `ChatLoadingStatus`, which ChatPanel's initial "Loading conversation…" row renders too, so the
  handover is identical DOM (a second row swapped rings and re-announced its `role=status`). Its
  spinner is the app's ONE spinner, `components/Spinner` / `.nt-spinner` — frozen, not hidden,
  under `prefers-reduced-motion`; never add a local one. A terminal node's label row ends in a
  quiet ⌘M hint (`lib/mdViewHint.ts`, id `md-hint`, hideable in Settings → Appearance) naming the
  EFFECTIVE chord and what it opens on that node; it sits in a zero-basis trailing slot that
  clips, so it can never add a line to the row (a height flip would refit xterm and SIGWINCH
  tmux). It is not on the kanban card modal: that header already carries the ⌘M toggle.
  **The composer sends only in `done` or an unknown state** (`canSendFromChat`,
  `renderer/lib/chatSendGate.ts`) — never in `waiting`/`blocked`, not just never in `working`:
  PermissionRequest and AskUserQuestion both normalize to `waiting`, the pane then holds a TUI
  select dialog this view does not show, and `sendText`'s Enter would ANSWER it ("Yes" is the
  default highlight). It also refuses any node whose CLI has left the pane — hibernated, paused,
  dropped, or **exited** (`/exit`/Ctrl+D: `state: undefined` + `sessionEnded`) — because a SHELL
  owns it and the message would run as a shell command. That test is `agentProcessInPane`
  (`terminal/live-work.ts`), the same single rule the memory levers use — never a second copy of
  the flag set — and it ranks above the state (`chatSendRefusal`). Everything is re-read from the
  store at send time, not only at render. Same trap as the in-place restart's `/exit`. The bar's ↻
  reloads on demand (beside the empty state's Retry), since a session whose hooks never report
  `working` never takes the turn-finish reload.
  **Live progress (2026-09).** While the agent works, a `role=status` row closes the thread (the ONE
  spinner + the placeholder's own "<agent> is working…"/"waiting for an answer" sentence; optimistic
  right after a send, bounded by `CHAT_OPTIMISTIC_WORKING_MS`), and every hook event re-reads the
  tail — throttled (`CHAT_LIVE_RELOAD_MIN_MS`, trailing read guaranteed), single-flight, never for a
  hidden panel or document (`lib/chatLive.ts`). The trigger is `agentStatus.onHookEvent`, NOT a
  `stateAt` selector: same-state events refresh `stateAt` in place and notify no zustand subscriber.
  A live read passes `applyTail(…, {carryUnconfirmed})`, which keeps the trailing unkeyed optimistic
  send until the tail holds a matching user line (the send's own UserPromptSubmit read races the
  transcript write); it never resets a failed older page or flips an empty state to "Loading…".
  Gap: the panel reads the DEFAULT agent-status store, the only one Canvas's hook listener writes, so
  a relay tab gets neither the row nor live reads until relay status is routed per session.
  **Plan and question bodies (2026-09).** A tool call is normally a collapsed chip (`name` + a
  ≤200-char `arg`), which left an `ExitPlanMode` plan — the full markdown the terminal shows as
  "Here is Claude's plan" — and an `AskUserQuestion` question + options unreadable in ⌘M, the one
  place meant for reading them. `core/chat-tool-body.ts` (pure) fills the tool part's optional
  `body` for exactly those two tools (`input.plan`; the questions rendered as markdown), capped at
  64K characters (never splitting an open code fence or a surrogate pair; model-authored labels are
  kept to one line with emphasis escaped), degrading to no body (the old chip) on any other shape;
  ChatPanel shows a part with a body as an expanded "Plan"/"Question" card through `MarkdownText` with its result under it, and
  the find-bar index (`linesFrom`) indexes the body in full like assistant text.
  **Answer controls on those cards (2026-09).** Only the card the node's `held` ticket belongs to gets
  controls (`lib/chatAnswer.ts` `activeAnswerCard`: newest unanswered card of the held tool; a question
  also needs identical question texts — `held.questions` and the card's `questions` come from the ONE
  `readQuestions`), and only while the pane is in a dialog state. They send a `PermissionAnswer`
  through `answerPermission`; a refusal is a quiet retryable error pointing at the terminal. Plan's
  default button is `restore` — never auto. See docs/hook-reply-approvals.md.
  **The thread look (2026-09-26, claude.ai-style)**: the user's message is a neutral rounded bubble
  on the right (`term-chat__bubble`, a tint lift — never the blue accent), the assistant's is plain
  full-width text with no bubble. One quiet action row per assistant TURN (`lib/chatThread.ts`
  `assistantTurnEnds` — a turn is a run of consecutive assistant lines, so a tool-heavy turn gets one
  row, not one per tool call), hidden until hover/focus and always shown on the latest turn: Copy (the
  turn's TEXT parts as markdown source, through `window.nodeTerminal.clipboard` — the app channel,
  which never rejects and bridges to execCommand in the browser) and a relative time from the new
  optional `ChatMessage.at` (epoch ms from claude's ISO `timestamp`, set by the core parser on BOTH
  the legacy and paged paths; absent when the line states none — never a made-up time). One
  60-second `now` tick in ChatPanel drives every row's label. No thumbs / read-aloud / retry (no
  terminal equivalent). `.term-chat__text` stays the markdown sink the link guard scopes to.
  **The composer (2026-09-26, claude.ai-style)** is one rounded box — textarea on top, a toolbar
  under it: "+" attach on the left; model label, muted effort label and a mic on the right (pure
  decisions in `lib/chatComposer.ts`). Four rules: (1) **attach = paths in the DRAFT, resolved the
  way a drop onto that node's terminal is** — the mount site passes `pathsForFiles` built on
  `droppedPaths` with the node's own SSH scope (`dropProjectId` in TerminalNode; `spawn.ssh` in the
  card modal), so an SSH node's file is uploaded to its HOST and the composer never grows a second
  resolver; "+" / drop / file-or-screenshot paste all feed it, and nothing is ever sent. (2) **The
  mic targets THIS composer's textarea, never the pane**: `nodeterm:dictate` carries a per-MOUNT
  `composerId` (the canvas node and the card modal can both mount one session's composer),
  `DictationTarget` gained `kind: 'chat-composer'`, and the overlay hands the take over
  `nodeterm:chat-dictation` (`lib/chatComposerDictation.ts`), saying so if the composer closed
  mid-take. (3) **The labels read the ContextMeter's store** (`useContextUsage` — ONE reader) and
  a click TYPES the agent's own picker command (`/model`, `/effort`) through the SAME
  `chatSendRefusal` gate as a message, re-read at click time, then flips to the terminal
  (`onShowTerminal`); `sendText` must answer `=== true` to flip. Measured for claude only
  (`composerPickerCommand`, via `capabilityAgentId`): any other agent shows no label, since a label
  that opens nothing is a lie. Hidden when the model is unknown; effort hidden with it. (4) **Effort
  was measured, not assumed** (Claude Code 2.1.283): read = the top-level `effort` the CLI writes on
  every assistant record it sent with one (`...E!==void 0&&{effort:E}`; its own history reader
  walks the same field; a transcript flips `medium`→`xhigh` on the first request after `/effort`);
  change = `/effort` (a `local-jsx` picker, levels `low|medium|high|xhigh|max`). `parseLatestUsage`
  takes it from the LATEST usage record only — never carried forward, a record without it means
  that model takes no effort — and both context tails push on an effort-only change
  (`ContextWindowUsage.effort`, optional: older hosts and other agents simply omit it). Like the
  model, it lags until the next request. Narrow composers drop effort first, then the model
  (`composerToolbarLayout`); "+" and the mic stay. No voice-conversation button: there is no
  terminal equivalent. Surfaces: Desktop + Server Edition identical (dictation and uploads already
  bridge — `files.saveUpload`, `speech.*`); SSH nodes upload to the host; kanban card modal shares
  ChatPanel and wires both props; relay tabs keep the panel's existing refusal; mobile N/A.
  Fix-round rules (same day): the composer is its OWN component (`nodes/ChatComposer.tsx`) so the
  thread and the composer restyle independently. A label click is an explicit "go to the
  terminal", so the flip FOCUSES the xterm whatever its entry state was
  (`requestTerminalFocusOnExit(nodeId)` before the state change, consumed once by the node's
  `useMdModeFocus` — TerminalNode and ModalTerminal both key it by node id). `/model` and `/effort`
  open LOCAL pickers that fire NO hook, so the gate still reads `done` while one is on screen: the
  composer holds a picker command in flight (ref + disabled/`aria-disabled` labels, and Enter is
  swallowed) from click until the flip or failure — a second click would otherwise paste
  `/model` + Enter INTO the picker, confirming its highlighted row. **Inherent limitation:**
  returning to ⌘M while a picker is still open reads `done` too, so a chat send or a label click
  there would type into it — the pane is not observable from here. Shortcut dictation (keyed chord
  and hold-to-talk) targets the composer holding the caret before the selected terminal (the pane
  under the view is hidden) via `composerFromElement`; the dispatcher offers keyed dictation in
  that one text field (`isChatComposerTarget`). Both are keyed on the composer BOX
  (`[data-chat-composer-id]`), never on the textarea's `term-chat__input` class — the plan
  "Revise…" textarea and the question "Other" input share that class and sit outside the box. With
  focus anywhere else inside `.term-chat` (those fields, the answer buttons) BOTH shortcut paths
  refuse (`shortcutDictationFocus` → `refuse`): their fallback, the selected terminal, is the hidden
  pane showing the very plan/question dialog, and typed characters landing there would move its
  highlight or fill its "Other" field (the overlay types with `enter: false`, so nothing submits).
  **Every mic that names only a NODE** — the terminal header mic, the card modal's header mic, the
  Dock mic and the shortcut fallback (selected terminal / open card) — goes through
  `dictationTargetForNode`: while that node's chat view is up (`.term-chat[data-chat-node-id]`) the
  take goes to its mounted composer (the card modal's own when the modal is open for that node, so
  a modal showing the LIVE terminal still targets it), a chat view with no composer refuses, and
  otherwise it is the terminal as before. Every refusal says so in one `nodeterm:toast`
  (`announceChatDictationRefusal`, naming the composer mic) instead of a silent dead key.
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
- **Context-meter rehydration (`context:ensure`)** — the meter is fed by hook events and a tmux
  session outlives the app, so a continuing session idle after a restart shows a blank meter until the
  next prompt. The mount-time read that closes that is `core/context-ensure.ts`
  (`registerContextEnsureIpc`), **in core so BOTH shells serve it** — it used to be inline in
  `src/main/index.ts` with no Server Edition handler (issue #813, the same hole `core/transcript-ipc.ts`
  closed). Three rules: (1) **it routes per agent, never widens a gate** — `agentId` picks that agent's
  OWN locator/tail (claude → `resolveTranscript`, codex → `locateCodex`, gemini → `locateGemini`, the
  last two keyed STRICTLY by session id); an agent not in the switch gets NO meter, never claude's
  resolver. grok is deliberately absent — its `signals.json` dir is learned from a hook event, so a
  restart has nothing to rehydrate from. (2) **A remote node is resolved on its HOST or not at all**
  (`ensureRemote` → `remoteTranscriptRefFor`, reusing the ⌘M locator/jail/cache); "could not resolve"
  is terminal. Remote Codex uses its own account-scoped locator and parser over the same bounded SSH
  reader. Its reported transcript window wins; Claude estimates must never supply a Codex
  denominator. Unresolved/disconnected remote nodes cannot fall through to local readers.
  (3) **Nothing negative is ever cached** — a clean miss and a failed ssh
  call are indistinguishable, so both cache nothing and the next mount retries in full; only concurrent
  in-flight calls are de-duplicated. **No timer** — one read at mount. Desktop + Server Edition full
  (local-only on the server); kanban card + modal inherit the same `ContextMeter`; Mobile N/A. Tests:
  `core/context-ensure.test.ts` + `main/context-ensure-wiring.test.ts`.
- **A killed CLI is DETECTED (`agentStatus.dropped`, `renderer/terminal/agent-liveness.ts`, issue
  #616).** Every orderly exit announces itself (`/exit` fires SessionEnd, hibernate/pause set their
  chips); a KILL announces nothing (the process is gone before a hook can run) and tmux's shell still
  owns the pane, so the node keeps rendering its last badge over a dead conversation. Measured on the
  reporting host (2026-09-04): 62 GB RAM + swap consumed, `oom_kill` at 187, 147 live `claude` processes
  holding 44 GB. The signal is `#{pane_current_command}` reading as a shell while the status table still
  believes an agent is parked. Four refusals ARE the feature: a `null` pane read is NEVER evidence (a
  downed ControlMaster must not make healthy remote nodes claim death); `hibernated`/`paused` already
  have chips; **only `done`**, never `working` (a tool subprocess owns the pane's foreground mid-turn);
  and the agent must be in **`SESSION_END_CAPABLE`** — DERIVED from `normalize.ts` (the four normalizers
  that map `sessionPhase:'end'`: claude, gemini, copilot, grok; codex and opencode map none, so there a
  deliberate `/quit` and an OOM kill leave byte-identical evidence). The verdict is TRANSIENT (a claim
  about a pane, re-measurable in ms; persisting it would strand a stale chip on a resumed node) and ANY
  hook event withdraws it. It also catches a bare shell from a cold-restore `--resume` that hit "No
  conversation found" (a persisted `sessionId` outliving its transcript; 20 of 108 re-measured) —
  cold restore now probes `transcript:exists` first and launches bare on `absent`. Chip on node
  header, kanban card, modal; Desktop + Server identical; relay tabs answer `null`, never judged.
- **A reused ControlMaster is not evidence of a live hook tunnel** (issue #735 — remote sessions stuck
  on Unknown, no notifications). `connect()`'s reuse branch returned the cached `hookEndpointPath`
  whenever `ssh -O check` answered, but our own `ControlMaster=auto`+`ControlPersist` self-heal rebuilds
  a dead master on the next child command — and the rebuilt master carries no `-R` (only
  `RemoteHooks.setup()` calls `hookForwardArgs`), so hook POSTs die into a socket file that still exists
  with nobody listening while terminals, mirror and git all work. MEASURED on the prompting host: 10
  per-project hook sockets, exactly ONE with a listener; 107 of 128 live `nodeterm-rmt` sessions pinned
  to the dead endpoint (tmux ignores `-e` on an existing session, so they stayed dark until restart).
  The reuse branch now probes the tunnel (`RemoteHooks.tunnelAlive`, one `curl` over the master) and
  re-runs idempotent `setup()` on no answer, firing `onTunnelVerified`. The retry is backed off
  (`src/main/remote-ssh/tunnel-repair.ts`, pure + tested): first failure repairs immediately, a host
  that can never forward settles at one attempt per 15 min. A missing spec answers "not alive" (nothing
  bound = a tunnel that cannot deliver).
- **The per-agent remote hook installs run CONCURRENTLY** (`RemoteHooks.setup()`, the chain
  `connectOnce` awaits before a project reports connected). MEASURED against a real sshd through 50 ms
  RTT, 5 runs: **3281 ms serial → 1471 ms concurrent** over the same 22–24 ssh children. The installers
  are independent by construction (each writes its own script + merges its own agent's config; the only
  shared statement is an idempotent `mkdir -p`), and `SshChildGate` (cap 6 per ControlMaster) keeps the
  fan-out safe against a stock host's `MaxSessions`. Two rules: **the tunnel + endpoint file stay
  strictly BEFORE the fan-out** (that file is what every installed hook POSTs through, written only
  after the tunnel verifies end to end; `remote-hooks.test.ts` pins ordering AND overlap), and
  **`allSettled`, not `all`** — one installer failing costs that agent its hooks and nothing else, not a
  `return null` that discards every other agent's setup and (post-#735) retries forever.
- **A third subagent-card removal path is opt-in** (`settings.autoHideFinishedSubagentCards`, default
  OFF; mirrors to the store as `autoHideFinished`). With it on, a card is dropped the moment its
  subagent REPORTS done, with no turn boundary; OFF reproduces the two existing paths exactly. Only a
  DONE card is ever dropped, so #547's rule (a new turn keeps still-running subagents' cards) and Eco's
  `liveSubagents` are untouched. **The decay is deliberately NOT one of the paths it gates**:
  `sweepStaleWorking` fires precisely because the end never ARRIVED — the opposite of what the setting
  promises, and the one case where a visible card carries the most information (a fan-out whose
  subagents died silently would otherwise leave nothing on the canvas). Renderer only; Desktop + Server
  identical; Mobile N/A.

### Subagent reload replay (#680)

`core/subagent-replay.ts` retains at most 512 running starts for the existing WORKING_STALE_MS,
with original host timestamps. The shared mirror event path feeds it (including synthetic async
ends); session boundaries and clearNode discard it. Both shells expose the same read, and desktop
preload / browser / relay subscribe before requesting it. Only lifecycle events wait behind the
snapshot (bounded to 512 events / 3 seconds); live permission alerts are not delayed or replayed.
No disk restore, transcript backlog, completed-card replay, or authorization evidence is provided.
A host restart or a missed original start is still outside this recovery.

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
