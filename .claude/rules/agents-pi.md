---
paths:
  - "src/core/agents/hooks/pi*.ts"
  - "src/core/agents/hooks/plugin-hook-client.ts"
  - "src/core/pi-*.ts"
  - "src/main/pi-*.ts"
  - "src/main/handoff/render-pi.ts"
  - "src/shared/pi-*.ts"
  - "src/shared/agents/normalize.pi.test.ts"
  - "docs/pi-agent.md"
---
# Pi agent: extension-based status, stated meter, managed accounts

Pi's per-CLI deep reference (`@earendil-works/pi-coding-agent`, builtin since 2026-09). General
agent-registry rules stay in `agents.md`; the full write-up and device checklist are
`docs/pi-agent.md`. Every fact below was MEASURED on pi 0.84.1.

- **Status comes from an EXTENSION nodeterm owns**, not a hook file: pi auto-discovers
  `<agentDir>/extensions/*.js|*.ts` (`agentDir` = `$PI_CODING_AGENT_DIR` or `~/.pi/agent`), and ONLY
  those two extensions — a `.mjs` is silently never loaded (`-e` accepts `.mjs`, discovery does not),
  so `PI_EXTENSION_FILE` is `nodeterm-status.js`. Marker-gated, atomic, env-gated on
  `NODETERM_NODE_ID`. Pi is in `AGENT_HOOK_TARGETS` anyway: `hasHooks` gates the badge itself.
- **One JS hook client** (`plugin-hook-client.ts`) serves pi's extension AND opencode's plugin. Do
  not inline a second copy into either; it has no failover walk (#445), unlike the POSIX script.
- **`agent_start` opens a turn, never `input`**: `input` also fires for slash commands that run no
  agent (`/name`), which would strand the node on RUNNING. `agent_settled` is the one final end;
  its `stopReason` is pi's closed union, only `error`/`aborted` change the verdict.
- **Every extension handler is guarded in the one `on()` wrapper** — a throwing getter on `ctx` once
  escaped into pi (caught by `pi.test.ts`'s hostile-ctx case; the wrapper itself is pinned by the
  hostile-EVENT case, since every `ctx` read is separately wrapped by `call()`). The end events are
  awaited with an unref'd bound, because `/quit` exits right after `session_shutdown`.
- **The meter's numbers are pi's own** (`ctx.getContextUsage()`, percent already 0–100), carried in
  the payload; `core/pi-session.ts` is the ONE tracker both raw listeners build. `percent: null`
  means "unknown", never zero. The node↔session association is set BEFORE the tracker pushes.
  Remote nodes get the meter (payload numbers are machine-agnostic) but not path tracking.
- **The jail admits `sessions/` only** (`<agentDir>/sessions`, `<userData>/pi-accounts/<id>/sessions`):
  `auth.json` (pi's OAuth tokens) sits in the same agent dir.
- **No `--` separator and subcommands share the prompt slot**, matched on argv[0] ONLY → the shared
  assembler puts pi's positional prompt AFTER its flags (`pi --session-id <u> 'update'` is a prompt;
  `pi update ...` is the package command). **`--session-id` is create-or-resume** (no probe), and it
  is ALSO the resume grammar: `--session <id>` exits 1 for a session pi never saved (no assistant
  reply yet), which is exactly the state a cold restore or Restart can be in. Never the bare
  `--resume` picker. Restart exits with bare `/quit`.
- **`PI_CODING_AGENT_DIR` is a reserved project-env key** (`AGENT_CONFIG_DIR_ENV`): user-scope
  `<agentDir>/extensions/*.js` load with NO trust gate (only `<cwd>/.pi/extensions` is gated) and
  `auth.json` sits beside them, so a git-shared value is repo code in the agent process plus a
  relocated credential. It is also the managed-account env, which the project merge would override.
- **Managed Pi accounts are config-dir isolation** (`<userData>/pi-accounts/<id>` as
  `PI_CODING_AGENT_DIR`), which rides `ACCOUNT_SCOPE_UPDATE_ENV` (#419). Pi does NOT reuse Claude or
  Codex logins: importing another CLI's refresh token would rotate it out from under that CLI. An
  Anthropic Pro/Max login in Pi is billed as third-party extra usage, not plan limits — say so in UI
  copy, never imply otherwise.
- **Out on purpose**: `PERMISSION_MODE_CAPABLE` (pi has no approval modes; joining would make
  `approval-mode.ts` fall back to claude's `--permission-mode`), `RENAME_CAPABLE`, `MODEL_SWITCH_CAPABLE`
  (pi's own `/model`), `SUBAGENT_CAPABLE`, `CHAT_CAPABLE`.
- **Tests that run the real binary**: `hooks/pi.e2e.test.ts` (skips without `pi` on PATH) starts an
  interactive pi under `script` in a fresh agent dir, types `/quit`, and asserts the auto-discovered
  extension posted start + shutdown — and that the same run outside a nodeterm session posts nothing.
  `script` needs a real PIPE on stdin (node's `stdio:'pipe'` is a socketpair on macOS → "tcgetattr:
  Operation not supported on socket"), hence the `sh` pipeline.
