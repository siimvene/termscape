# CLAUDE.md

This is the deep-reference for working in this repo: the invariants, why each exists, and the
measurements behind them. It is loaded automatically by Claude Code.

**Contributors: start with `CONTRIBUTING.md`** — the short version (setup, boundaries, house rules,
testing habits). This file is what you reach for when you need to know *why* a rule is the way it
is, or you are changing a subsystem it describes. A change that other developers must know about
belongs in BOTH (see Conventions).

**PR text (title, description, comments, review responses) follows the `pr-writing` skill**: what
changed and why it matters, then how it was checked and what was not, then risks or follow-up when
there are any. Structure proportional to the change. `CONTRIBUTING.md` § Pull requests is the
human-facing half of the same rule.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## How this documentation is organized (read this first)

The deep reference used to be ONE 231 KB file loaded into every session (~58k tokens before a
single line of code was read). On 2026-09-01 it was split, **verbatim, nothing deleted**, into this
root plus path-scoped rule files under `.claude/rules/`. The mechanism is Claude Code's memory
system: a rule file with a `paths:` frontmatter list is loaded automatically **when a file matching
one of its globs is read**, not at session start. So every session starts lean, and the subsystem
invariants arrive exactly when their code is touched.

What stays in this root is what applies to EVERY change: what the product is, the rename policy,
the platform tiers, the commands, the process-model boundaries, the transport abstraction, atomic
writes, and the conventions. Everything subsystem-specific lives in a rule file.

**Routing table.** The globs are a heuristic, so use this table proactively: before planning work
on a subsystem, or when a bug report names one, `Read` its rule file even if no matching source
file has been opened yet. A rule you did not load is an invariant you will violate.

| Rule file | Covers |
|---|---|
| `.claude/rules/persistence.md` | State & persistence (workspace files, project.json, SSH mirror, triggers) |
| `.claude/rules/projects.md` | Projects (tabs): switch, close/park, reopen, delete, open-folder recovery |
| `.claude/rules/terminal.md` | Terminal sessions: tmux continuity, PTY lifecycle, cold restore, Zellij backend, xterm seeding, TerminalNode |
| `.claude/rules/nodes.md` | Node kinds (incl. trigger), node icons, group frames, editor/diff/video/web/browser nodes, resize hit-area, webview keep-alive |
| `.claude/rules/agents.md` | Agent support: registry + capabilities, hooks, permission mode, transcripts, subagent/workflow viz, adding a new agent |
| `.claude/rules/agents-canvas-control.md` | Canvas control (nodeterm.sh shim, verbs, fan-in, --after, verify panel), Context Link, agent messaging (scope publication, Windows delivery) |
| `.claude/rules/agents-accounts-usage.md` | Managed Claude/Codex accounts, account switch, usage indicator scope, remote usage |
| `.claude/rules/agents-grok.md` | Grok agent per-CLI deep reference: capabilities, hook-directory dialect, subagent-card keying, NEEDS YOU event-log check, chat view |
| `.claude/rules/agents-antigravity.md` | Antigravity (`agy`) agent per-CLI deep reference: capabilities, resume, launch, Windows hook dispatch |
| `.claude/rules/agents-codex.md` | Codex shared-thread node identity: tool-shell recovery, the exported HMAC record |
| `.claude/rules/agents-pi.md` | Pi agent: extension-based status, stated context meter, managed Pi accounts |
| `.claude/rules/open-recent.md` | Open recent: resume a past agent conversation from its CLI history |
| `.claude/rules/orchestration-state.md` | Durable orchestration state: delivery queue, station reports, hand-over holds, control request ledger |
| `.claude/rules/session-memory.md` | Session memory: the RAM pill, the per-session panel, socket fan-out kills |
| `.claude/rules/keybindings.md` | Keybindings (registry, overrides, dispatch) and window chrome / menu stand-down |
| `.claude/rules/canvas.md` | Canvas interaction & panels: menus, undo, zoom, goToNode, breadcrumbs, palette, sidebar, explorer, settings, theme |
| `.claude/rules/source-control-worktrees.md` | Source Control panel, AI commit messages, git worktrees bound to group frames |
| `.claude/rules/kanban.md` | Kanban view: dual-source board, card modal, board log, labels, metadata |
| `.claude/rules/terminal-ssh.md` | SSH remote terminals: ControlMaster early-publish + boot pre-warm, per-host freshness read, late cold-start self-heal, remote pty spawn pacing, remote node teardown / owed kills, SSH projects on Windows (in-process ssh2 transport) |
| `.claude/rules/canvas-layouts.md` | Canvas layouts: named node-geometry snapshots per project (save/restore/update/delete) |
| `.claude/rules/canvas-idle-energy.md` | Idle-energy animation frame-loop gate (styles.css `--nt-anim-state`, window/board attributes); performance: how to measure, and the rules measurement produced |
| `.claude/rules/window-behavior.md` | Main-process window behavior: geometry restore + window-raise policy |
| `.claude/rules/node-colors.md` | Node colors: one palette (system + agent sections), swatches, `color --color` boundary |
| `.claude/rules/semantic-colours.md` | Semantic colour tokens: the `--sys-*` palette, state/git ROLE tokens, `palette.ts`, the git status table, minimap strokes |
| `.claude/rules/appearance-wallpaper-glass.md` | Desktop wallpaper + Liquid Glass appearance (Settings → Appearance): painting, glass chrome, contrast, traps |
| `.claude/rules/files-node.md` | The `files` node (file-manager node) |
| `.claude/rules/relay.md` | Remote access (phone relay): free, not Pro |
| `.claude/rules/push-webhook.md` | Push webhook: a script or CI job rings the paired phone |
| `.claude/rules/hosted-team-relay.md` | Hosted team relay: the Server Edition as a relay host (share-team, hosted join, team admin) |
| `.claude/rules/live-links.md` | Live links: Pro browser link to one terminal (watch, chat, or type) |
| `.claude/rules/dev-server-ports.md` | Dev-server ports: the Ports chip + same-port SSH forwarding |
| `.claude/rules/speech.md` | Speech / dictation (desktop + server) |
| `.claude/rules/packaging.md` | Packaging, Windows beta, auto-update, check feed, telemetry |

Rules for the rule files themselves:

- **Content moves verbatim; the split is by SUBSYSTEM, the audience split with `CONTRIBUTING.md`
  is unchanged** (see Conventions). A new deep invariant goes into the rule file whose `paths`
  own the code it describes; if none fits, add a new rule file and a row above.
- **Keep every rule file's `paths` honest.** When you add, move or rename a source file, check
  whether a rule's globs still reach it; a rule that no longer matches anything is a rule nobody
  ever loads. `.claude/rules/` is the only part of `.claude/` that is tracked (see `.gitignore`).
- **Cross-references between rule files are by filename**, never "see the section above/below",
  because the files load independently. Older pointers elsewhere in the repo ("see CLAUDE.md,
  Terminal session continuity", "CLAUDE.md agent rule 7", …) still mean the same text: it now
  sits in the rule file the routing table names for that topic, under the same heading.

## What this is

**Node-based terminal manager** (BUSL-1.1, converts to MIT after 4 years — see `LICENSE`): multiple real terminals live on a single
pan/zoom canvas as draggable nodes. Target users are people with ADHD / disorganized
workflows who benefit from a spatial layout over stacked tabs. Long-term vision includes
remote access and paid features — the architecture is built so those slot in without a
UI rewrite (see Transport abstraction below).

## The name: Termscape is paint, `nodeterm` is plumbing — DO NOT "finish" the rename

This fork ships as **Termscape** (matching its iOS companion). The rebrand is deliberately
**user-visible only**: `build.productName`, `build.appId`, the window title, the `<title>`, the
welcome screen, the update card, the README, the app icon (`scripts/make-icon.mjs` renders
`resources/brand/termscape-appicon.svg`) and every in-app mark (`TermscapeMark`, guarded by
`src/renderer/brand-mark.guard.test.ts` — upstream's node-graph logo may not be drawn anywhere,
BUSL-1.1 grants no rights in it). **Everything else still says `nodeterm`/
`node-terminal` on purpose.** A future agent tidying up "leftover" occurrences would cause real
damage, so the reasons are recorded here:

- **`package.json` `name` is `node-terminal` and must stay.** It is what Electron's `app.getName()`
  resolves to, which anchors BOTH `app.getPath('userData')`
  (`~/Library/Application Support/node-terminal` — every workspace, setting and managed account
  dir) and the `safeStorage` Keychain entry (`node-terminal Safe Storage`, which encrypts the
  GitHub token and the model-gateway key). Renaming it silently orphans all of it and makes the
  stored secrets undecryptable. [MEASURED 2026-09-01: the packaged app has `CFBundleName=nodeterm`
  yet writes to `…/node-terminal`, so `productName` does NOT drive the path — `name` does. That is
  precisely why `productName` was safe to change and `name` was not.]
- **The tmux socket (`node-terminal`) and the `nt-<nodeId>` session names must stay.** They are the
  live handles on running sessions; renaming detaches every one of them, and the reaper/kill paths
  address sessions by exactly these strings.
- **`.nodeterm/project.json`, `~/.nodeterm/` on SSH hosts, `NODETERM_*` env, the hook endpoint file,
  `nodeterm.sh` / `context.sh` shims, `window.nodeterm`, `nodeterm:*` DOM events, `nodeterm.*`
  localStorage keys and `nt-media://` must stay.** The git-shared project files are read by other
  machines, the shims and endpoint files are already installed on remote hosts, and the iOS client
  speaks these names over the wire. Renaming breaks other machines, not this one — the worst kind.
- **Merge cost.** `nodeterm` appears ~3,600 times across ~445 files. This fork's value depends on
  merging upstream cheaply (the v0.3.4 merge was 192 commits); a blanket rename would put a
  conflict in nearly every future upstream diff, forever.

## Platform support

macOS, Linux, and a browser Server Edition are the shipping targets; Windows is being brought up
as a first-class desktop target (extraction from external PR #276). The policy for what "supported"
means — and what you may assume when writing a feature — is three tiers, not "100% parity":

- **Core is first-class everywhere.** The terminal + agent + canvas + session-continuity
  experience must work on every desktop platform. Continuity is tmux on POSIX and, where there is
  no tmux (Windows), a standalone session-host process — the mechanism differs, the guarantee does
  not.
- **POSIX-bound edges degrade explicitly, never silently.** Some subsystems are structurally tied
  to POSIX (SSH ControlMaster, the unix-socket askpass transport, some tmux-only paths — SSH
  projects on Windows use the in-process transport instead, see **SSH projects on Windows** in `.claude/rules/terminal-ssh.md`). On a
  platform where they cannot work they must either use a platform-appropriate mechanism or be
  clearly gated off — a feature that throws `EACCES`/`EPERM` on Windows because nobody checked is a
  bug, not an accepted limitation.
- **New code is platform-neutral by default.** Do not hardcode POSIX assumptions. Publish files
  through `renameAtomic`/`writeFileAtomic` (`src/core/fs-atomic.ts`), not a bare `fs.rename` — the
  guard test (`fs-atomic.guard.test.ts`) enforces this. Resolve path separators / absolute-path
  checks / file-link dialects against the filesystem-owning core's platform, not the viewer's, and
  never assume `/` or a unix socket. When a test can only run on one platform, gate it with
  `it.skipIf(process.platform === 'win32')` (or the inverse) and say why — never let it fail the
  cross-platform CI. The `windows-latest` CI job runs the platform-dependent suites on real Windows.
- **Line endings are decided by `.gitattributes` (`* text=auto eol=lf`), not by each contributor's
  git config.** Without it `text`/`eol` are unspecified and Git for Windows' default
  `core.autocrlf=true` gives every Windows clone CRLF working files — so a test that reads a
  checked-in file and slices on a `\n`-bearing literal (`CSS.indexOf('}\n}')`,
  `indexOf('\n}\n')`, `indexOf('\n}')`) matched nothing and failed on a checkout with ZERO local
  changes (issue #578). Two suites did; one reported 25 theme tokens missing that were all present,
  which reads like a regression rather than a broken slice. Attributes only apply on re-checkout
  (`git add --renormalize .` for a tree cloned earlier), so the readers ALSO normalize —
  `readFileSync(f, 'utf8').replace(/\r\n/g, '\n')` — and `src/shared/line-endings.guard.test.ts`
  fails on any such read that does not. `*.bat`/`*.cmd`/`*.ps1` are the deliberate exception and
  keep CRLF: cmd.exe is not reliably tolerant of LF, and those are the files a Windows contributor
  runs before anything else works.
- **PATH resolution and direct execution are separate on Windows.** `findInPathString` correctly
  follows `PATHEXT`, which means an npm-installed CLI may resolve to `<name>.cmd`; Node's
  `execFile`/`spawn` still cannot execute that path directly (`spawn EINVAL`). App-owned
  subprocesses must pass their resolved executable and argv through `directExecutableInvocation`
  (`src/core/exec-path.ts`), which invokes `.cmd` through a hidden `cmd.exe` with explicit escaping,
  verbatim arguments and delayed expansion off. Never replace this with `shell:true`: commit prompts
  and other user-controlled arguments would then be reinterpreted as shell syntax. The helper fails
  closed for `.bat`/`.ps1`, CR/LF/NUL inside argv, and command lines above cmd's real 8,191-character
  ceiling. stdin stays a byte stream directly into the shim; routing it through an npm `.ps1` shim's
  `$input | & node` text pipeline corrupts Unicode and line endings under Windows PowerShell 5.1.
  Interactive terminal agent launches keep using `agent-launch.ts`'s separately tested shell plan.

## Commands

```bash
npm install        # deps + rebuilds node-pty against Electron's ABI (postinstall hook)
npm run dev        # dev mode with renderer HMR
npm run build      # production build into out/
npm start          # preview the production build (electron-vite preview)
npm run typecheck  # tsc for both node (main/preload) and web (renderer) projects
npm run rebuild    # re-run electron-rebuild for node-pty if you hit ABI/native errors
```

**`rebuild` and `postinstall` both run `scripts/patch-node-pty.mjs` first, and that is not
optional.** It carries TWO version-pinned native patches for node-pty 1.1.0, one per platform leg:
- **darwin** — `pty_posix_spawn` leaks a ptmx device on every SUCCESSFUL spawn (an off-by-one in
  the low-fd cleanup) and master+slave on every FAILED one; on this app's spawn churn that
  exhausts `kern.tty.ptmx_max` within hours, and terminals then simply stop opening
  (microsoft/node-pty#950). Rewrites `node_modules/node-pty/src/unix/pty.cc`.
- **Windows** — the native exit thread deletes its `pty_baton` without closing the HPCON the baton
  owns, so the session host's taskkill-first kill path (src/session-host/host.ts) leaves a
  host-parented conhost alive for the life of the long-lived session-host process, one per killed
  session, and `conpty.kill(id)` reports nothing. The patch serializes baton access, closes the
  exact HPCON before every baton deletion, and makes `kill(id)` return `true` only as positive
  proof — the contract `src/session-host/windows-conpty.ts` was ALREADY written against (it
  shipped with #305 expecting a patched node-pty that did not exist until this patch; do not
  wire `closeExactWindowsConpty` into the ordinary kill path — after taskkill the exit thread
  usually wins the race, has already closed the HPCON itself under the patch, and the primitive
  would then report `false`; it exists for a pre-first-output teardown that bypasses the exit
  thread). Rewrites `node_modules/node-pty/src/win/conpty.cc` on every host — the file only
  compiles for the win32 native target, so patching on mac/Linux is harmless and keeps packaged
  rebuilds honest.

Both patches run before electron-rebuild compiles the module.

`src/main/node-pty-patch.test.ts` asserts both markers are present in those sources, so a node-pty
upgrade that silently drops either patch fails loudly. **If that test is red, your `node_modules`
is unpatched, not your code** — run `npm run rebuild`. It deliberately does not measure descriptors
or handles (that is environment-dependent); it checks the source the native module is built from.
Upstream: the darwin leg tracks microsoft/node-pty#950; the Windows leg has no upstream issue yet.
When a leg's fix lands upstream, delete that leg (and the whole script + test once both are gone).

**PACKAGING INVALIDATES THE TEST ENVIRONMENT — always `npm test` BEFORE `npm run dist`, never
after.** electron-builder runs its own `npmRebuild`, which replaces
`node_modules/node-pty/build/Release/pty.node` with the binary it wants for the packaged app. The
suite keeps running afterwards, and the marker test above still PASSES (it reads the patched
*source*, not the built binary) — but every test that spawns a real pty starts failing with
`Failed to spawn terminal (posix_spawn…)`. Measured 2026-08-31 during the v0.3.4 merge: a green
14-failure run became 23 the moment a packaging run landed in between, and the three newly-red
files (`sessionRename.realtty`, `pty-spawn-diagnosis`, `server-e2e`) went back to green after
`npm run rebuild` with no code change at all. The trap is that it reads exactly like a code
regression and the machine is nowhere near `kern.tty.ptmx_max` (37 of 511 here), so the obvious
explanation is the wrong one. If a pty-spawning test goes red right after you packaged, run
`npm run rebuild` before you debug anything.
```
```

`npm test` runs the vitest suite (unit + integration; the remote e2e suites skip when the
companion server repo isn't checked out). `npm run typecheck` is the fastest correctness gate.

## The Pro gate and the SELF-HOST UNGATE build flag

Upstream gates Pro (Pro whisper models, the upgrade dialog, the seat cap) behind a signed
per-device entitlement verified offline in `src/core/license.ts`. This fork's bypass of that gate
is a **build-time opt-in, default OFF**: `TERMSCAPE_UNGATE=1` in the environment of the build is
baked into the desktop main bundle (electron-vite `define`) and the Server Edition bundle (esbuild
`define` in `scripts/build-server.mjs`, a Node wrapper so the value never passes through a shell);
a runtime env var does nothing to a shipped artifact. Without the flag a build from
this repo behaves exactly like upstream nodeterm.

Why (2026-09-02): the Licensor agreed to the fork going public on the condition that published
installers do not strip the paid tier. A source tree that ungates by default makes every
third-party build a paywall-stripped copy of a USD 10/mo product; an opt-in the release step sets
keeps the fork's own builds unchanged. **Do not make the flag default on, and do not read it at
runtime.** Tests: `src/core/license.test.ts` is upstream's file verbatim and asserts the gated
default; `src/core/license.ungate.test.ts` sets the env before `vi.resetModules()` and asserts
the fork's inversions one token shape at a time. Interactive hosting (`remote:host:start`) and
Team Access seats (`relay-host-service.ts` `addSeat`) still require a REAL stored entitlement after
the `isPremium()` check, because they send it to the relay to mint a pairing token; the flag opens
the UI and the local checks, not upstream's hosted relay for those. The phone-relay standing host
is free (see `.claude/rules/relay.md`) and mints by device ID when no entitlement is stored — that
null-entitlement path is deliberate, not a gap the flag left.

Packaging: `build.files` in `package.json` excludes `out/server/**`. The desktop bundle never loads
it, and without the exclusion a stale `out/server/main.cjs` built with the flag would ride along in
a later default-off `npm run dist` (electron-vite only rebuilds `out/main|preload|renderer`).

## Process model (Electron, three contexts)

The codebase is split by Electron process boundary — keep code on the correct side:

- **`src/main/`** — Node/Electron main process. The **shell** around `src/core/`: owns
  Electron/window/IPC wiring, dialogs, and the `CorePlatform` implementation
  (`platform-electron.ts`). The renderer must never import these.
- **`src/core/`** — Electron-free service core (pty, workspace/settings stores, git,
  hook server + hooks cluster, context/subagent tails, transcripts,
  model-window, license, context-link, and the pure ssh leaves under `src/core/remote-ssh/`
  — control-master, remote-git). Talks to its shell ONLY via the `CorePlatform` interface
  (`src/core/platform.ts`); importing `electron` (or `../main/*`) inside `src/core` is
  forbidden and enforced by `src/core/no-electron.test.ts`. The Electron implementation is
  `src/main/platform-electron.ts`. This is the seam the Server Edition's `src/server/` shell
  plugs into.
- **`src/server/`** — Server Edition shell (Phase 2): plain `node:http` + `ws`
  serve the built renderer to a browser and speak a WS-RPC protocol
  (`src/shared/rpc.ts`) that a browser-side `window.nodeTerminal` shim
  (`src/renderer/bridge/`) consumes. Boots the same core services via
  `ServerPlatform` (`src/server/platform-server.ts`). Single-user auth
  (scrypt + httpOnly cookie + Origin check). `npm run server:dev` to try;
  docs/SERVER.md for details. `src/server` must not import electron or
  `src/main` (enforced by `src/server/no-electron.test.ts`). **Phase 3a** also
  serves fs/git/commit handlers (editor/diff/source-control now work in the
  browser) plus a web folder/file picker (in-app server-directory browser,
  replacing the native dialog) and WS backpressure; the renderer detects the
  bridge in `src/renderer/main.tsx` (desktop preload path is untouched).
  The picker's **folder** mode also creates directories (`createPickerFolder`,
  `renderer/bridge/dialog-picker.tsx`) — the native dialog it replaces has a New Folder
  button, so without one "Open folder…" in the browser could only ever adopt a directory
  that already existed on the server. It writes through the same `fs.mkdir`/`fs.exists`
  the Explorer's "New Folder…" uses and validates the typed name with the same envelope,
  `newEntryPath` (`renderer/lib/explorerCreate.ts`) — **do not add a second path
  validator here**; `..`, absolute and empty names are refused in exactly one place. The
  write deps are optional, so a caller with a read-only fs simply renders no button. File
  mode has none (nobody opens a file picker to make a folder). Relay tabs get the same
  button and it writes on the HOST, like every other `fs.*` the picker already uses. SSH
  projects are a separate flow (`SshProjectDialog` over `sshProject.mkdir`) and already
  had their own.
  **Phase 3b** boots the loopback **hook server** (`hookServer.start()`) + installs
  the managed hook scripts, and `wireAgentStatus` (`src/server/agent-status.ts`)
  broadcasts `agent:status` / `agent:subagent-activity` / `context:update` over the
  bridge, so agent-status badges, subagent cards, and the context meter now work in the
  browser (transcript-path jailed against forged POSTs). It also serves the two transcript READ
  channels (`registerTranscriptIpc` — the ⌘M chat view + the find-bar's transcript index; see the
  ⌘M bullet in `.claude/rules/agents.md`). **Canvas control is opt-in**
  (`NODETERM_SERVER_CANVAS_CONTROL=1` / `--canvas-control`): the Server shell installs its own shim
  and runs a serialized `HeadlessNodeFactory`; disabled remains the default. Its project writes
  broadcast on `workspace:server-change`, NOT the outside-edit channel — they are this core's own
  writes and are three-way merged by the renderer, never put behind the conflict bar (see
  `.claude/rules/persistence.md`). (The SDK **chat node** — once listed here as deferred — was
  removed entirely, 2026-07; see the chat-node note in `.claude/rules/nodes.md`.)
- **`src/preload/`** — the only bridge. `index.ts` uses `contextBridge` to expose a
  narrow API on `window.nodeTerminal` (typed in `index.d.ts`). `contextIsolation` is on,
  `nodeIntegration` off.
- **`src/renderer/`** — React UI. Talks to main *only* through `window.nodeTerminal`.
- **`src/shared/`** — types and IPC channel names imported by all three sides. `ipc.ts`
  is the single source of truth for channel strings; never hardcode a channel elsewhere.

PTY output flows main → renderer over per-session channels (`pty:data:<sessionId>`),
input flows renderer → main over `pty:write`. node-pty is kept **external** in the bundle
(`externalizeDepsPlugin` in `electron.vite.config.ts`) because it's a native module.

## Key abstraction: TerminalTransport

This is the load-bearing design decision. The renderer depends only on the
`TerminalTransport` interface (`src/renderer/terminal/transport.ts`), never on IPC or
node-pty directly. The current implementation is `LocalTransport` (IPC → node-pty). A
future `RemoteTransport` (WebSocket to a remote agent) implements the same interface, so
remote access / paid tiers can be added without touching the canvas or terminal UI. When
adding terminal-session features, extend the interface — do not reach around it.

## Atomic writes (never a bare `fs.rename`)

Every store persists temp-file-then-rename. That is correct on POSIX and **silently lossy on
Windows**: `MoveFileEx` fails with `EPERM` whenever the destination is open by anyone at that
instant, and what opens a file you just wrote is Defender's real-time scanner, the search indexer,
OneDrive over a synced profile, or two of our own concurrent writers racing one destination. The
save throws and the data is gone — intermittently, unreproducibly, and **more often on the machines
that are best protected**.

`renameAtomic` / `writeFileAtomic` (`src/core/fs-atomic.ts`) retry briefly. Each attempt is still
one indivisible rename, so a retry cannot tear a write. They deliberately do NOT retry forever
(several callers report a failed save as `persisted:false`, and that contract outranks a save that
eventually lands), do not retry `ENOENT`/`ENOSPC`, do not branch on platform (or the behaviour under
test on a Mac is not the behaviour shipped to Windows), and never swallow the final error.

**Nothing in the toolchain catches the bare version.** 28 files had it, across three spellings — the user's canvas, their
settings, their sealed credentials, their pinned devices — and every one of them reads as a correct
atomic write, because on the platform most of this was written on it is one. The only signal in a
6,000-test suite was one store's overlapping-saves test, red on Windows for that store's whole life.
So it is enforced by scan: `src/core/fs-atomic.guard.test.ts` fails on any bare `fs.rename` outside
the helper. Full write-up, including the separate shared-temp-name bug at the same sites:
**`docs/atomic-writes.md`**.

SSH/scp staging follows the same ownership rule outside direct `fs` calls. Atomic remote stdin
writes use `src/main/remote-atomic-write.ts`: a bounded `.nodeterm-<uuid>.tmp` leaf is placed beside
the target BEFORE both complete paths are quoted, then the shell preserves the write/move status
while cleaning that exact temp. The temp leaf must stay independent of the target leaf — appending
`.uuid.tmp` to a valid `NAME_MAX` target makes the write impossible.

**A remote write is only complete if the host checked the byte count, and a rename alone does not
check it.** `cat` cannot tell "the body ended" from "the ssh channel ended": when the channel dies
before the body arrives (the ControlMaster killed or rebuilt on a reconnect, the runner's 15 s
timeout SIGTERMing the child, a dropped link) it reads EOF and EXITS 0. Measured against OpenSSH 9.6
with the master SIGKILLed and with the child SIGTERMed, both before the body: a bare
`cat > f && chmod 755 f` left `f` at 0 bytes and flipped 644 → 755, and the temp + `mv` shape
published the empty temp over a good file just the same. That is how, on 2026-09-28, a host's
`~/.nodeterm/nodeterm.sh` and `context.sh` were 0 bytes after a reconnect and every agent's canvas
call exited 0 with no output. So `remoteAtomicWrite(path, body, options)` takes the BODY, checks
`[ "$(wc -c < temp)" -eq <utf-8 bytes> ]` before the rename (a short temp exits
`REMOTE_WRITE_SHORT_BODY` = 65 with the target untouched), returns the `stdin` it was built for,
and refuses an empty body unless `allowEmpty` (only the generic `ssh-fs` write passes it — an editor
may save an empty file; nothing we GENERATE is ever empty). `runRemoteAtomicWrite` also THROWS on a
non-zero exit: the runners resolve on failure, and awaiting them and moving on is what made the
failure silent. Every remote write goes through it — filesystem API writes, tmux.conf, the hook
endpoint, node tokens, agent status, pending answers, session env files, the Codex relay and
launcher, every agent hook script, the canvas/context shims and skills, and our own grok/copilot
hook configs. The USER's files — Claude/Gemini `settings.json`, codex `hooks.json` and
`config.toml`, and the AGENTS.md / GEMINI.md / copilot-instructions.md instruction blocks — go
through `updateRemoteTextFile` / `updateRemoteSettingsFile` (`core/agents/hooks/remote-settings-file.ts`)
instead: the same byte check plus our lock, symlink resolution (a dotfile link stays a link),
mode preservation, and a compare-before-publish; a read that fails is never treated as an empty
file (the old `cat f || true` then `cat > f` replaced an unreadable AGENTS.md with our block alone).
The local installers for the same files use `writeManagedHookFileAtomic` / `mergeInstructionFile`.
`src/main/remote-ssh/remote-write.guard.test.ts` fails on any new bare `cat > <file>` in
src/{core,main,server}, and `remote-write-truncation.test.ts` runs every installer under a real
`/bin/sh` with the body cut off.
**Never `chmod <mode> -- <file>` in a remote command.** BSD/macOS chmod does not permute: its
getopt stops at the MODE operand, so the `--` after it is a FILE named `--` ("No such file or
directory", exit 1) and the `&&` chain never publishes. `mkdir -p --`, `mv -f --` and `rm -f --` are
fine (their `--` comes before any operand). That spelling shipped from v0.3.3 (fbc65ad8) for the
hook endpoint and node tokens, so `setup()` returned null on every macOS SSH host — no status
hooks, canvas control or context link there. The real-shell tests put a non-permuting chmod
(`POSIXLY_CORRECT=1` GNU chmod) first on PATH for every mode-bearing caller.
**Canvas control and context link install as ONE chain** (`RemoteHooks.installAgentTools`): they
merge different blocks into the same AGENTS.md / GEMINI.md, and the transaction lets only one of two
racing writers publish a snapshot — fired side by side they lost 16–19 of 48 blocks over 8 fresh
hosts. Upload directories use UUIDs across app
processes. Downloads and media-cache copies use hidden UUID `.part` names; user-visible downloads
also hold an exclusive candidate lock until the rename and cleanup finish. Never simplify any of
those back to `<target>.tmp` / `<target>.part` or a read-only "does the destination exist?" check —
the overlap tests exercise the resulting race.


## The test suite never touches a live tmux server

This repo is developed from inside nodeterm, so `tmux -L node-terminal` and `-L nodeterm-rmt` are
not fixture names on a contributor's machine — they are the servers holding every terminal they have
open. A test that binds one shares a process with the user's whole canvas, and the failure mode is
not a red test: it is every pane printing `[server exited unexpectedly]` (issue #629).

**Every vitest run gets a private `TMUX_TMPDIR`.** tmux resolves `-L <socket>` to
`$TMUX_TMPDIR/tmux-<uid>/<socket>` and falls back to `/tmp` when the variable is unset, so
re-pointing the variable re-points every socket name at once — including the real ones, including
in a suite nobody thought about. `test/setup/tmux-sandbox.ts` (`globalSetup`) creates the directory,
kills whatever is still bound inside it and removes it; `test/setup/tmux-worker-env.ts`
(`setupFiles`) re-asserts it inside each worker and **refuses to run** if it is missing, because
vitest's env inheritance into workers is an implementation detail and a silent fallback would put
every test back on the live server. `enterSandbox` also strips `TMUX`/`TMUX_PANE` — a suite run from
inside a nodeterm terminal inherits a live client's, and production strips both for the same reason.

Two suites deliberately name a real socket, and both are allowlisted with their reason in
`src/core/tmux-socket-isolation.guard.test.ts`: `agents/pane-owner.test.ts` (the production bytes
hardcode `-L nodeterm-rmt`; re-spelling it would judge different bytes) and
`main/remote/host-destroy-tmux.test.ts` (`PtyManager` binds `TMUX_SOCKET` itself). The latter was
the one file that reached the live server by construction — measured, not inferred — and it now
refuses to start unless the sandbox is in effect.

**What the sandbox does NOT do:** two suites naming the same socket inside it still share one tmux
server, so a `kill-server` there is still a shared-server kill — it has just been moved somewhere
harmless. Measured on CI the day this landed: the guard test's own `kill-server` on
`node-terminal` ended `host-destroy-tmux.test.ts`'s session mid-assertion. A suite kills its OWN
sessions by exact target (`-t =<name>`, since a miss falls through to prefix matching), or it owns
a socket name nothing else uses.

The guard has three legs on purpose, and the weakest one is the scan: a test can still escape by
handing a real tmux an `env` object it built from scratch with no `TMUX_TMPDIR` in it, which no
regex sees. So the structural leg is the sandbox, the behavioural leg actually **starts a server on
the real socket name and proves the socket file landed inside the sandbox** (asserting the env var
would only prove we set a variable — the resolution rule is a property of tmux), and the scan exists
to make a third allowlist entry a decision somebody signs for. Same shape as the `fs.rename` guard,
for the same reason: nobody reading one file can see this.

**What this does not claim.** #629's server death was not traced to a test — the reporter's evidence
points at tmux's `server_accept()` calling `fatal()` under the suite's process/fd burst on a
memory-starved machine, and two identical runs finished clean. Sharing a server with the user's live
sessions is a hazard whatever kills it; this removes the hazard, not a proven cause.

**`fakePlatform()`'s directories live exactly as long as the run** (`test/setup/fake-platform-root.ts`,
the same per-RUN `globalSetup` shape as the tmux sandbox). Each call used to `mkdtemp` in the system
temp dir at construction and nothing removed it: a development server running the suite repeatedly
collected ~395,000 `nodeterm-fake-*` directories, `/tmp` ran out of inodes while still showing GBs
free, and full runs failed in 1,201 of 1,207 files with ENOSPC. Measured on 40 suites that use it:
271 directories left behind before, 0 after. Two halves, both needed: the directory is made on first
READ of `userDataDir` (a test that passes its own, or never reads it, makes none), and it is made
under a run root that teardown removes once every test file has finished (vitest tears global setup
down BEFORE it waits for its workers to exit, so a late timer is not ruled out — a per-file
`afterAll` would be strictly worse, sweeping while that file's debounced writes are still due). The
teardown never throws and is listed first so it runs last: vitest's teardown loop has no catch per
file, and a throw there would silently skip the tmux sandbox's teardown. The leaf under the root is a
bare `u-`, because every byte added is closer to the macOS unix-socket path budget
(`hook-sock-path.ts`) for anything a test binds under `userDataDir`. A run killed before teardown
leaves ONE directory. A test that builds its own `CorePlatform` takes its `userDataDir` from
`makeFakeUserDataDir()` (same root, removed with it) — never a bare `mkdtemp` in the system temp
dir and never a fixed `/tmp/...` literal.
`platform-fake.test.ts` fails if the root is not in effect, so dropping the `globalSetup` entry is loud.

## The test suite leaves nothing in the OS temp dir

Measured 2026-09-29 on a shared dev box: `/tmp` held ~41k top-level entries, and one full run of this
suite added ~1,560 of them (`nodeterm-fake-*` alone was 1,412 — see the `fakePlatform()` paragraph
above for that half). The filesystem ran out of INODES and every session's builds and tests broke.
For every OTHER test dir, two layers, both needed:

- **Every test dir is removed where it is made.** `testTmpDir(prefix)` (`src/core/test-tmp.ts`) is
  a tracked `mkdtemp` whose removal is an `afterAll` in the setup file `test/setup/tmp-worker-env.ts`
  — a setup file's hooks sit on the file's root suite and, with vitest's default stacked hook order,
  run AFTER the file's own `afterAll` hooks, i.e. after the suite stopped whatever was writing there.
- **The run is sandboxed and FAILS on a leak.** `test/setup/tmp-sandbox.ts` (`globalSetup`, listed
  AFTER the tmux sandbox so that one keeps its short base path) points `TMPDIR` (and `TEMP`/`TMP` on
  Windows) at one private directory; teardown lists what is left, removes the sandbox anyway, and
  sets `process.exitCode = 1` naming each prefix. **Not `throw`**: vitest only LOGS a teardown error
  (`error during close`) and still exits 0, and a throw skips the other globalSetup teardowns — the
  tmux sandbox's, measured. Windows warns instead of failing (a just-exited child's file can be
  EBUSY for a moment after a correct cleanup). `NODETERM_TEST_KEEP_TMP=1` keeps it for inspection.
  `FOREIGN_TMP_ENTRIES` is the short allowlist of names nothing in this repo creates (Chrome's own
  scratch files from the headless layout tests), each with its reason.
- **Two leaks were production memos, not test bugs**: `contextLinkDir()` and
  `HookServer.endpointFilePath()` cached the FIRST platform's `userDataDir` for the life of the
  process, so a process that booted a second core (the server e2e suites) wrote `context.sh` and
  `hook-endpoint.env` into the first core's already-removed directory. `initContextLink` and
  `hookServer.stop()` now drop the memo. Found with `strace -f -e trace=mkdir,rename` — an EMPTY
  leftover dir is the signature of a late writer, not of a missing `rm`.

## Conventions

- **Two docs, two audiences — keep both.** This file holds the deep invariants with their
  reasoning and measurements; it is dense on purpose and is loaded automatically by coding agents.
  **`CONTRIBUTING.md` is the short human door**: setup, the process-boundary rules, the house rules
  that get a PR sent back, and the testing habits. When you change or discover something **other
  developers must know before touching the code** — a boundary that is now enforced, a trap that
  costs an hour to diagnose, a habit that catches a class of bug — **add it to `CONTRIBUTING.md`
  too, not only here.** An invariant that lives only in this file (or worse, only in a commit
  message) is one refactor away from being violated by a contributor who never opened it. Keep the
  split by audience, not by topic: the *why it must be this way* stays here, the *what you need to
  know before your first PR* goes there.
- **…and the deep tier itself is split by SUBSYSTEM into `.claude/rules/*.md`** (2026-09-01, see
  "How this documentation is organized" at the top). Those files ARE this document — the same
  audience, the same density, the same "add it to `CONTRIBUTING.md` too" duty — loaded per path
  instead of per session. When you write a deep invariant, put it in the rule file whose `paths`
  own the code; only cross-cutting material (the sections still in this root) belongs here.


- Code comments, UI strings, and identifiers are all in **English**. Match this when editing.
- **The local machine is not a Mac.** Every user-visible string naming it goes through
  `renderer/lib/machineName.ts` (`thisMachine()` / `thisMachineCap()` / `machineNoun()` →
  "this Mac" / "this PC" / "this computer"). A **browser tab always gets the neutral word**: the
  license, seats and sessions it describes belong to the SERVER, and the viewer's `navigator` says
  nothing about that machine's OS — a confident wrong noun is worse than a plain one. Issue #563
  found ~30 such strings, and the damage was not in Accounts but in the copy people must TRUST:
  "This Mac is not authorized on this license" and "a teammate on a seat can run commands on this
  Mac". `machineName.guard.test.ts` scans non-comment lines in `src/renderer` + `src/shared` and
  fails on a new one, with a named-and-reasoned exemption list (the ptmx-limit banner, whose
  `kern.tty.ptmx_max` really is macOS; the onboarding notch step, which only exists there).
  `@shared` code cannot ask the renderer, so it takes the machine word as a PARAMETER defaulting
  to the neutral one (`describeGrant(peer, machine)`) rather than hard-coding a brand.
- Path aliases: `@shared/*`, `@renderer/*` (see the tsconfig files / vite config).
- **Three surfaces — design every feature for all of them.** nodeterm now ships on three
  fronts, and a feature is not "done" until you've decided how it behaves on each (even if
  the decision is "not applicable here"):
  1. **Desktop** (Electron) — the primary app (`src/main` + `src/renderer` via the preload).
  2. **Server Edition** (Linux, browser) — `src/server` + the `src/renderer/bridge` shim (see
     the `src/server/` bullet above and docs/SERVER.md).
  3. **Mobile companion** — *nodeterm mobile*, two **separate PRIVATE repos**: `nodeterm-ios`
     (SwiftUI + SwiftTerm/Citadel) and `eneskirca/nodeterm-android` (Kotlin/Compose, in
     development) — outside contributors cannot see or PR either, so a mobile implication is
     raised in the desktop PR and **@eneskirca** is mentioned to carry it over. Both are
     tmux-integrated, talk the same `TerminalTransport`/RemoteTransport protocol and the same
     pairing/relay/mirror wire contracts, so a desktop change must not assume the phone is an
     iPhone (copy, defaults, store links — see **Phone pairing is platform-neutral**).

  **The canvas and the kanban board are TWO VIEWS of the same nodes — treat the board as a
  first-class surface, not an afterthought.** Every session/node feature you add to a canvas node
  (a header action, a context-menu item, a status badge, file drop, dictation, …) should be
  considered for the kanban **card** and its **card modal** too, so we don't keep shipping a
  feature on one view and then bolting it onto the other in a follow-up. The board already mirrors
  most of the node's surface: the card modal co-attaches the same tmux session (`ModalTerminal`),
  carries the node's actions (search / dictate / AI-name / comments), accepts file drops
  (`terminal/file-drop.ts`), renders browser webviews (`BrowserSurface`), and its cards support
  right-click actions + `+ New`. When you touch a node's UI, ask "does the board need this too?"
  and wire it through `KanbanView`/`SessionCard`/`CardModal` in the SAME change. Kanban itself is
  desktop+Server-Edition (pure renderer + `workspace.save`); the iOS board is a separate read/move
  mirror (`nodeterm-ios`, `KanbanGrouping`/`ProjectBoardView`).

  Practical rules that keep the surfaces in sync:
  - **Put new service/main-process logic in `src/core` behind `CorePlatform`, never inline in
    `src/main`.** That is the seam the Server Edition boots from — logic left in `src/main`
    silently doesn't exist on the server (the `no-electron` tests enforce the boundary, but
    they can't tell you a feature is *missing* server-side).
  - **A feature that touches `window.nodeTerminal` needs a real `src/renderer/bridge`
    implementation, not just a stub** — or a deliberate, documented graceful degrade
    (`E_UNSUPPORTED` + the affordance hidden, like the Electron-only `shell.reveal`). The
    bridge's `satisfies NodeTerminalApi` gate forces you to *declare* every member, but a
    `noopUnsub`/`unsupported` stub compiles fine while doing nothing — decide per member.
  - **Consider whether the mobile companion should surface the feature** over its
    transport/protocol. It's a different repo and stack (Swift), so this is usually a
    follow-up note rather than same-PR work — but flag it so it isn't forgotten.
  When a change is genuinely desktop-only (native menus, auto-update, Keychain), say so; the
  point is to make the call consciously, not to leave the other surfaces to rot.
