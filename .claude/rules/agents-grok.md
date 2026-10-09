---
paths:
  - "src/core/grok-*.ts"
  - "src/core/agents/grok-*.ts"
  - "src/core/agents/hooks/grok.ts"
  - "src/core/usage/grok-usage.ts"
  - "src/renderer/state/grokSessionIds.ts"
  - "src/renderer/lib/grokMark.ts"
  - "src/shared/agents/normalize.grok*.ts"
  - "src/shared/agents/grok-session-mint.ts"
  - "src/main/handoff/render-grok.ts"
  - "docs/grok-agent.md"
---
# Grok agent: capabilities, hook dialect, subagent cards

Grok's per-CLI deep reference. Split out of `agents.md` during the v0.3.7 merge so it loads only
when grok code is touched (agents.md was filling context on every task). General agent-registry
rules stay in `agents.md`; the full device checklist stays in `docs/grok-agent.md`.

**Grok** (`@xai-official/grok` 1.0.0, builtin since 2026-08) — in `AGENT_HOOK_TARGETS`,
`RESUMABLE_AGENTS`, `RENAME_CAPABLE`, `PERMISSION_MODE_CAPABLE`, `CANVAS_CONTROL_CAPABLE`,
`CONTEXT_LINK_CAPABLE`, `CHAT_CAPABLE`, `TRANSFER_SOURCE_CAPABLE`, `USAGE_CAPABLE`,
`SESSION_ID_CAPABLE` and (since 2026-09) `SUBAGENT_CAPABLE`.

- **Hook config is a DIRECTORY** (`$GROK_HOME/hooks/*.json`, all merged), so nodeterm **owns one
  file outright** (`nodeterm-status.json`) instead of merging a shared settings file — which is why
  a malformed copy is *healed*, not preserved, locally and on SSH (`RemoteHooks.installGrokRemote`).
  Dialect: **camelCase keys with snake_case event VALUES** (`{"hookEventName":"pre_tool_use"}`); the
  SDK path flips keys to snake_case, so `normalizeGrok` canonicalizes the event name and reads every
  field twice (shared decoder `grokRawFields`).
- **The tool matcher is a regex `.*`, never `*`** — a bare `*` is invalid and silently stops tool
  events firing (hence `ManagedHookEvent` typing).
- **No `transcript_path`** — the session dir is DERIVED from `cwd` + `sessionId`
  (`core/agents/grok-paths.ts`, the one `$GROK_HOME` rule; `core/usage/grok-usage.ts` delegates to
  it). Name read is `core/grok-session.ts` over `summary.json`, routed per agent by
  `core/agent-session-name.ts`.
- **Reads `~/.claude/skills` and `~/.claude/settings.json` (Claude compat)** — so canvas control
  needed no installer, and every grok event ALSO fires nodeterm's claude hook: an **inert**
  cross-fire (`normalizeClaude` matches neither grok's camelCase keys nor its lowercase event
  values), pinned by tests. Canonicalizing claude's event-name compare would make it harmful.
- **The meter is the BEST case, not the worst** — `signals.json` states `contextTokensUsed`,
  `contextWindowTokens` AND `contextWindowUsage`; all three present and self-consistent in 22 of 22
  measured sessions (an oracle pinned as a test). Context links and the ⌘M panel read
  `chat_history.jsonl` (its own reader; `chat:read-transcript` routes by agent), NOT `updates.jsonl`.
- **Permission mode:** grok's mode flag goes **BEFORE** its `--` separator (end-of-options); the
  `auto` version gate is CLAUDE's alone (fed by a `claude --version` probe).
- **Subagent cards from native `SubagentStart`/`SubagentStop`** (measured grok 1.0.13, two parallel
  `explore` children), keyed by `subagentId` occupying the same `toolUseId` store slot (claude
  by `agent_id` natively, else `tool_use_id`; codex by `agent_id`; grok has no tool call behind a subagent). Four
  facts a refactor must not lose: **(1)** the start's `sessionId` is the PARENT's, the stop's is the
  CHILD's own (= `subagentId`) — keying on `sessionId` files start and stop under different cards and
  the started one never closes; **(2)** the child transcript is DERIVED from `subagentId` as
  `chat_history.jsonl` (`core/grok-subagent-format.ts`) — the start's `transcriptPath` is the
  PARENT's and even the stop names `updates.jsonl`, which parses to nothing; **(3)** a `session_end`
  bearing `subagentType` returns early in BOTH raw listeners, else a finishing child tears down the
  PARENT's session state; **(4)** `description` arrives only on the start. Fixtures live in
  `src/shared/agents/__fixtures__/grok/hook-payloads.json`, pinned by `normalize.grok.capture.test.ts`.
  Remote (SSH) grok nodes get cards but no live tail yet (the child dir is on the host; same gap as
  codex).

<!-- moved-verbatim-from: CLAUDE.md (upstream v0.4.2, Agent support) -->
- **Grok NEEDS YOU is confirmed against grok's own event log** (`core/agents/grok-permission-gate.ts`,
  inside the hook server, so both shells get it from one place). MEASURED on grok 1.0.13
  (2026-09-30, interactive TUI against a local fake chat_completions model, fixture
  `shared/agents/__fixtures__/grok/permission-events.json`): the `permission_prompt` notification is
  genuine (fired 1–20 ms after grok writes `permission_requested` to `<session dir>/events.jsonl`),
  but grok is silent about the ANSWER — approve fires no hook until the approved tool FINISHES (the
  capture's 10 s command read NEEDS YOU for 10 s), a dismissed dialog (Ctrl+C) fires none at all
  (the only later hook is `idle_prompt` 60 s on, which the mirror deliberately never lets clear a
  `blocked` node — a stuck badge until the next prompt), and a rejection fires `permission_denied`
  then cancels the turn with no Stop (RUNNING for 60 s). `events.jsonl` records all three:
  `permission_resolved {decision: allow|deny|cancelled}` and `turn_ended {outcome: cancelled}`. The
  gate ties each notification to ONE `permission_requested` written within 5 s before it and
  publishes what the file says: still pending ⇒ `blocked` + a bounded 1 s watch (a `stat` per tick
  while nothing changes); answered ⇒ `working` (unverified — a file read is not a hook POST — including when the
  answer is already on disk as the hook is read); a
  cancelled turn ⇒ `done` + `interrupted`. **The trap it is shaped around**: a SUBAGENT's prompt
  fires with the PARENT's `sessionId` while its request is in the CHILD's `events.jsonl` — reading
  the parent's file alone would find the parent's older, already-approved request and publish
  "answered" over an open child dialog. Candidates are the sessions this node's hooks named
  (children post their own ids), zero or several matches publish the hook unchanged, and every new
  prompt ends the previous watch (the replay found that exact race: the parent's spawn approval
  landed 90 ms before the child's prompt). The candidate set CAN miss the real request — a child's
  prompt may reach us before any of the child's own hooks, or a second request's line may not be
  on disk yet — and the older request found instead is then already answered. **The load-bearing
  rule is therefore: a request answered BEFORE the notification fired is never taken as its
  answer** (`resolvedTs < notifiedAt` ⇒ the hook is published unchanged, nothing watched): a
  notification cannot be about a dialog that closed before it. Every capture resolves after its
  notification (fastest 216 ms). Review of #1065 found that hole; tests A/B pin it. Closed sets throughout; an unknown decision, unreadable
  file or unparsable timestamp is today's behaviour, never a guess. Per-node ordering is kept (a
  confirm read holds that node's later hooks, ≤ 500 ms; polls run off that chain and discard a read
  that straddled a newer hook). A listener that throws costs that ONE event (as it did inside the
  hook server's try/catch before), never the node's delivery chain. A remote (SSH) grok node's file is on its host, so it reads "cannot
  tell" and behaves exactly as before — a remote leg is a follow-up. Unmeasured: `events.jsonl`'s
  shape on other grok versions (a changed shape degrades to today's behaviour).
- **Grok chat view (⌘M + phone `chat.page`)** — `parseGrokChat` (`core/grok-chat.ts`) reads
  `chat_history.jsonl` into claude's `ChatMessage`/`ChatPart` shapes (no new wire field): typed
  prompts, assistant text, tool calls (`arg` = the salient argument — `command`, `target_file`, …, in
  claude's `toolArg` order — else the raw JSON, 200 units) with results summarised like claude's,
  `web_search` backend calls, harness-injected `synthetic_reason` lines as assistant-side `[reason]`
  notes, and `model_id`/`reasoning_effort` of the NEWEST assistant record (never carried forward).
  `reasoning` is hidden. It does NOT page: measured on 1.0.13, the file is rewritten via
  `.sync.tmp` + rename and `/compact`/`/rewind`/history repair replace lines, so it is one capped
  whole-file read with no keys and no `at`. Routing is by `capabilityAgentId`, so a custom agent built
  on grok reaches grok's reader, never claude's cwd fallback. **A remote (SSH) grok node is read on its
  host** (`core/remote-grok-chat.ts`, one `sh -c` round trip: `$GROK_HOME` if absolute else
  `$HOME/.grok`, the session found by id across `sessions/*/<id>/`, two matches refused, the
  paged-transcript window at 5 MiB) — its failures are terminal, never this machine's disk (the
  hook-derived local map names a wrong-machine path for these nodes). The phone gets it for free:
  `chat.page` reads through the same deps. Golden fixtures + exact rules for the Swift port:
  `src/shared/chat-fixtures/grok/`. Not supported: the composer's model/effort labels (grok's `/model`
  and `/effort` pickers are unmeasured — the TUI needed a login here), plan/question answer cards
  (claude-only), pre-compaction history, and a local session whose map entry `SessionEnd` retired.
