# Pi agent

Pi (`@earendil-works/pi-coding-agent`, `badlogic/pi-mono`) is a builtin agent: a minimal,
multi-provider coding-agent TUI. This file is the deep reference: what was measured, how the
integration works, and what still needs a device. The distilled per-CLI rules live in
`.claude/rules/agents-pi.md`; the general rules in `.claude/rules/agents.md` ("Adding a new agent").

Every claim marked **MEASURED** was checked against pi **0.84.1** on macOS (2026-09-22/26), with a
probe extension and the real binary under a pty. Items marked **[DEVICE]** are in the checklist (§8).

## 1. Why Pi, and what "all subscriptions" means

Pi's harness is small (short system prompt, no MCP, no built-in subagents), which is why the same
model is reported faster and cheaper through it than through the vendor CLIs. Its value here is one
harness for many providers. Which subscriptions it can actually use, and how they are billed:

| Provider in Pi | Login | Billing |
|---|---|---|
| ChatGPT Plus/Pro (`openai-codex`) | `/login`, OAuth or device code | the ChatGPT plan ("Codex for OSS", endorsed) |
| Anthropic Claude Pro/Max (`anthropic`) | `/login`, OAuth | **not the plan**: third-party harness usage bills per token as Anthropic extra usage (since 2026-04-04; Agent SDK credit from 2026-05-13, then extra usage). Pi's own `docs/providers.md` says so, and Pi issue earendil-works/pi#3670 reports it on a real account. Pi logs in with Claude Code's own OAuth client id and sends Claude Code identity headers ("stealth mode", `pi-ai/dist/api/anthropic-messages.js`); that does not change the billing. |
| GitHub Copilot, xAI, OpenRouter, Kimi | `/login` | the respective subscription |
| Vertex / Gemini, any API key, a model gateway | env / `models.json` | the key's account |

So the integration does NOT reuse Termscape's Claude or Codex logins. Pi authenticates into its OWN
store (`<agentDir>/auth.json`), and importing another CLI's refresh token would rotate it out from
under that CLI. A subscription becomes available to Pi by logging it into a **managed Pi account**
(§4) with Pi's own `/login`. (Decision: Siim, 2026-09-22.)

## 2. Status: an extension, not a hook file

Pi has no hook-file mechanism. Its seam is the extension API: a module whose default export gets
`pi` and subscribes with `pi.on(event, handler)`. Pi **auto-discovers** user extensions in
`<agentDir>/extensions/` (MEASURED: `*.js` and `*.ts` only; the same module as `.mjs` is never
loaded, while `-e <path>` accepts `.mjs`, which is what made that easy to miss). `agentDir` is
`$PI_CODING_AGENT_DIR` or `~/.pi/agent`.

So nodeterm owns one file, `<agentDir>/extensions/nodeterm-status.js` (`core/agents/hooks/pi.ts`),
marker-gated (a user's own file of that name is never touched), published atomically, and
env-gated: outside a nodeterm-spawned session (no `NODETERM_NODE_ID`) it subscribes to nothing.
Pi joins `AGENT_HOOK_TARGETS` like opencode (also plugin-based), because `hasHooks` gates the status
badge itself. Its wire client is the one shared JS client (`hooks/plugin-hook-client.ts`, also
opencode's): endpoint file re-read per POST, per-node token, unix socket before TCP. Known gap shared
with opencode: no cross-endpoint failover walk (#445).

MEASURED event order (tool-using `-p` run): `session_start → input → before_agent_start →
agent_start → turn_start → message_start/end → context → tool_execution_start → tool_call →
tool_result → tool_execution_end → … → turn_end → agent_end → agent_settled → session_shutdown`.
In a live TUI, typing `/quit` fires `session_shutdown` and exits.

Every handler's `ctx` carries `cwd`, `sessionManager.getSessionId()` / `getSessionFile()` and
`getContextUsage()` → `{ tokens, contextWindow, percent }` (percent already 0–100: 1244 of 272000
tokens reported 0.457). The extension forwards a small envelope per event; `normalizePi`
(`shared/agents/normalize.ts`) maps it:

| Extension event | Normalized |
|---|---|
| `session_start` | session start |
| `agent_start` | `working` + `newTurn` (`input` is not used: it also fires for `/name`, which runs no agent) |
| `tool_execution_start` | `working` |
| `agent_settled` (+ last assistant `stopReason`, text) | `done`; `error` → `errored`, `aborted` → `interrupted` (pi's closed `StopReason` union; anything else is a clean done) |
| `session_info_changed` | session title |
| `session_shutdown` | session end (so a killed Pi CLI is detectable: `SESSION_END_CAPABLE`) |
| `turn_end` | nothing (it carries fresh context usage for the meter) |

`agent_settled` and `session_shutdown` are awaited (bounded, unref'd timer): `/quit` exits right
after the shutdown event. Every handler is guarded in one wrapper, so a status report can never
throw into pi's agent loop. There is no `blocked` state: pi has no permission prompts.

## 3. Meter, title, transcripts

- **Context meter**: the payload STATES the usage, so there is no transcript tail and no inferred
  window (`core/pi-session.ts`: `piContextUsage` + a change-gated tracker both shells build). Pi
  reports `percent: null` before it knows the token count; that is "no number", never zero. A remote
  node still gets its meter (the numbers ride the payload). Not rehydrated after an app restart
  (like grok): the numbers arrive with the next event.
- **Transcript**: `<agentDir>/sessions/<encoded cwd>/<ISO timestamp>_<sessionId>.jsonl`. The jail
  (`isSafeLocalTranscriptPath`) admits `<agentDir>/sessions/**` and managed
  `<userData>/pi-accounts/<id>/sessions/**` only; `auth.json` sits beside them and stays out.
- **Title**: the latest `session_info` record's `name` (set by `/name` or `--name`); read strictly by
  session id through the path the hooks reported. Pi does not name sessions on its own, so an
  unnamed session keeps the node's own title. No rename write leg (`RENAME_CAPABLE` out).
- Context link and transfer render the same JSONL (user / assistant text / tool calls / results).

## 4. Managed Pi accounts

Isolation is config-dir, exactly like managed Claude accounts: an account is
`<userData>/pi-accounts/<id>`, used as `PI_CODING_AGENT_DIR` for that node (spawn env and tmux
`-e`; `PI_CODING_AGENT_DIR` rides `ACCOUNT_SCOPE_UPDATE_ENV` so a shared tmux server never leaks one
account's dir into another session, #419). MEASURED: a fresh dir answers
`pi auth check --provider openai-codex --json` with `not_ready / credentials_not_configured` while a
logged-in one answers `ready / oauth`. Pi owns login, storage and refresh inside the dir; nodeterm
never writes credentials. Add → a pending row + a login node running `pi` in that dir (type `/login`);
logged in = `auth.json` holds at least one provider. The status extension is installed into every
account dir. Remote (SSH) Pi accounts are out of scope for v1: a Pi node on an SSH project runs the
host's system Pi.

## 5. Launch, resume, restart

- Initial prompt is typed after the TUI starts (`stdin-after-start`). MEASURED: the prompt is a
  positional sharing its slot with subcommands (`install/remove/update/list/config/auth`), and pi has
  no `--` separator (`pi -- list` → "Unknown option: --"), so a one-word prompt would run a command.
- Session ids are minted at first launch with `--session-id <id>`. MEASURED: create-OR-resume (a
  second launch with the same id continued the conversation), so no probe is needed.
- Resume is `pi --session <id>`; the bare `--resume` is an interactive picker and is never used.
- In-place restart types `/quit` (no argument form, unlike gemini's `/quit --delete`).
- The pane-owner predicate names `pi`: the running process rewrites its title (comm and argv `pi`).
- Out on purpose: permission modes (pi has none; joining `PERMISSION_MODE_CAPABLE` would make
  `approval-mode.ts` fall back to claude's flag), model switch (pi's own `/model` / Ctrl+L picks the
  provider and model), subagents, recurring, branch, the ⌘M chat panel.

## 6. Surfaces

- **Desktop**: full.
- **Server Edition**: status, meter, readers and accounts through the same core services (both raw
  listeners carry the same Pi branch).
- **SSH hosts**: the extension is installed on the host; meter and status work; transcript readers
  and managed accounts are local-only for v1.
- **Mobile**: the phone sees Pi nodes through the status mirror (`agentId: 'pi'`); launching Pi from
  the phone needs the iOS client to know the id (docs/mobile-client-spec.md).

## 7. Files

`shared/agents/config.ts` (registry), `shared/agents/normalize.ts` (`normalizePi`),
`core/agents/hooks/pi.ts` + `plugin-hook-client.ts` (extension + installer), `core/pi-session.ts`
(meter, tracker, readers), `core/claude-accounts-core.ts` (jail), `src/main/index.ts` +
`src/server/agent-status.ts` (raw listeners), `core/pi-accounts-*.ts` (accounts).

## 8. Device checklist

1. A Pi node on the canvas: RUNNING while a turn works, back to waiting at the end, the meter
   filling from pi's own numbers, `/name x` renaming the node.
2. Esc during a turn → `interrupted` (the aborted stopReason); a failing provider → an errored turn.
3. Kill the pi process (`kill -9`) → the dropped-CLI chip; `/quit` → no chip.
4. Add a Pi account, `/login` to ChatGPT in the login node, open a Pi node on it, confirm
   `PI_CODING_AGENT_DIR` in its env and that a second account's node does not see the first's login.
5. Restart the app with Pi nodes running: cold restore resumes the same conversation (`--session`).
6. An SSH-project Pi node: status + meter arrive over the tunnel.
7. Server Edition in the browser: same as 1.
