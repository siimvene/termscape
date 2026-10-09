---
paths:
  - "src/core/agents/hooks/antigravity*.ts"
  - "src/shared/agents/normalize.antigravity*.ts"
  - "src/shared/agents/__fixtures__/antigravity/**"
  - "src/renderer/lib/antigravityTurn*.ts"
  - "scripts/agy-transcript-shape*"
  - "docs/antigravity-agent.md"
---
# Antigravity agent (`agy`): capabilities, resume, launch, hooks, transcript

> Folded from upstream's single `CLAUDE.md` at the v0.4.2 merge (2026-10-09), text verbatim (the
> Antigravity bullet of upstream's Agent support section; `agents.md` keeps a pointer here, like Grok
> and Pi). Loads automatically when a file matching the `paths` above is read.
<!-- moved-verbatim-from: CLAUDE.md (upstream v0.4.2, Agent support) -->

- **Antigravity** (`agy` 1.2.3 measured on Windows; the 1.2.12 Linux binary read; builtin since
  2026-09 — Google's replacement for Gemini CLI on personal accounts) — in `AGENT_HOOK_TARGETS`
  (badge, NEEDS YOU from `ask_question`, a closed set of one, `--after` and triggers) and
  `RESUMABLE_AGENTS` (`agy --conversation=<id>`, the spelling agy's own exit hint uses; a dead id
  is ignored by agy, which starts fresh — without it a reboot left a bare shell). Launch is
  `agy --prompt-interactive '<p>'` via the new optional `AgentConfig.promptFlag` (agy has no
  positional prompt). Its hooks live in the GLOBAL `~/.gemini/config/hooks.json` under our own
  `nodeterm-status` bundle, and **each one is a synchronous gate whose stdout agy reads as a
  decision** — we subscribe `PreToolUse`, so a wrong byte denies tools in every `agy` on the
  machine, inside nodeterm and outside it. Three rules for whoever touches it:
  - **The stdout table is written ONCE** (`core/agents/hooks/antigravity-decision.ts`): `PreToolUse`
    → `{"decision":"ask"}`, `Stop` → `{"decision":""}`, the rest → `{}`, an unknown/empty event →
    NOTHING. Measured on 1.2.3: silence runs the tool, while `{}`, `{"decision":""}`, any non-JSON
    byte and exit ≠ 0 DENY it. Never `allow`, never `force_ask`, never `"continue"` on `Stop`. The
    script answers first and then sends stdout/stderr to `/dev/null`, because hook stdout is also
    model input (`injectSteps`).
  - **No quotes in the Windows command.** agy passes it to `cmd /c` with inner `"` escaped as `\"`,
    which cmd.exe does not understand — the codex form (`cmd.exe /d /c call "…"`) exits 1 = DENY.
    The command is relative to the hooks.json directory (agy's hook cwd) and guarded:
    `if exist ..\..\.nodeterm\agent-hooks\antigravity-hook.cmd (call … <Event>) & exit 0`. Test
    Windows dispatch WITHOUT `windowsVerbatimArguments` — Node's default escaping is agy's.
  - **AutoRun blocks the install.** agy's `cmd /c` has no `/d`, so a registry `AutoRun` runs first
    and its output would deny tools; the installer reads the three `Command Processor\AutoRun`
    values (`reg query`, absence decided by listing the parent key — reg's errors are localized)
    and installs NOTHING — and withdraws a bundle an earlier launch wrote — if one is set or the
    registry cannot be read.
  **The vendor-location fallback also owns launch reachability.** Measured on Windows 11 with agy
  1.2.7: the vendor installer wrote `%LOCALAPPDATA%\agy\bin` into the user PATH as `REG_SZ`, so the
  process inherited the percent expression literally and both `where agy` and `cmd /c agy` failed
  while `%LOCALAPPDATA%\agy\bin\agy.exe` existed and ran. `PtyManager` therefore APPENDS the
  directory returned by `findAgy()` to the PATH of a LOCAL Antigravity session, and only when no
  entry already names it (`pathWithAgyDir`) — prepending shadowed the user's own tools on
  macOS/Linux, where agy sits in a shared directory. The gate uses
  `capabilityAgentId`, so an Antigravity-based custom agent inherits it; plain terminals and SSH
  sessions do not. Detecting the binary only for hook installation recreates the original split:
  a configured badge for an agent the pane cannot launch.
  **Installed only where `agy` exists** (a file lookup — PATH, then the vendor's install dirs —
  never a spawn), in two passes per launch: the boot pass may only see the inherited PATH, so a miss
  there does NOTHING; after the login-shell PATH probe settles, a final pass repeats the lookup and
  only then withdraws a bundle of ours when agy is not found. An `agy` installed later gets the
  hook the next time nodeterm opens. **The opt-out is agy's own switch**: `"enabled": false` on our
  bundle is carried across every rewrite. hooks.json goes through the shared settings transaction
  (`updateSettingsFile`: a symlinked file keeps its link and mode, writers serialize, a file changed
  mid-update is not overwritten), and only entries under `.nodeterm/agent-hooks/` are swept as
  ours. The POSIX command forces exit 0 (`sh <script> || :`) — the answer is printed first, and a
  later failure (a broken endpoint file) must not turn into a non-zero status next to it. **No SSH
  hook installer yet** (`LOCAL_ONLY_HOOK_AGENTS` / `hasHooksOverSsh`): on an SSH project an agy node
  never reports, so `--after` refuses it as a dependency. The event name is not in agy's payloads:
  the command exports `NODETERM_AGY_EVENT`, the script POSTs `nodeterm_hook_event`, and the hook
  server merges it after `JSON.parse` — for antigravity ONLY, an empty field deleting a planted
  value. `newTurn` rides only the
  `PreInvocation` with `invocationNum === 0` (without it `lastTurnError` is never retired). Cost:
  on POSIX the POST already runs in the background and the part agy waits for measured 2–40 ms
  (pinned by a stalled-endpoint test, since a foreground POST plus the failover walk measured ~6 s
  against the 5 s handler timeout); the ~520 ms per event measured on Windows is Git Bash's fork
  cost before the backgrounding. Full picture,
  limits (permission prompt and ESC fire no hook) and the device checklist:
  **`docs/antigravity-agent.md`**.
  **No conversation view, and that is deliberate** (not in `CHAT_CAPABLE`): ⌘M shows the rendered
  terminal output, and the phone's Chat screen answers `unsupported`. The
  LOCATION is measured: every hook payload names `transcriptPath`, which is
  `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`,
  keyed by the id `normalizeAntigravity` already records as `sessionId`. The RECORD SHAPES were never
  captured; the 1.2.12 binary only describes them in prose. Four facts a parser needs are unknown:
  the `tool_calls` element keys, how a tool result links back to its call, the serialized enum
  spelling, and whether a line is rewritten when its step's status changes, which decides between
  claude's paged read and grok's single capped read. A parser built from that prose would be a rule-14
  wrong guess, so none ships, not even unwired. The capture recipe is §7.1 and §8.1 of the doc, using
  `scripts/agy-transcript-shape.mjs`, which dumps shapes and never text. When it lands: locate
  strictly by id (`brain/` holds every conversation on the machine), and have a remote node answer
  `remoteOnly` → unreadable like gemini.
