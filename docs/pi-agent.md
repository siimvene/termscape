# Pi agent integration (design + device checklist)

> Pi = the Pi coding agent (`@earendil-works/pi-coding-agent`, `badlogic/pi-mono`), a
> multi-provider headless/TUI CLI. Added as a builtin harness alongside claude / codex /
> gemini / opencode / grok / copilot. This file is the deep reference; the distilled rules
> are in `.claude/rules/agents.md` ("Adding a new agent") and the account rules in
> `.claude/rules/agents-accounts-usage.md`.

Every claim marked **[MEASURED]** was verified against `pi` **0.84.1** on macOS on 2026-09-22;
every **[VERIFY]** is a device-checklist item a build station must confirm before shipping the
capability it gates (per `agents.md` rule 16 — a guess must degrade to nothing, never to
something wrong).

## Why Pi is different from the other builtins

The other six agents report status by installing a **hook file** into their config
(`~/.claude/settings.json`, `~/.codex/hooks.json`, `$GROK_HOME/hooks/*.json`, …) that fires a
POSIX script POSTing to the loopback hook server. **Pi has no hook-file mechanism.** It has a
typed **extension API** (`export default (pi) => pi.on(event, handler)`, the same shape as
consort's `pi-fence.mjs`), loaded with `-e <path>` on the launch line (explicit `-e` survives
`--no-extensions`). So Pi is **not** in `AGENT_HOOK_TARGETS`; its status source is a nodeterm-owned
extension (`pi-status.mjs`) that subscribes to Pi's lifecycle events and POSTs to the SAME loopback
hook server the hook scripts use. This is the one genuinely new mechanism in the integration.

## Managed Pi accounts — the subscription-reuse decision

"All existing authenticated subscriptions available via Pi" is realized as **managed Pi accounts**,
mirroring managed Claude/Codex accounts exactly:

- Isolation is **config-dir**, via `PI_CODING_AGENT_DIR` (Pi's own env; `config.js` `CONFIG_DIR_NAME`
  → `.pi`, agent dir `~/.pi/agent/`). **[MEASURED]** a fresh `PI_CODING_AGENT_DIR` reports
  `pi auth check --provider openai-codex --json` → `{"status":"not_ready",...}` while the real home
  reports `{"status":"ready","authType":"oauth"}`. The **Pi CLI owns login and credential storage**
  inside that dir (`~/.pi/agent/auth.json`, 0600) — nodeterm NEVER writes credentials, same
  contract as Claude/Codex.
- A subscription is made available by **logging it into a Pi account via Pi's own `/login`**
  (interactive), one account per identity. Vertex/Gemini and any model-gateway key need no login
  (env / `models.json`).
- **NOT** done: importing the existing Codex/Claude OAuth token into Pi to skip re-login. Pi's
  openai-codex leg uses the same OAuth client id as the Codex CLI and its refresh-token rotation can
  **invalidate the source Codex/Claude login** the consort gate + Claude Code depend on. The safe
  path is a real `pi /login` into the isolated account dir. (Decision: Siim, 2026-09-22.)
- **Billing caveat to surface in the UI:** an **Anthropic Pro/Max** subscription logged into Pi
  works, but its usage does **not** draw from plan limits. Evidence (2026-09-22):
  - Pi DOES ship Claude Pro/Max OAuth (`pi-ai/dist/auth/oauth/anthropic.js`), under **Claude
    Code's own client_id** (`9d1c250a-…`, base64-obfuscated in the source) with scope
    `user:sessions:claude_code`, plus a "stealth mode" in `pi-ai/dist/api/anthropic-messages.js`:
    `user-agent: claude-cli/2.1.75`, `x-app: cli`, `anthropic-beta: claude-code-20250219,oauth-…`,
    a "You are Claude Code…" system-prompt prefix and Claude Code tool-name casing.
  - It is still billed as third-party usage: Pi's own `docs/providers.md` ("Third-party harness
    usage draws from extra usage and is billed per token, not against Claude plan limits"), and
    Pi issue earendil-works/pi#3670 (2026-04-24) reports exactly that on a real account. Anthropic's
    policy: from 2026-04-04 subscription tokens outside Claude Code / claude.ai bill per token; from
    2026-05-13 a separate monthly Agent SDK credit ($20 Pro / $100 Max 5x / $200 Max 20x) covers
    programmatic use, then extra usage. How Anthropic detects it is not public; do not claim a
    mechanism. Which pool a Pi session lands in (Agent SDK credit vs extra usage) is **[VERIFY]**
    on a live account.
  - The ChatGPT/Codex sub via Pi's `openai-codex` provider is plan-covered.

## Status: the pi-status extension → 4-state model

**[MEASURED]** event order from a real authed `-p` run (`--provider openai-codex`), probe extension
subscribing to every candidate name:

```
session_start  agent_start  turn_start  message_start  message_end  context
  message_start  message_update×3  message_end  turn_end  agent_end  agent_settled
```

Mapping onto `AgentState` (`working | waiting | blocked | done`) in `normalizePi`
(`src/shared/agents/normalize.ts`):

| Pi event | Normalized |
|---|---|
| `agent_start` / `turn_start` / `message_start` / `tool_execution_start` | `working` |
| `project_trust` (awaiting decision) / `extension_ui_request` (approval dialog) | `blocked` **[VERIFY]** — needs an interactive run to confirm these fire on a real permission prompt |
| `agent_settled` | `done` (turn ended, ready for next user prompt — a single unambiguous settle signal, unlike claude's Stop) |
| `session_start` | carries the session id (also `--session-id` mints one) |
| `session_info_changed` | title read (→ `TITLE_READ_CAPABLE`) |

The extension POSTs `{nodeId, state, sessionId, …}` to the loopback hook server using the same
env (`buildPtyEnv` injects endpoint + per-node token) and the same `nt_read_node_token` /
endpoint-failover resolvers the hook scripts use. Both raw listeners
(`src/main/index.ts`, `src/server/agent-status.ts`) gain the Pi branch **together** (agents.md
rule 11).

## Context meter

**[MEASURED]** Pi emits a `context` event carrying `ContextUsage { tokens, contextWindow,
percentage }` (`core/extensions/index.d.ts`: `contextWindow: number`, `percentage: number | null`).
Pi **states its own window and percentage** — the best case (like grok), so `USAGE_CAPABLE`
membership reads the stated numbers, never an inferred denominator. `message_end` also carries
`provider/model/usage{input,output,cacheRead,cacheWrite,cost}` for attestation.

## Capability-list mapping (`src/shared/agents/config.ts`)

| List | Pi? | Leaf to write |
|---|---|---|
| `AGENT_CONFIG` | ✓ | `{label:'Pi', color:'#d4009a', launchCmd:'pi', promptInjectionMode: [VERIFY], expectedProcess:'pi'}` |
| `AGENT_HOOK_TARGETS` | ✗ | Pi is extension-based, not hook-file — its own status installer instead |
| `RESUMABLE_AGENTS` | ✓ | `--resume` / `--session <id>` / `--continue` grammar (`resumeCommandWith`) |
| `SESSION_ID_CAPABLE` | ✓ **[VERIFY]** | `--session-id <id>` ("creating it if missing"); confirm it refuses a dup like claude |
| `USAGE_CAPABLE` | ✓ | read `context` event's stated tokens+window |
| `CONTEXT_LINK_CAPABLE` | ✓ | reads `~/.claude/skills`? **[VERIFY]** — else a marker block like codex/gemini |
| `CANVAS_CONTROL_CAPABLE` | ✓ | same discovery as Context Link |
| `PERMISSION_MODE_CAPABLE` | ✓ **[VERIFY]** | map to `--approve/--no-approve` + trust; no direct claude-mode vocabulary — emit no flag for modes Pi can't express (agents.md rule 8) |
| `TITLE_READ_CAPABLE` | ✓ | `session_info_changed` / session name |
| `RENAME_CAPABLE` | ✗ **[VERIFY]** | no measured rename command (`-n/--name` is launch-only) |
| `CHAT_CAPABLE` / `CLAUDE_TRANSCRIPT_READABLE` | ✗ | Pi transcripts are its own JSON under `~/.pi/agent/sessions`, not claude-shaped — never join `CLAUDE_TRANSCRIPT_READABLE` |
| `TRANSFER_SOURCE_CAPABLE` | ✓ **[VERIFY]** | render Pi's session transcript |
| `MODEL_SWITCH_CAPABLE` | ✓ | `--provider`/`--model`; gateway via custom provider in `models.json` (`shared/agents/model-gateway.ts`) |
| `SUBAGENT_CAPABLE` | ✗ **[VERIFY]** | no measured subagent-spawn events yet — defer |
| `SHARED_IDENTITY_CAPABLE` | ✗ | one process per node |

Managed accounts: Pi joins the **claude/codex** account machinery as a THIRD provider —
`account-binding.ts` `boundAccountId`, `account-color.ts`, `inheritableAccountId`, a
`pi-accounts-service.ts` (mirror of `claude-accounts-service.ts`: add / wait-login / cancel /
remove, `SettingsStore.mutate` row ownership, both shells), and `settings.piAccounts`.

## Device checklist (build-phase [VERIFY] items)

1. `promptInjectionMode` for the initial prompt: Pi has subcommands (`install/remove/update/list/
   config/auth`) that can shadow a one-word positional prompt (the grok trap). Measure `pi "<word>"`
   vs a separator vs stdin-after-start before choosing; degrade to bare launch (no initial prompt)
   if unsure.
2. `project_trust` / `extension_ui_request` fire on a real interactive permission prompt (the
   `blocked` state).
3. `--session-id` dup behaviour (mint-once vs resume) — mirror `withSessionId`'s first-launch-only rule.
4. Whether Pi reads `~/.claude/skills` for canvas-control discovery (grok does) or needs its own
   marker/skill install.
5. Permission/approval vocabulary → the `approval-mode.ts` mapping; emit no flag for an
   inexpressible mode.
6. Rename command existence (keep Pi out of `RENAME_CAPABLE` until measured).
7. Subagent-spawn events (keep out of `SUBAGENT_CAPABLE` until measured).
8. `PI_CODING_AGENT_DIR` also relocates `sessions/` + `extensions/` (so a managed account's
   transcripts and the status extension live in the account dir) — confirm and jail transcript
   reads per-root, never `$HOME` (agents.md rule 12).
