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

## Agent support (Claude / Codex / Antigravity / Gemini / Copilot / opencode / Grok / Pi / custom)

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
  transcript view (`CHAT_CAPABLE` / `canChat`) is **claude + grok + gemini + codex + copilot +
  opencode** since 2026-09: grok's `chat_history.jsonl`, gemini's session file, codex's rollout,
  copilot's `events.jsonl` and opencode's `opencode export` document each get their own reader, and
  `chat:read-transcript` routes by agent. That list had
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
  **`docs/grok-agent.md`**, **`docs/gemini-agent.md`**, **`docs/copilot-agent.md`**, **`docs/antigravity-agent.md`** (there is none for codex — its approval mapping
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
- **Grok NEEDS YOU confirmation + Grok ⌘M/phone chat view** (upstream v0.4.2) — the permission
  gate checked against grok's own event log (`core/agents/grok-permission-gate.ts`) and the
  `chat_history.jsonl` reader (`core/grok-chat.ts`) live in **`.claude/rules/agents-grok.md`**.
- **Copilot ⌘M chat view** (`core/copilot-chat.ts`, 2026-09; copilot 1.0.88 measured in BYOK mode
  against a local fake model, plus the CLI's own `schemas/session-events.schema.json`). Reads
  `<COPILOT_HOME>/session-state/<id>/events.jsonl` (then the snap package's
  `~/snap/copilot-cli/common/.copilot`), located STRICTLY by the node's session id and routed by
  `capabilityAgentId` before anything claude-shaped, so a missing journal is "not found", never
  claude's cwd-newest or another session. The journal is append-only JSONL (compaction appends), so it
  PAGES like claude's — `parseChatWindow`/`parseGrowingWindow` take copilot's record parser — and the
  phone gets the same pages over the relay (`page()` gates only on `canChat`). Shown: typed prompts
  (`content`, never `transformedContent`; the sources copilot's own timeline hides stay hidden),
  assistant text, tool calls with results (`Error: …` on failure), a user's `!` shell command as the
  `!` part, `Error:`/`Warning:`/`Info:` notices, and `model`. Never shown: the system prompt,
  reasoning, sub-agent events (envelope `agentId` / `data.agentId` / `data.parentToolCallId`). Not
  supported: remote (SSH) nodes (`unreadable`, "not supported yet" — never this machine's disk),
  `effort` (not recorded), plan/question answer cards (claude-only), composer model labels (claude's
  picker commands only). Golden fixtures: `src/shared/chat-fixtures/copilot/` (README "Copilot").
- **Antigravity** (`agy`, builtin since 2026-09 — Google's replacement for Gemini CLI on personal
  accounts) — full per-CLI reference (capability memberships, resume, launch, Windows hook dispatch,
  vendor-location fallback) lives in **`.claude/rules/agents-antigravity.md`** and
  **`docs/antigravity-agent.md`**. It loads when antigravity code is touched.
- **Codex in the ⌘M chat view** (2026-09-28; the desktop panel, the kanban card modal, the phone's
  `chat.page`). `core/codex-chat.ts` reads the rollout with codex's own rules, never claude's
  resolver. It takes USER text from the UI stream only: `event_msg/user_message` (legacy, ≤ 0.146) or
  an `item_completed` `UserMessage` (paginated, ≥ 0.151). Model-side `role:user` messages also carry
  injected context (AGENTS.md, `<environment_context>`, image wrappers), so they are never read.
  Assistant text and tools come from `response_item`, correlated by `call_id`. The UI copies
  (`agent_message`, `AgentMessage`) and reasoning are skipped. Failed and interrupted turns become
  `[error] …` / `[turn aborted…]` notes. A tool result drops codex's `… Output:` preamble. The rollout
  is append-only, so it pages by byte offset like claude. The locator matches a WHOLE-uuid thread id
  (`CODEX_THREAD_ID_RE`), because a uuid's last group passes `SESSION_ID_RE` and suffix-matches
  another thread's file. It searches only the node's own account home, and uses the codex tail's hook
  path only as a checked hint. An SSH node is read on its host (`main/remote-codex-chat-page.ts`,
  through the same resolvers as its remote meter) or not at all. Because codex announces no session
  end, a chat send first asks the kernel (`renderer/lib/chatPaneGate.ts`, `isAgentPane`). After a
  `/quit` the store still reads `done`, and the message would otherwise run in the shell. **Not
  supported:** images in prompts, reasoning summaries, the composer's model/effort labels (the
  `/model` picker is measured for claude only), plan/question answer cards (codex never sets
  `held`), and a closed REMOTE session's transcript. Record rules and fixtures:
  `src/shared/chat-fixtures/codex/`.
- **opencode in the ⌘M chat view** (2026-09-28, opencode 1.18.25 measured) — opencode has NO
  transcript file (SQLite since 1.18; that database also holds its account tokens and is never
  opened), so `readChatTranscript` routes `capabilityAgentId(agentId) === 'opencode'` to
  `core/opencode-chat.ts`, which runs `opencode export <sessionId>` (argv only, no flag an older
  yargs-strict CLI might refuse) and parses the one JSON document into claude's `ChatMessage` shape:
  user/assistant text, tool chips (arg by an opencode key order, result = 3 lines / 500 units,
  `Error: …` on a failed call), `[name] message` for an errored turn, compaction/subtask chips,
  `at` from `time.created`, `model`/`effort` from the newest assistant's `modelID`/`variant`.
  Reasoning, `synthetic`/`ignored` text, file/agent parts and step bookkeeping are dropped;
  unmappable shapes are skipped and counted. **One page, always** (`olderCursor: null`): there are
  no byte offsets to page by. The page honours the caller's `maxBytes` (the phone asks 256 KB),
  grows ×4 up to 5 MB like claude's reader when it holds no whole message, and shows a newest
  message larger than 5 MB TRUNCATED (with a note) rather than as an empty conversation. Refusals: no/unsafe session id runs
  nothing (a bare `opencode export` opens a picker over the NEWEST sessions — someone else's); an
  export whose `info.id` is another session is `unreadable`; only `Session not found: <id>` with
  exit 1 and empty stdout is a clean miss. **Remote (SSH) nodes are refused** (`unreadable`, no
  export runs) — their sessions are in the host's database and there is no remote leg yet; the
  panel's copy names both causes an opencode `unreadable` can have. One export costs 1.0–1.7 s and
  ~320 MB, so `createOpencodeExportGate` runs at most one per session (a caller arriving mid-run
  gets a FRESH export) and two in total; the panel's hook-driven refreshes are marked
  `page.background` and spaced ≥ 5 s per session, while an open / ↻ / Retry is immediate (and wakes
  a sleeping background one). A **change gate** in front of it `stat`s (never opens) opencode's
  `opencode*.db` + `-wal` in `$XDG_DATA_HOME/opencode` (else `~/.local/share/opencode`, opencode's
  own xdg-basedir rule) BEFORE exporting, and an unchanged fingerprint answers from a 4-session LRU
  of parsed exports; no db file found, or `OPENCODE_DB` set, means no caching. The export runs with
  `cwd: os.tmpdir()` (from a repo cwd opencode writes `<repo>/.git/opencode`; sessions resolve by
  global id). **It inherits the APP's `process.env`, not the node's shell env**: a user who
  relocates opencode's data via `XDG_DATA_HOME` / `OPENCODE_*` only in their shell rc gets
  "Session not found" — an honest miss, not a bug in the reader. Plan/question answer
  cards stay claude-only (no `body`/`questions` on opencode's `question` tool). Desktop and Server
  Edition both serve it (core handler); the phone gets it over the relay `chat.page` for free.
  Fixtures + the exact rules for the iOS port: `src/shared/chat-fixtures/opencode/README.md`.
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
- **Gemini CLI refuses personal Google accounts since 2026-06-18** (free / AI Pro / AI Ultra moved to
  Antigravity CLI — the `antigravity` agent above; Code Assist Standard/Enterprise, Vertex AI and paid
  API keys still work, so `gemini` stays a builtin). The refusal happens before any session, so no
  hook reports it: a gemini-harness node reads its own pane for the CLI's sentence
  (`renderer/terminal/gemini-retired.ts`, letters-and-digits match because the TUI wraps it in a
  box) and raises a slim banner — "Open Antigravity" (`nodeterm:open-agent`, an agy node beside it,
  in its frame) + Google's migration guide. It types and relaunches NOTHING, which is why a phrase
  match is enough here where `resume-fallback.ts` needs three refusals. `AgentConfig.notice` carries
  the one-line caveat to the menus/Dock tooltips; it is never read to decide behaviour.
- **Gemini ⌘M chat view** (2026-09, `core/gemini-chat.ts`) — gemini is in `CHAT_CAPABLE` with its own
  reader, routed in `readChatTranscript` via `capabilityAgentId` BEFORE anything claude-shaped and
  located only by the header session id (`locateGemini`, which now reads just the header and honours
  `GEMINI_CLI_HOME`). Its session file is an UPSERT log, not a message list: one id is rewritten in
  full as tool results/tokens land, `$rewindTo` truncates, and `$set.messages` replaces the MODEL's
  context at start, compression and rollback. The thread is the message records upserted by id with
  rewinds honoured and **`$set.messages` ignored** — honouring it erases the thread at every
  compression and shows the `<state_snapshot>` as the human's words. Not paged (a record depends on
  earlier ones): one read under the 5 MB cap, `olderCursor: null`, like grok. Shows typed prompts
  (`displayContent` over `@file` expansion; `<session_context>`/`<hook_context>` dropped per part),
  replies, tool calls with results, `[info]`/`[warning]`/`[error]` notes and (paged) the model;
  thinking is dropped. NOT supported: remote (SSH) nodes (`CHAT_LOCAL_ONLY` → "not supported yet"),
  plan/question answer cards, the composer's model/effort labels. The phone gets it over the relay
  unchanged; fixtures and exact rules: `src/shared/chat-fixtures/gemini/`, `docs/gemini-agent.md` §3.
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
  retain the cursor, and back off from 2s to 60s with payload-free diagnostics — logged when a
  streak starts, when it settles at 60 s and when it recovers, never per retry, and naming only the
  observed status (`exit 255`, `malformed reply`), never a guessed cause: the runner reports a
  timeout as status 1. **A transcript that does not exist is not a failure.** Claude creates it on
  the first prompt while SessionStart already hands over the path (measured on 2.1.283), so every
  unused remote Claude node used to walk the failure backoff and log a line a minute. The command
  answers `NODETERM_ABSENT` with status 0 and the tail polls it on the idle cadence; a file that
  appears after being seen missing is live from byte 0 when its bootstrap window covers all of it.
  A SEPARATE idle backoff (`idleDelayMs`) stretches the 1 s poll after three consecutive empty successful reads
  (2/4/8 s, capped at 10 s) and is reset by any data-bearing read and by every same-ref `track()`
  — i.e. every hook POST for the session, which is what keeps a `<task-notification>` (it rides
  a UserPromptSubmit hook) at ~1 s latency; never merge it with the failure backoff. That same
  `track()` also skips the rest of a pending failure wait (the host just reached us) but keeps the
  failure streak, so a read that fails again goes straight back to 60 s. Bootstrap and
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
  (`normalizeClaude`/`normalizeCodex`/`normalizeGemini`/`normalizeCopilot`/`normalizeOpencode`/`normalizeGrok`/`normalizeAntigravity`) that map each agent's native hook
  events to a `NormalizedAgentEvent` over the shared `AgentState` (`working | waiting | blocked
  | done`) plus subagent/recurring/session kinds. Canvas's listener consumes
  `NormalizedAgentEvent` from `agent:status`, drives the `agentStatus` store, fires throttled
  (5s/node) background notifications, and records the session id. Header shows a pulsing
  **RUNNING** (working) / **NEEDS YOU** (waiting/blocked) badge.
- **An interrupted Claude turn (Esc / Ctrl+C) fires NO hook — the transcript marker ends it**
  (`core/claude-turn-interrupt.test.ts`, fixture `shared/agents/__fixtures__/claude/interrupt-capture.json`).
  MEASURED on Claude Code **2.1.285**, interactive TUI in a private tmux server, capture hooks via
  `--settings`, every `NODETERM_*` unset: Esc while it streams, Esc during a foreground tool call,
  Esc on a permission dialog, and Ctrl+C once mid-stream each fire **nothing** — no `Stop`, no
  `StopFailure`, no `PostToolUse(Failure)`, and **no `idle_prompt` either**: that notification came
  60 s after a NORMAL `Stop` but not in 75 s / 80 s after an interrupt, so the `idle` rescue in
  `normalizeClaude` does not cover this case. Before this a node sat on RUNNING (or NEEDS YOU, for a
  dismissed permission dialog) until the 20-min stale sweep: `--after` dependents waited, Eco never
  saw it idle, the notch and the phone showed it working. What the interrupt DOES leave is a USER
  record, content `[{type:'text', text:'[Request interrupted by user]'}]` (`… for tool use]` when a
  tool call or its dialog was cancelled), whose **`promptId` equals the turn's `UserPromptSubmit`
  `prompt_id`** in every capture. Wiring, and the rules it rests on:
  - `normalizeClaude` puts `prompt_id` on the `UserPromptSubmit` event as **`turnId`**; the mirror
    keeps it (`MirrorEntry.turnId`, runtime-only, dropped at a session boundary).
  - The claude context tails (local, and the desktop's SSH one) scan COMPLETE lines with ONE
    stateful scanner per tracked transcript (`createTurnInterruptScanner`): a CLOSED set of the two
    texts, array content with exactly that one text part, non-sidechain (a typed prompt is a plain
    string, so typing the words matches nothing) — **and a marker counts for turn P only if P's
    OPENING prompt record was read BEFORE it** (bounded set of seen prompt ids, 256). The id alone
    is NOT enough, and this is not theoretical: in real transcripts on the dev host (2.1.209–2.1.283)
    34 of 114 accepted-shape markers carried the promptId of the prompt written AFTER them — "queue a
    message while Claude works, then Esc": the CLI tags the marker with the QUEUED prompt's id and
    writes that prompt ~36 ms later, and its `UserPromptSubmit` has already made it the node's
    current turn, so an id-only match ended the NEW live turn (fixture
    `__fixtures__/claude/interrupt-queued.json`). Measured on this host after the fix: all 26
    queued-shape markers rejected, no real interrupt lost. The one interrupt this drops is the one
    it cannot place; the interrupted turn really ended and the node is already in the next one. The
    remote tail's historical first read records prompts but never reports.
  - **Both shells** check the marker with `turnInterruptEvent` (a mirror PEEK) and push the result
    through their ONE hook-event path — desktop `emitAgentStatus` (mirror, broadcast, Notch HUD,
    agent messaging, station notices), Server Edition `emit` (mirror, broadcast, `opts.onEvent`:
    its delivery queue and `--after` scheduler). Pinned in `hook-verified-parity.test.ts`. It ends
    the turn ONLY when the marker names the node's CURRENT turn (same session, same `turnId`, state
    working/blocked/waiting): a marker read back from history, one from a finished turn or another
    session, one after a restart (no `turnId` then) changes nothing. A prompt event whose
    `prompt_id` is missing or not a plain token carries `turnId: ''`, which makes the mirror FORGET
    the previous id. The event is an ordinary `done` + `interrupted` (what a `Stop` with
    `is_interrupt` already produced), UNverified (a transcript read is not a hook POST), so no
    completion alert and the question/approval resets apply unchanged.
  - **`--after` does NOT release on an interrupted turn** (decision, 2026-09-30): the person
    stopped it, usually to redirect it, and the dependent would start on unfinished work — #521's
    reasoning for an errored turn. It is its OWN annotation, `agentStatus.lastTurnInterrupted`
    (transient; set by an interrupted `done`, cleared by a new turn or a `done` that is not
    interrupted), read by `depSatisfied`, the QUEUED tooltip (`interruptedDeps`), `list`
    (`LAST TURN INTERRUPTED`; an error outranks it), the canvas's `armedDepSig` (a verdict can clear
    under a steady `done` — a guessed interrupt then the real Stop — and the launch effect must
    re-run) and team progress (its own `interrupted` kind, NOT counted as done, so the ring never
    says "finished" beside a held dependent). It is deliberately NOT `lastTurnError`: the TURN
    FAILED chip, the station-failure notice and issue runs do not treat an interrupt as a failure.
    **The `idle_prompt` rescue does NOT set it** (`recordsTurnInterrupt`): it is flagged
    `interrupted` only to stay silent, and since `idle_prompt` follows a NORMAL Stop, a rescue means
    a lost Stop POST on a turn that finished — its dependents release as before. ▶ / `run` still
    start the dependent. The renderer's older keystroke
    guess (`inferInterruptAfterSettle`, 1.5 s after a lone Esc/Ctrl-C typed into THAT terminal)
    now records an interrupted `done` too, so a guess cannot release dependents before the marker
    lands; it stays because it is the only signal for the next case.
  - **Residual, measured:** Esc or Ctrl+C BEFORE the first token rewinds the prompt into the input
    box and writes NO marker (the transcript ends at the prompt record). Only the renderer guess
    (keystroke in that canvas terminal) sees it; the mirror — notch, phone, Eco's mirror reads, the
    Server Edition's headless `--after` — keeps `working` until the next hook or the stale sweep.
  - **Esc "during a subagent":** on 2.1.285 the Agent tool launched ASYNC even when asked for a
    foreground run, so the parent turn had already ended (`Stop`) — Esc at the prompt then fires
    nothing and does NOT stop the child, whose `SubagentStop` and `<task-notification>` arrive as
    usual. Nothing to fix there; a truly synchronous child being interrupted was not reproducible.
  - Server Edition: same core path (its tail + handler); its own headless `--after` still ignores
    both #521 and this annotation (pre-existing gap). Mobile: gets the `done` through the mirror.
  - **Device checklist:** (a) macOS desktop: Esc mid-stream / mid-tool / on a dialog → RUNNING
    clears within ~1 s, no chime, an armed `--after` dependent stays QUEUED with the interrupted
    tooltip; (b) SSH node: the same over the remote tail; (c) Server Edition browser tab; (d) a
    Claude older than 2.1.285 — whether the marker text and `promptId` match there is unmeasured
    (a changed text or a missing `promptId` matches nothing and degrades to the old behaviour); (e)
    queue a message while a turn runs, then Esc: the node must STAY working on the queued prompt;
    (f) the phone's Live
    Activity ends on the interrupt.
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
  `remote-status-push`'s `settingsFor` dep. `settings.customAgents` (`[{id, label, baseAgent?,
  binaries}]`) lets the phone chat with a custom agent: built ONLY by `core/mirror-custom-agents.ts`
  (one definition for all three providers — local file, which relay `projects.list` also serves,
  SSH slices, Server Edition), `binaries` = `binariesFor` from the pane-owner predicate, published
  only when every name fits the plain alphabet `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (else `[]`) —
  the builder enforces it because the tokenizer can "name" a slice of a secret (`oauth2:ghp_…` out
  of a git URL, a quoted env value, a `${env:…}` template). **Never put a custom agent's raw
  `launchCmd`/`args`/`env` in the mirror** — they carry API keys and the file lands on every SSH
  host. `binariesFor` resolves a BLANK launch command with a *builtin* `baseAgent` to the base's
  binaries (what `resolveAgentConfig` actually launches).
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
  - Control/context endpoint discovery keeps a known node capability as a **routing rule, not an
    ownership proof**. A dead Desktop SSH tunnel must not redirect a command to a local Server
    Edition: its unsupported-edition response describes the wrong instance. The two shims use
    `nt_adopt_for_node` (`core/agents/hook-endpoint-failover-sh.ts`). The reference value is read
    from the PRIMARY endpoint's own token dir only — the one it advertises, else the adjacent
    `node-tokens` — never from the global search `nt_read_node_token` walks (that search exists to
    PRESENT a capability, #384; as a reference it let a Server Edition that opened the same
    project.json supply the "owner's" token whenever the desktop's token write had failed). Once
    that dir EXISTS, a candidate must hold the same value in its own dir — and when the reference
    is EMPTY (the write failed), a value proves nothing (a Server Edition that never heard of the
    node holds nothing too, and `"" = ""` relayed its permanent refusal, measured in review), so the
    candidate's token dir must be the same REAL directory (`pwd -P`) instead. Only a session with no
    such dir at all keeps legacy discovery. What a match shows is
    that the candidate reads the same token file for this node — on an SSH host that file is shared
    per unix ACCOUNT (`remote-hooks.ts`, KNOWN LIMITATION), so two desktops driving one account are
    indistinguishable here, and the receiving server still authorizes every request. Actual
    owning-endpoint refusals remain final. Skipped foreign candidates do not consume the
    three-attempt budget, and a skipped candidate restores the previous endpoint vars (the codex
    sandbox hint names `$NODETERM_HOOK_SOCK` as the socket to allow). Hook event delivery retains
    its existing independent failover policy.
    **Every FALLBACK candidate is probed before the real POST** (`nt_probe_endpoint`: `/hook/verify`,
    204 on the bearer alone on every server build, `--connect-timeout 0.5 --max-time 1.5`). A reverse
    tunnel whose sshd outlived the desktop's connection ACCEPTS and never answers, and once the
    foreign Server Edition stopped absorbing the walk, a call posted straight into such a socket
    hung. The bound is on the probe only: the primary is never probed and every real POST stays
    unbounded, because a confirm-gated verb waits for a human (see "two canvases cannot raise two
    dialogs" below). The probe writes into `$nt_out` like the POST would, so a 421 at the probe
    still prints its body (into /dev/null it left the control shim exiting 1 with an EMPTY stderr),
    and the control shim names a final 421 with `CONTROL_UNREACHABLE_MSG` as the context shim does.
    Consequence to know: while sshd still holds the session's OWN tunnel socket, the primary POST
    itself still hangs — unbounded by design, for the dialogs.
    **Measured on an SSH host (2026-09-28/29):** the desktop slept, the session's tunnel socket
    stayed on disk with no listener, and the walk reached an unrelated Server Edition whose
    `control-unsupported-on-this-edition … permanent … do not retry` (and, for context reads,
    "No linked nodes") was true about that server and false about the session; the tunnel came
    back minutes later. When a foreign candidate was skipped and no owner answered, the shims now
    print `FOREIGN_ENDPOINT_HINT` — the owning connection is unreachable, the state is temporary,
    the usual cause for an SSH project is the tunnel — INSTEAD OF `STALE_ENDPOINT_HINT`, so a failure
    carries one retry advice, not two. With nothing foreign skipped, a primary that is an SSH tunnel
    file (`~/.nodeterm/hook-endpoint*.env`, the only files the desktop writes there) gets
    `TUNNEL_DOWN_HINT` (reconnect) instead of the stale-endpoint advice (app restart); both hints
    open with the lead the bodies quote. All four agent-facing bodies quote its lead via
    `ownerUnreachableGuidanceLines`, because their other refusal lines rightly say "do not retry".
    `src/server/control-owner-tunnel-down.test.ts` rebuilds that host under real `/bin/sh` with the
    real Server Edition handlers as the foreign endpoint; `src/core/owned-endpoint-walk.test.ts`
    pins the probe (hanging sockets), the owner reference, the single advice and the restore, each
    mutation-checked.
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

  - **No keyring is not "no identity" (#1088).** Electron 42 on a Linux session without Secret
    Service/kwallet picks `basic_text` and `safeStorage.encryptString` THROWS (measured under xvfb).
    The desktop secret load used to reject on every boot ⇒ no node token was ever written ⇒ `send` /
    `settings` refused forever with no visible cause. The loader now falls back to the Server
    Edition's raw 0600 `node-auth-key.bin` when it cannot seal and no sealed key exists (a sealed key
    it merely cannot unseal still rejects — rotating it orphans codex thread records), and both shells
    record a failed arming via `hookServer.setNodeIdentityUnavailable`, which a verified-only refusal
    then names. A secret that cannot be stored must degrade to the weaker store, never to a feature
    that is silently off.

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
- **Sound alerts + custom sounds** (issue #289) — the `done` / `needsYou` alert (`SfxKind`) is a
  synthesized WebAudio chime (`renderer/lib/sfx.ts`, fired from Canvas's `alert` closure, gated by
  `soundEffects`, 5 s/node cooldown). Settings → Notifications lets the user replace either with their
  own file. The picked file's BYTES (never its path) go to `files.saveAlertSound`, a core handler in
  `registerFsHandlers` (both shells), which validates kind / extension allow-list / 5 MB cap / magic
  bytes and writes ONE format-independent name `<userData>/sounds/<kind>.sound` (`core/alert-sounds.ts`;
  a name per format needed a delete-the-others step, and two tabs saving different formats at once
  deleted each other's file — do not reintroduce per-format names); reads and Reset take only the
  kind (no path from the renderer, symlinks refused). Settings keep only
  `customAlertSounds[kind] = {name, stamp}`. Playback decodes the bytes with `decodeAudioData` — no
  `<audio>`, so CSP `media-src` is untouched on both surfaces — and **any failure (missing file,
  refused read, decode/playback error) falls back to the chime without throwing** (`lib/customSfx.ts`,
  read failures and a missing/closed audio context are retried on the next alert; a DECODE failure
  is cached for that `stamp`, so a new pick is tried afresh). Every `playSfx` caller must pass `customAlertSounds` (source-pinned in
  `customSfx.wiring.test.ts`). Server Edition: full — the browser's `<input type=file>` bytes are
  stored in the SERVER's data dir. Mobile: N/A (own notification sounds).
- **Status-grouped sessions** — three always-visible sections: **Waiting for your response** maps
  internal `done`, `waiting`, and `blocked` together (a completed turn, question, or approval all
  need the user); **Running** maps `working`; **Unknown** means no live hook state is available.
  There is no Done bucket: a normal `done` hook means the turn ended and the agent is waiting for
  another user prompt. Within each section rows sort newest-first by `lastEventAt`, the transition
  clock (same-state hook freshness is `stateAt`), and show its short relative age. Missing clocks
  stay last with no made-up timestamp. A click may clear the glow but cannot move the row.
  **The clock survives an app restart as "last seen", never as a state** (`agentStatus.lastSeen`,
  `{at, state}`). `lastEventAt`/`stateAt`/`state` are transient, so before this every row after a
  restart sorted as "no clock" and lost its age. `lastSeen` is the time of the LAST hook event (a
  same-state one included) and the state it asserted, persisted beside the agentStatus record under
  its OWN small key (`nodeterm.agentStatus.lastSeen`) — chosen over the core mirror because the
  sidebar already reads this store,
  the mirror expires state after 6 h and identity later, and reading it would need a new IPC leg for
  a display fact. Rules a refactor must not undo:
  - **Restored as a clock only.** Load fills `lastSeen` and nothing else: `state` stays unknown (the
    hook server was down with the app, so a turn may have started or ended in between), and
    `lastEventAt` stays unset. Load marks the clock `restored` (transient, never written); the row
    reads `lastEventAt ?? lastSeen.at` and its `statusClock` is `transition` / `seen` (a hook event
    this run but no transition yet) / `restored`. Only `restored` says "before nodeterm restarted"
    (`seen 3h ago`, tooltip naming the state it was last seen in). **The first event after a restart
    is usually a SAME-state one** (a cold-restore `--resume` fires SessionStart = `state: undefined`
    on an entry whose state is already unknown), so the store's in-place fast path must not take it:
    it replaces the entry (the row loses `restored` and re-sorts at once) without stamping
    `lastEventAt` (an unknown state is not an idle clock).
  - **Eco never reads it** (so `idleKnown` and `planHibernation` are unchanged). Even a proven-idle
    prompt after boot would not be enough: the background-task stamp and the subagent cards Eco
    also needs are transient and cannot be rebuilt after a restart, and `/exit` kills both
    silently. A session becomes a candidate again from its next live `done`.
  - **Its own key, so the main table's write cadence is unchanged.** State events still write
    nothing to `nodeterm.agentStatus`. That matters twice: the main table carries `loop.items` (up to
    100 × 4000 chars per loop node — 428 KB and ~2.1 ms per stringify with one full loop, measured in
    review), and on the Server Edition every tab rewrites its whole in-memory table, so a periodic
    rewrite would let tab B undo tab A's `clearUnread`/`hibernated` within seconds. A first version
    stored the clock inside that table on a 2 s THROTTLE and rewrote it every 2 s while any agent
    worked. The clock key is saved on a real TRAILING debounce (5 s quiet, `LAST_SEEN_SAVE_MAX_WAIT_MS`
    30 s at most while never quiet) plus `pagehide`: 2 Hz hook events for 10 s = ONE write. Measured:
    ~59 bytes per clock, 1000 clocks = 59 KB and 0.7 ms per `JSON.stringify` on this dev host. Two
    Server Edition tabs still race on the CLOCK key (last writer wins), which costs only display.
  - **Bounded.** At most `LAST_SEEN_MAX` (1000) newest clocks are written; a clock older than 90 days
    or more than 5 min in the future is refused on load (hand-editable input — a future stamp would
    pin a row to the top); an unknown `state` keeps the time and drops the state; an unreadable clock
    key costs the clocks, never the table.
  - **It cannot create a row**: rows come from canvas nodes, never from the status table.
    `remove(id)` writes the clock key at once, a pending debounced save included; a deletion path
    that bypasses `remove` (e.g. `reloadActiveProject` dropping nodes) leaves a clock that simply
    ages out. Tests: `state/agentStatus.lastSeen.test.ts`.
  - Surfaces: Desktop full; Server Edition per browser profile (localStorage, like `unread`); relay
    tabs keep a keyless store and persist nothing; kanban has no clock-ordered view, so nothing to
    wire there; Mobile N/A (its own state).
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
  against a fake host tree — keep it that way.
  **A remote node never falls through to this machine** (2026-09-28): the handler decides
  remoteness from the SHELL's records (`isRemoteNode` dep — live remote pty or
  `workspaceStore.sshProjectIdForNode`, never a renderer flag) and applies `remoteOnly` to the
  paged ⌘M read, the legacy read, the find-bar index (`[]`) and `transcriptExists` (`unknown`).
  The host locate is tri-state (`locateRemoteTranscriptRef`): a CLEAN MISS is `found:false`, a
  failure to ask is `unreadable` ("Couldn't read the transcript.") — the phone's `chat.page` shares
  the same deps and the same distinction. Before this, a mounted SSH node whose locate missed (or
  whose master was down) read THIS machine's resolver, cwd-newest fallback included. `transcriptExists` shares the same locate
  (`remotePresenceFromLocate`: ref/absent/unreadable → present/absent/unknown, a malformed id
  `unknown`), so it also works for a node with no live pty. A remote grok node is read on its host
  by its own leg (`readRemoteGrok`, see the grok chat bullet), with the same absent/unreadable split. (2) **The cwd fallback keeps `accountId`** in BOTH
  `resolveTranscript` and `contextEnsure`; without it a managed-account node fell back to the
  system root and could adopt an unrelated session's newest transcript. (3) **Relay tabs** stay
  local-only (a transcript read over the relay would read the GUEST's disk) and reject with
  `E_UNSUPPORTED`; ChatPanel catches it and says so instead of leaving the initial `[]` on screen
  as an empty conversation. Same `nodeId` rides `claude.readTranscript`, so the find-bar searches
  a remote node's transcript too.
  **Which session id is read is ONE rule, `transcriptSessionFor`** (`renderer/lib/transcriptSession.ts`,
  2026-10): the hook-confirmed `agentStatus.sessionId`, else the id the node was LAUNCHED with
  (`data.agentSessionId` — minted with `--session-id`, or the id "Open recent" resumed). The canvas
  node, the ⌘M hint, the kanban card, the card modal and its viewer all ask it. Before, Chat (and
  the meter) were gated on the hook id alone, so a node whose hook events never reached this app —
  an SSH session pinned for life to a dead hook endpoint, the 107-of-128 case in "A reused
  ControlMaster…" — opened "Markdown view" and showed no meter while its transcript sat on disk
  under an id the node itself had on record; others in the same project opened Chat. The fallback
  is HONEST, because the persisted id can be stale (`/clear` / `/resume` in the CLI moves to
  another session; nothing rewrites `agentSessionId` from hooks): (1) ChatPanel's
  `sessionFallback` prints one quiet line saying so, and the meter's popover says "From the session
  this node was started with"; (2) the read carries **no cwd** (`transcriptReadCwd`), because
  claude's resolver answers a missing id with the newest transcript in the folder — under a
  fallback id that would be a stranger's conversation; the remote locator globs by id without a
  cwd, so SSH nodes are still read on their host; (3) plan/question answer controls are never
  offered on a fallback thread (an answer is a WRITE bound to the live `held` ticket). The composer
  still sends (it types into the pane, which is right whatever the transcript). The persisted id is
  the CREATED agent's, which is exactly the agent both mount sites pick the reader by, and it is
  re-validated against `SAFE_SESSION_ID` (hand-editable project.json). The find bar's transcript
  index still uses the hook id only (it has claude's cwd fallback and no `remoteOnly` here).
  **Both channels live in `core/transcript-ipc.ts` (`registerTranscriptIpc`), so the Server
  Edition serves them too** — it used to have no handler at all, which is why ⌘M in the browser
  read as an empty conversation on EVERY session. The remote leg is an injected dep
  (`readRemote` — `null` = "not a remote session"): `src/main` supplies it, the server passes
  none, which is complete there because it runs ON the host whose transcripts it reads. The
  server registers it in `src/server/index.ts` right after `wireAgentStatus` (which now returns
  its `contextTail`, the hook-fed path authority). The browser's real reader is
  `buildTranscriptApi` in ws-bridge — deliberately NOT folded into `buildClaudeApi`, which the
  relay shares and must not adopt it.
  **System-injected user records are not the user's words** — a `<task-notification>`, a peer
  `<agent-message>`/`<cross-session-message>`, an auto-continuation/coordinator prompt — so
  `parseChatRecords` (and the find-bar index) renders each as ONE assistant tool part
  (`classifySystemRecord`: "Background task" / "Agent message" / "System", no wire change; each is
  a turn boundary in `assistantTurnEnds`) and fences a human paste's `<pasted_content>` span (the
  CLI's own 4-hex-id grammar only; titles keep the raw text) — all `indexOf` scans, never a
  backtracking regex (quadratic on unclosed tags); exact rules in `src/shared/chat-fixtures/README.md`.
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
  page** (its file is rewritten in place, so offsets are no identity): a paged request gets its whole
  capped read with `olderCursor: null`, no keys, and the newest record's `model`/`effort`.
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
  `renderer/lib/chatSendGate.ts`), with ONE exception: `working` for an agent in
  `INPUT_QUEUE_CAPABLE` (claude — measured: a prompt submitted mid-turn waits in Claude Code's own
  queue and reaches the model at the next tool boundary), where Enter QUEUES (`chatSendMode`) and
  the bubble reads "Queued" until the transcript has it. Only a plain prompt queues (`canQueue`):
  a slash command or `!` line mid-turn is unmeasured and waits. While the agent works the textarea
  stays editable for every agent (`composerStandsDown`) — only sending is gated. Never in
  `waiting`/`blocked`:
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
  **The agent's OWN dialogs are read off the screen** (`shared/agents/claude-screen.ts`, claude
  only — `SCREEN_DIALOG_READABLE`). The folder-trust prompt, `/model` and one-time setup questions
  fire NO hook, so the state gate above reads `done` while one owns the keyboard, and a paste into
  it was swallowed while its Enter answered the dialog (the trust prompt's default is "No, exit").
  A send therefore goes through `pty.sendChatPrompt`, where core captures the pane first and
  refuses (`ChatPromptBlocked`, nothing written, the draft kept) when the bottom of the screen is a
  dialog footer or has no input box; an empty or unreadable capture is NOT evidence and sends as
  before. A LOCAL pane is also polled every 2 s while the view is visible, to disable the composer
  and show the dialog's lines; SSH and relay panes are not polled (a round trip per read) and rely
  on the send-time check. Another CLI's layout would read as a permanent dialog, so an agent joins
  the list only with its own measured reader.
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
  **A card answers only the request the THREAD was read for** (`answerCardState`, same rule as
  iOS #41): `threadHeldFor` = the held ticket at the START of the last applied tail read, keyed by
  transcript identity. While held moves A → B (a revised plan) plan A's card can still be on screen
  unanswered, and a tool-name match would approve B from it — so until a read started under B lands,
  the latest unanswered card of that tool says "Updating… — or answer in the terminal" and nothing
  is answerable. A held change forces a tail reload (queued behind a read in flight, which started
  under A and cannot bind B, and behind an older-page fetch, which it never cancels). It is a QUIET
  read (no "Loading…"), and one path owns it: on working → blocked the turn-end reload does. While a
  request is unbound it retries with backoff (`rebindRetryDelay`: 2 s doubling to 30 s, reset per
  request) — card on screen or not; it stops once B surfaces on a new card (a duplicate ticket for the same tool_use keeps a quiet 30 s retry while the agent stays blocked). A read under B that still shows the card A was bound to (same tool id / line offset —
  the transcript can lag the hook) stays "Updating…": B must surface on a card the thread shows as
  new. The answer payload carries the BOUND id, re-checked against store and binding at send time.
  Residuals: the previous-card memory is per MOUNT (a panel opened fresh under B has none, so it
  binds B to the latest matching card); a re-issued ticket for the SAME tool_use (duplicate hooks)
  stays "Updating…" and is answered in the terminal; and the whole guarantee assumes Claude writes
  the tool_use to the transcript before the hook fires.
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
- **The composer completes `/` and `@` (2026-09-30).** Typing `/` at the START of the message (after
  optional whitespace — every CLI measured reads `/x` mid-sentence as text) opens a menu of the
  node's CATALOG; `@` at the start of a word opens the node's files. Arrows move, Enter/Tab ACCEPT,
  Esc closes the menu only (CardModal's capture-phase Esc already stands aside inside
  `.term-chat__compose`). **Accepting only inserts text** (`/name ` / `@path `): nothing is typed into
  the pane, and the send is still the composer's own gated Enter (`chatSendRefusal`) — completing
  `/clear` then pressing Enter is exactly typing it. **Enter accepts only when accepting CHANGES the
  draft**: a fully typed `/model` with the menu still open is a message and Enter sends it (the
  first version swallowed it, and `ChatPanel.live.test.tsx` caught the regression). Pure decisions in
  `renderer/lib/chatComposerComplete.ts`; the wire shape, sanitizer, measured tables and ranking in
  `@shared/chat-catalog`; the builder in `core/chat-catalog.ts` behind `chat:catalog`
  (`registerChatCatalogIpc`, registered by BOTH shells). Rules a refactor must not undo:
  - **Built-ins are only what was MEASURED** (2026-09-30), by typing `/` in each TUI inside a private
    tmux server and paging the whole menu: claude 2.1.285, codex 0.156.1, opencode 1.18.25, gemini
    0.62.0 (throwaway HOME + a dummy API key — the menu is client-side). **grok has no table**: 1.0.44
    would not start past its browser sign-in on the measuring host, and a list copied from docs is a
    guess about the binary the user runs. Plan-, login- and experiment-gated entries are left out.
    Any other agent (grok, copilot, antigravity, a custom agent with no base) gets `@` only; a custom
    agent inherits its base's table through `capabilityAgentId`. The descriptions are our own words.
  - **A built-in that opens a DIALOG in the TUI is `interactive`, and sending one flips to the
    terminal.** `/model`, `/rewind`, `/resume`, `/config`, `/permissions`, … open a picker the ⌘M view
    cannot see while the state still reads `done` — the next message's Enter would ANSWER it (confirm
    the highlighted row), the hazard the toolbar labels already guard. So every built-in is tagged
    `interactive` EXCEPT a per-agent `SAFE` set of measured no-dialog commands (claude
    `clear compact init recap reload-skills security-review`, codex `clear compact init new recap`,
    gemini `clear compress init`, opencode `new`) — unknown means dialog, because over-tagging costs a
    flip and under-tagging costs a wrong answer. `ChatPanel.send` calls `onShowTerminal` after a send
    confirmed `=== true` whose text `isInteractiveBuiltin` (menu-completed OR typed by hand, with or
    without arguments); a composer with no `onShowTerminal` does not offer those entries at all. The
    phone gets the tag in its catalog and owes the same rule.
  - **Custom commands and skills: claude and gemini only**, at the measured locations. claude:
    `<configDir>/commands/**/*.md` + `<cwd>/.claude/commands/**/*.md` (measured: a subfolder is a
    `dir:name` namespace; description = frontmatter `description`, else the first body line; a
    `SKILL.md` inside a commands folder names its FOLDER, `review/SKILL.md` → `review`, per the 2.1.285
    loader) and
    `<configDir>/skills/*/SKILL.md` + `<cwd>/.claude/skills/*/SKILL.md` (measured: the frontmatter
    `name` WINS over the folder name, the folder is the fallback, `user-invocable: false` is not
    offered). `<configDir>` is the bound account's dir (`claudeConfigDirFor`, linked accounts
    included), which REPLACES `~/.claude` — never both, and a malformed account id yields NO user
    root, never the system dir in its place (another identity's commands). gemini:
    `~/.gemini/commands/**/*.toml` + `<cwd>/.gemini/commands/**/*.toml` (its shipped
    custom-commands reference). Precedence project > user > built-in, deduped by name. Other agents'
    custom locations were not measured, so they list none — a guessed location offers commands the
    CLI does not have.
  - **A PROJECT root follows no symlink, at any level** (`CatalogRoot.within`). A cloned repository's
    `.claude/commands/notes.md -> ~/.git-credentials` otherwise put the token-bearing first line in
    the menu and in the phone's catalog (reproduced in review, both legs). Locally entries are
    lstat'ed and files opened `O_NOFOLLOW`; remotely `find -P` and `[ -L ]` on the skill folder and
    its SKILL.md; and the root itself must resolve inside the cwd (realpath / `pwd -P`), so a
    `.claude` linked out of the project lists nothing. USER roots (the person's own config dir) are
    followed — that is how shared system skills reach an account dir.
  - **Names and descriptions are hostile data** (a project's `.claude/commands` is whatever the
    repository holds): a name passes `catalogName` (closed alphabet `[A-Za-z0-9][A-Za-z0-9._:-]*`,
    ≤ 64, never trimmed) or the entry is dropped; a description is one line with C0/C1 and `\p{Cf}`
    (bidi, zero-width) removed, capped at 160 code points. The renderer re-runs
    `sanitizeChatCatalog` on every reply and renders both as text nodes. `@` never offers a path with
    whitespace, a control or format character, or one failing `isSafeQuickOpenRelPath`.
  - **The menu is DERIVED from the draft plus a caret snapshot taken for that exact draft**
    (`caretSnap.value === value`), never kept as its own state. A draft changed outside the textarea
    — ChatPanel clearing it after the async send, dictation, an attach — invalidates the snapshot and
    closes the menu (reproduced in review: send `/compact`, the Enter's keyup re-armed the menu from the
    old text, and Tab then turned the emptied draft back into `/compact `). A disabled composer derives
    nothing. A bare `@` is not a choice: Enter sends `hello @`, Tab still accepts.
  - **Cost: nothing is polled.** A composer asks on its first `/` (or `@`) and reuses the answer for
    `CATALOG_REUSE_MS` (30 s). Core caches every directory listing by the directory's mtime and
    every file head (first 4 KB) by (mtime, size), so an unchanged tree costs stats, no reads. Per
    root at most 200 files, commands 3 levels deep.
  - **`@` is the existing quick-open index**, not a new walker: `files.quickOpen(cwd)` on the
    session's api (this machine, or a relay peer's core) or `sshFs.quickOpen(scope, cwd)` for an SSH
    node — gitignore-aware, capped, traversal-guarded — rooted at the node's cwd, ranked by the
    quick-open fuzzy ranker. The SSH scope is the one the composer's attach already uploads through
    (`nodeUploadScope`), passed as ChatPanel's `sshProjectId` from both mount sites.
  - **An SSH node's catalog is read on its HOST, in ONE round trip** (`remoteCatalogCommand`, run over
    the node's master by the desktop's `runRemote`; tested under a real `/bin/sh` against a fake host
    tree). A remote node whose host cannot be asked — or a shell with no remote leg — answers
    built-ins + `partial`, never this machine's folders. Every file's bytes pass `tr -d '\036'`, so a
    hostile file cannot forge a record boundary. Remoteness is the shell's own record
    (`isRemoteTranscriptNode`), never an argument.
  - **Surfaces.** Desktop full (local + SSH). Server Edition full, local only (real ws-bridge
    `chat.catalog`; it runs on the host it reads). Relay tabs: `chat.catalog` REJECTS (stub) and the
    composer offers the shared built-in table alone; `@` uses the peer's own quick-open index, which
    is the right machine. Kanban card modal: the same ChatPanel/composer. **Mobile**: `chat.status`
    carries the same catalog as an OPTIONAL field when the phone sends `catalog: true`
    (docs/mobile-chat-view.md); an older phone never asks. It is bounded
    (`HOST_CHAT_CATALOG_TIMEOUT_MS`, 4 s, then the status goes out WITHOUT it — `chat.status` is the
    relay's status poll and must never wait on an ssh round trip to a half-dead master), and a client
    asks once per composer open, not on every poll. The Server Edition names an SSH-project node
    remote (`workspaceStore.sshProjectIdForNode`), so it answers built-ins + `partial` there instead of
    reading the server's own `~/.claude`. Adopting it in nodeterm mobile is an iOS
    follow-up.
- **Subagent visualization** (agents in `SUBAGENT_CAPABLE`) — `subagent-start`/`subagent-end`
  normalized events drive a transient `state/agentNodes.ts` store. For Claude they come from
  **Claude's own `SubagentStart`/`SubagentStop` hooks** whenever a session sends them (2026-09,
  see **Claude's native subagent hooks** below); the older reconstruction — `PreToolUse`/
  `PostToolUse` on tool `Agent`/`Task` correlated by `tool_use_id`, whose PostToolUse on an async
  launch is only an ack (`status:'async_launched'`), with the real end sniffed from the
  `<task-notification>` queued into the parent transcript (context tails → synthetic
  `subagent-end` in both shells) — is kept as the FALLBACK and as the source of the task label.
  Neither the notification's `UserPromptSubmit` nor the `[Subagent hand-back]` one is a `newTurn`,
  so neither clears the fan-out. Canvas renders each subagent
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
  live launch event; a running subagent emits no second one) — the card was gone for the rest of
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
  `core/subagent-tail.ts` tails the subagent's own transcript file
  (`<…>/<sessionId>/subagents/agent-<id>.jsonl` — for a native card at the path DERIVED from the
  parent's transcript and the `agent_id`, `claudeSubagentTranscriptPath`; for a tool-path card
  matched by `tool_use_id` via the sibling `.meta.json`), read-only, formats each line (assistant
  text + tool calls + results), and streams chunks over `agent:subagent-activity` into the store.
  **Claude's native subagent hooks** (2026-09; `CLAUDE_HOOK_EVENTS` subscribes `SubagentStart` +
  `SubagentStop` for every installer — local, managed account dirs, SSH host). MEASURED on Claude
  Code **2.1.284** in a throwaway `CLAUDE_CONFIG_DIR` (nine scenarios, print mode and the
  interactive TUI; fixture `src/shared/agents/__fixtures__/claude/subagent-hook-payloads.json`,
  pinned by `normalize.claude.subagent-capture.test.ts`); the published npm bundles date them:
  `SubagentStop` gained `agent_id` + `agent_transcript_path` in **2.0.42**, `SubagentStart` first
  ships in **2.0.43**. Facts a refactor must not lose:
  **(1)** both events carry the PARENT's `session_id` and `transcript_path` (unlike grok, whose
  stop carries the child's), and `agent_id` (`a` + 16 hex, validated as a token by
  `isClaudeAgentId` because it becomes a card key and a file name) is the one id they share. The
  start names the child ONLY by `agent_id` + `agent_type` — no `tool_use_id`, no task text; the
  stop adds `last_assistant_message` + `agent_transcript_path`. **(2)** `SubagentStop` is the end
  of the child's TURN and arrives before the `<task-notification>`, sync or async — but a
  background child that stops while its OWN child still runs is **resumed under the same
  `agent_id`** (a second start, then a second stop): a native stop does not always mean
  "finished". **(3)** Claude fires `SubagentStop` for **internal side-agents** (prompt
  suggestions — after nearly every interactive turn) with `agent_type: ""` and **no start**. **(4)**
  a **killed** child (interrupt) fires **no** stop. **(5)** nested children fire both events
  through the same subscription and connect flat to the owning node; the tool path never saw them
  (their `PreToolUse` carries `agent_id` and is filtered), so native hooks are the first time a
  nested subagent gets a card at all. **(6)** `Stop` (and `SubagentStop`) carry
  `background_tasks` — every running BACKGROUND task of the session (async subagents incl.
  nested ones, background shells), never a foreground subagent; on `SubagentStop` the finishing
  child still lists itself, so only the parent `Stop`'s copy is read (`liveBackgroundTaskIds`,
  closed set of finished statuses, anything else counts as running). Absent through 2.1.112,
  present by 2.1.266 (not bisected — feature-detected per payload). **(7)** in interactive auto
  mode every `PreToolUse(Agent)` of a message fires FIRST, then the children start within 5 ms of
  each other (the permission classifier sits between; 20 ms gap in print mode, up to ~5 s
  interactive), each followed ~1 ms later by its async ack whose `tool_response.agentId` names the
  exact child. **(8)** the child's `SubagentHandback` tool injects `<agent-message from="…">
  [Subagent hand-back] …` into the parent before the task-notification — not a genuine turn
  (`isInjectedSubagentPrompt`, matched on the whole marker).
  **How the two paths coexist** — ONE core module, `core/claude-subagent-lifecycle.ts`, fed every
  normalized event (and the task-notification end) by BOTH shells before any consumer; events it
  does not act on come back as the same object. Latch per node+session on the first native
  start: before it a tool call draws its card immediately (an old CLI, or a session whose hook
  snapshot predates the upgrade, is byte-for-byte the old stream — pinned over the fixtures with
  the native events stripped); after it a tool call is only a pending LABEL and the card appears
  at the child's own `SubagentStart` (so a denied tool call draws nothing). The session's first
  child is drawn from its tool call and then REPLACED by its native card (`supersedes` — the
  renderer store, the host replay and the notch HUD move the card; nothing can know at the tool
  call that a native start is coming). Native cards are keyed by `agent_id`, so start/stop/resume
  follow the CLI exactly; only the label is paired, first-in-first-out by type, corrected exactly
  by the ack (also when the ack overtakes its start — and a call an ack already named is never
  handed to another child), and for a SYNC child by its end (`tool_response.agentId`), which
  takes its call out of the queue and relabels a still-running sibling that guessed it. Every
  turn-end `Stop`/`StopFailure` (never the `idle` rescue — an Agent call may be waiting on a
  permission prompt) clears the queue of calls whose child never started, with or WITHOUT an
  inventory: 2.0.43 had native hooks long before `background_tasks`, and a denied call's label
  must not go to the next child. A native stop for an id that never started is dropped
  (side-agents); a later start of a known id re-opens its card; the parent `Stop` inventory, when
  present, ends a native card it no longer lists (the killed child); a tool card whose child
  never started is ended at the turn end; a replaced tool card also gets a plain end AFTER the
  replacing start (for a consumer too old for `supersedes`); tool-path ends are re-keyed onto the
  native card (idempotent, and they bring the sync stats the native stop lacks — a late
  stats-bearing `finish()` fills them on a done card). Tails: the native start begins the child's tail in the RAW listener, which must run
  BEFORE the `ignoreQuestionHook` child-event gate (it ignores every `agent_id`-tagged payload);
  the lifecycle's `onRelease` ends it (local + remote); a resumed child continues from its
  remembered offset (`subagent-tail` / `remote-subagent-tail`) instead of re-streaming; a remote
  child is tailed at its derived host path with no `.meta.json` ssh polling. **Eco**: because a
  native stop can be a pause (fact 2), the parent `Stop`'s non-empty inventory stamps
  `backgroundTaskAt` (Canvas), the guard Eco and the bulk restart already read — a strictly safer
  rule than before (it also covers a background shell a subagent launched). Both shells pinned by
  `hook-verified-parity.test.ts`; the Server Edition also behaviorally over the fixture
  (`server/agent-status.test.ts`). Cost: one extra managed-hook process + POST per interactive turn
  (the side-agent stop). Residuals, stated: a SYNC child has no ack, so while it runs a reordered
  same-type burst can show a sibling's LABEL (never lifecycle) until the first of them ends; a
  killed child with no later parent `Stop` inventory still waits for the decay. **Device checklist** (not runnable
  here): (a) macOS + Windows canvas, interactive: cards at start, right labels, live activity,
  done at stop, nested card, resumed card re-opens; (b) SSH node: native tail over the
  ControlMaster at the derived path; (c) a session started BEFORE the upgrade (old hook snapshot —
  whether Claude reloads hooks mid-session is unmeasured): no double and no missing cards; (d) Eco
  with a background subagent paused on its own background shell: not hibernated, bulk restart
  skips it; (e) a managed-account node gets native cards (installer writes the account dir); (f)
  Windows: the derived path keeps the reported separator; (g) a pre-2.0.43 CLI tolerates the two
  new keys in settings.json (same class as `StopFailure`, which already shipped); (h) the
  hand-back turn (a background child reporting back wakes the parent for a turn, then the
  `<task-notification>` wakes it again) may chime "finished" twice — #708's quiet rule is per
  turn.
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
- **An SSH host's agent tools are CHECKED, not assumed** (`RemoteHooks.refreshAgentTools`,
  `main/remote-ssh/agent-tools-freshness.ts`). The canvas/context shims, both SKILL.md files and our
  blocks in the codex/gemini/copilot/opencode instruction files used to be written only by the
  establish path, blind, and never looked at again, so a host could keep another build's text for
  a whole run: a fire-and-forget install that failed open was never retried; a tunnel that failed
  verification at connect and was repaired later on the reuse branch (#735, above) never got them
  at all; and a managed account's skill was written ONCE, when the account was added, so after
  every update each remote account session read the verb docs of the build that created the
  account. (The obvious suspect is not one: an app update never lands on the reuse branch. `conns`
  is in memory, so the first connect after a relaunch adopts the ControlPersist orphan on the
  ESTABLISH path, which always wrote. `ssh-project.test.ts` pins that it checks there too.)
  - **The stamp is the bytes.** One generated probe (one round trip, a few hundred bytes back)
    runs POSIX `cksum` over every file the host holds and, for an instruction file, over exactly
    the span `merge*Block` would replace (awk under `LC_ALL=C`: the first start marker through the
    first end marker, only when the end follows the start). That is compared with `posixCksum` of
    the exact bytes this build would write (`core/remote-ssh/posix-cksum.ts`, pinned against the
    real binary), and only what differs is rewritten, through the same appliers as the install. A
    current host costs the probe and no write. Nothing is embedded in the artifacts: a stamp line
    would be noise in every agent's context, would need a migration for hosts written by older
    builds, and would trust a file's claim about itself. `cksum` because it is the one checksum POSIX
    requires; CRC-32 + length is not collision resistant and does not need to be, because this
    detects drift and is not a security check. Ubuntu's own BusyBox build omits `cksum`, so such a
    host exists: missing, unreadable and gated files are still told apart there, the files it can
    read are written without comparison (what every connect did before) and the blocks merged. An
    awk that fails on a block is reported (`X`, through fd 3 — `awk | cksum` exits with cksum's
    status) and that block is merged, which writes only on a change. Only files ACTUALLY written
    are logged as "rewrote" or make the outcome `refreshed`. The permanent suite runs the probe
    under every shell × awk the machine has (what the CI image has); a one-off manual run added
    BusyBox sh, zsh 5.9 and the one-true awk 20231127 (`NT_PROBE_EXTRA_AWK` / `_SH`). macOS's own
    awk (20200816) and BSD `cksum` have never been run — that is on the PR's Mac checklist.
  - **The end marker is searched AFTER the start marker** — in both `merge*Block` functions and in
    the probe's awk alike. Taking the first end marker anywhere read a hand-deleted block's leftover
    end line as "no block": the merge appended a fresh copy every time, and with an hourly check a
    host's AGENTS.md grew by one block an hour (measured in review: 41,693 → 81,279 → 120,865 →
    160,451 bytes). The same merges run at boot for the desktop's and the Server Edition's own local
    instruction files (`initCanvasControl`, `initContextLink`), which grew by one block per launch.
  - **Refusals.** A file that is not a readable regular file (a directory, a dangling dotfile link,
    no permission) is NEVER written over, and the host is not called confirmed. A managed account's
    skill is refreshed only when its dir ALREADY exists — checked by the probe and again on the host
    in the write itself (`remoteAtomicWrite`'s `requireDir`), so a dir removed in between is not
    brought back by the parent `mkdir -p`. A report that does not
    parse changes nothing. Account ids from settings are re-validated (`isSafeAccountId`) before
    they become paths. The copilot block is judged at the host's `$COPILOT_HOME` only when the
    installer's validator would accept that value.
  - **Cadence.** A connect (establish, including the post-relaunch orphan adoption) and a tunnel
    repair always check. The 45 s reuse branch costs nothing once this run has confirmed the host
    for the current expected set (content + account list). An unconfirmed host is retried there on
    the tunnel-repair backoff (1/5/15 min). A confirmed host is looked at again hourly
    (`AGENT_TOOLS_RECHECK_MS`), because within a run only a writer outside it (another desktop,
    possibly an older build, on the same host account; a hand edit) can change the files. One check
    per host at a time: projects sharing a host share it.
  - **A new agent-facing doc on a host goes into the artifact plan in `remote-hooks.ts`**
    (`canvasControlArtifacts` / `contextLinkArtifacts` / `accountSkillArtifacts`) — shims, skills,
    instruction blocks. The installers and the probe both read it, so a file added there is written
    AND kept current. NOT the rest of what connect writes: the hook scripts and the agents' hook
    config belong to `setup()`'s ordered chain (after the verified tunnel and the endpoint file),
    and the endpoint file and node tokens carry credentials — none of those may be rewritten on a
    freshness cadence.
  - **What a running agent sees.** The shim's `help` is answered by the shim itself (baked from the
    verb registry), so it is current the moment the file is. Claude reads a SKILL.md body when the
    skill is invoked; codex, gemini and opencode read their instruction files at session start, so
    a session started before a rewrite keeps the old text until it restarts. Nothing is typed into
    a pane to announce it.
  - Surfaces: Desktop only (SSH projects are a desktop concept). The Server Edition runs ON its host
    and rewrites its local shims at every boot. Mobile: N/A.
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
