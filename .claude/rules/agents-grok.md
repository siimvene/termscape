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
  correlates by `tool_use_id`, codex by `agent_id`; grok has no tool call behind a subagent). Four
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
