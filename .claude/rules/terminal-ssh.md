---
paths:
  - "src/core/remote-ssh/**"
  - "src/main/remote-ssh/**"
  - "src/core/remote-end.ts"
  - "src/core/pending-remote-kills.ts"
  - "src/renderer/lib/sshRemoteWait.ts"
  - "src/renderer/terminal/cold-self-heal.ts"
---
# SSH remote terminals: connect, freshness, pacing, teardown

> Split out of `terminal.md` in the v0.3.7 merge: these SSH invariants govern `src/core/remote-ssh/**`
> and `src/main/remote-ssh/**`, so a plain `TerminalNode.tsx` read does not pay for them. General tmux
> continuity and cold restore stay in `terminal.md`.

## ControlMaster is published BEFORE its setup chain

`connectOnce` (`main/remote-ssh/ssh-project.ts`) used to publish a project's master only at
`status:'connected'` — after the hook tunnel, ~23 serialized hook installs, `$HOME`, the remote
tmux.conf and Codex staging. Measured through a 50 ms-RTT proxy: that chain is **3.54 s**, while 18
terminals over a warm master paint in a median **0.16 s**. So the attach was never the bottleneck;
terminals sat in `resolveSshRemote`'s 20 s wait printing `[connecting…]` over a ready transport.

- **Early signal**: the moment `ssh -O check` answers, a `connecting` event carries
  `masterControlPath`. `connected` keeps its meaning and everything hung off it is untouched; the
  renderer holds the early path in `useSshConn.earlyByProject`, **never `byProject`**.
- **Only a node whose remote session ALREADY EXISTS may act on the early master**
  (`remoteSessionConfirmed` → the strict `present`-only verdict). The tmux config (`-f`) and hook/
  account env (`-e`) are read at session CREATION only, so an ABSENT session, or a host that could not
  be read, waits for `connected` — creating it early silently costs its agent-status badges with no
  repair event. Pure `renderer/lib/sshRemoteWait.ts`.
- **Never for an ADOPTED live-orphan master**: the tunnel-verification path may `-O exit` and rebuild
  it (killing a terminal attached meanwhile); the rebuild clears `reusedOrphan` and does publish.
- **Boot pre-warm** (`core/remote-ssh/ssh-prewarm.ts`): masters were dialed only on first switch, so
  each run's first visit paid the cold establish (**0.44 s**) plus the chain. `prewarm` dials OPEN
  projects' masters after boot, **one host at a time** (a burst trips `MaxStartups`; `SshChildGate`
  caps exec children, not logins). It is **SILENT** (no event — the user isn't looking; the mark lifts
  when a real connect arrives), **never prompts** (`isQuietMasterPid` declines; the user's own connect
  prompts), and **never dials CLOSED** projects or one already mastered / in flight.

## Freshness read: one coalesced list per host per burst

The `fresh` flag (see `terminal.md`, Cold restore) asks tmux whether a session exists before spawning.
Locally that is one `has-session` per node; **on SSH it is ONE `tmux list-sessions` per host per
burst** (`remote-session-index.ts`), because a switch mounts every node in one tick and N probe + N
pty channels overrun a stock host's `MaxSessions 10`. Two invariants: **(1)** only tmux's exit 1 is
evidence of absence — any other outcome answers "exists", since a transport failure read as "cold"
types `claude --resume …` into a LIVE agent pane; **(2)** a session this process just spawned is
`markPresent`ed and a remote kill invalidates the cache, so nothing in the cache window is told it is
cold when it is not. TRI-STATE (`present|absent|unknown`): `exists()` folds `unknown` into "exists",
the wait caller folds the opposite way.

## Late cold-start self-heal when the verdict was a GUESS

The unknown⇒"exists" fold is right but strands conversations under load. **Incident (2026-09-15):**
the host tmux server died; ten minutes later a 108-node project opened, 107 sessions created in one
burst, and sshd logged **757 `Accepted publickey` logins in 7 minutes** (healthy master: ~0). The
freshness read times out, the fold says "exists", `new-session -A` makes an EMPTY session,
`fresh:false` skips cold restore, and the pane sits at a bare shell (a 22-session burst resumed 82%,
the 107-session burst 38% — a race). Three changes, order matters:

- **A second opinion, never a different fold.** `create()` reports `freshUnverified` when
  `fresh:false` came from `unknown`; the renderer re-asks ONCE after the burst and tmux settles it via
  `#{session_created}` (survives a `new-session -A` attach, so a session created within seconds of our
  attach is one WE made; `remoteSessionAgeArgs` also prints the host's `date +%s` so clock skew never
  enters it). Every rule in `renderer/terminal/cold-self-heal.ts` is a REFUSAL — never for a READ
  verdict, an unknown age, past the window, or unless a SHELL still owns the pane. Scrollback replay is
  NOT re-run (tmux already painted); the agent relaunch is.
- **The per-node token write is coalesced, not gated.** `ensureRemoteNodeToken` was one round trip per
  spawn for work the connect already did, against a burst budget of 6; it now memoizes per (control
  path, node) and coalesces a burst into ONE write.
- **Remote pty spawns are paced** (`pty-spawn-gate.ts`, cap 4 per master). A slot is held only until
  the session paints — released on FIRST OUTPUT and unconditionally after
  `REMOTE_PTY_SPAWN_SETTLE_MS` (a gate that can hang is worse than none); a waiting node SAYS so. Lab
  (real sshd, `MaxSessions 10`, 50 ms RTT, warm master, 107 attaches): ungated = 72/77 logins,
  ~100/107 panes, 2.1 s; gated = **1** login, **107/107** panes, ~3.5 s. Wall time is the price;
  ungated, 5-11 panes never painted inside the 20 s budget.

## Remote node teardown: kill semantics and owed kills

- **Whether a node IS remote is answered WITHOUT a live session** (`core/remote-end.ts`). Reading it
  off the dying `Session` (`dying?.sshRemote`) fails exactly when a delete arrives with nothing
  attached (restart, offscreen release, park expiry, an unopened project): remoteness read "local",
  the remote kill was skipped SILENTLY, and the node vanished while its `nt-<id>` kept running on the
  host. The durable answer is the machine-local index — `PtyManager.setRemoteNodeOwner` maps the node
  to its SSH project + ControlMaster; a LIVE `sshRemote` still wins when present, so the two are
  complementary. Server Edition wires no resolver.
- **The kill is CHECKED, and only a `delete` may owe a debt.** tmux exit 1 (`probeSaysAbsent`) is an
  ANSWER; ssh 255 / 127 / a spawn error is a NON-answer with the session still running, so it is
  recorded (`core/pending-remote-kills.ts`, atomic JSON keyed by `user@host` since projects share a
  host's tmux server) and settled on the next connect (`settleOwedKills`; dropped only on tmux exit
  0/1). The delete is NEVER refused over an unreachable host — defensible only because the debt is
  durable. A `recycle` (worktree move, model switch, pause & end) keeps the node and records NOTHING
  when it cannot land, or the deferred kill would hit the session that node respawned under the same
  name.

<!-- moved-verbatim-from: CLAUDE.md (upstream v0.4.2) -->
## SSH projects on Windows: the in-process transport

Windows' own OpenSSH cannot multiplex, and that is measured, not assumed (windows-latest,
`OpenSSH_for_Windows_9.5p2`): `ssh -M` fails with `getsockname failed: Not a socket`, and a child
carrying `ControlPath` FAILS rather than falling back — so every remote command, terminal and
tunnel of an SSH project failed on a stock Windows machine. Git for Windows' ssh (10.5p1) starts a
master but every session over it is reset and falls back to a full login per command. So on
Windows the app does not run the ssh binary for SSH projects at all: `src/core/remote-ssh/native/`
holds ONE `ssh2` connection per ControlPath and carries every exec, pty, SFTP session and reverse
unix-socket forward over it. POSIX keeps OpenSSH untouched.

- **One switch:** `useNativeSsh()` — always on win32; `NODETERM_NATIVE_SSH=1` turns it on anywhere
  (how it is tested live from macOS against a real host), `=0` forces it off. Decided once per app
  run for the SshProjectManager runners.
- **Call sites do not change.** They keep building OpenSSH argv (`control-master.ts`);
  `ssh-argv.ts` is a STRICT parser that reads it back and refuses (by name) any option it does not
  know. A builder that grows a flag must teach the parser, or the native path fails loudly —
  `ssh-argv.test.ts` parses every builder's output.
- **Seams wired:** SshProjectManager's runners (`initSshProject`), pty-manager's
  `runAsync`/`runWithStdin` and the remote terminal itself (`NativeSshPty`, a pty channel shaped
  like `IPty`), remote-git, the setup runner (`spawnSshArgvStream`), the workspace poll's
  master check. A new ssh call site owes the same routing.
- **Semantics are OpenSSH's:** ControlMaster auto/no, `-O check|exit|forward|cancel`,
  `StrictHostKeyChecking=accept-new` over the user's own known_hosts (hashed entries included —
  that is why HMAC-SHA1 appears; CodeQL's alert on it is dismissed with the reason), publickey
  only (agent, then key files, passphrase through the existing dialog, never in BatchMode), the
  user's `~/.ssh/config` via `ssh -G` (never a second parser of it), a dropped connection ends
  every channel with 255 (what `SshReconnector` reads).
- **Channels past the server's MaxSessions spill onto more connections** (10 on a stock sshd; a
  live 89-terminal project left 25 terminals blank before this). A refusal marks that connection
  full until one of its channels closes; overflow connections are bounded
  (`MAX_OVERFLOW_CONNECTIONS`) and live and die with the primary. A key unlocked with a passphrase
  is held in memory while any connection is alive so overflow connections do not prompt again —
  the Windows tradeoff for having no app-private ssh-agent.
- **Channel races — keep these, each was a real bug:** open-confirmation, exit-status and close can
  arrive in ONE read, so the exit status is recorded inside ssh2's callback (`recordExit`) and exec
  consumers attach there too (`openOn`'s `onOpen`); late consumers check `channelExit(ch).closed`.
  A killed streaming child must never write to its ended pipes (an uncaught
  `ERR_STREAM_WRITE_AFTER_END` in main). A stream nobody reads never emits `close` — tests must
  `resume()` the channels they hold.
- **Tests run on every OS** against ssh2's own in-process `Server` (loopback, no sshd); the
  directory is in the `windows-latest` CI job. Live numbers (macOS, `NODETERM_NATIVE_SSH=1`,
  89-terminal project): 89/89 attached, 0 ssh processes, ~1 login per connect, main CPU 3–5% idle.
- **ProxyJump** (#1078) follows OpenSSH: each hop is resolved by ITS OWN `ssh -G` and gets its own
  host-key check and publickey auth; the chain is ssh2 `forwardOut` streams used as the next hop's
  socket. `ssh -J a,b t` means `ssh -J a -W t b`, so only the FIRST hop's own ProxyJump is followed
  (recursively); loops and chains deeper than 8 are refused by name. Jump connections belong to
  the target connection and die with it (a dropped jump → 255 on the target's channels). MaxSessions
  overflow connections REUSE the primary's chain (one bastion login; direct-tcpip does not count
  against the bastion's MaxSessions); one-off connections build their own. Known hosts are checked
  under `HostName` (or `HostKeyAlias`), as OpenSSH does — not under the alias as typed.
  **ProxyCommand stays refused by name**, on the target and on a hop.
- **The Windows ssh-agent only on the user's say-so** (#1080). MEASURED on windows-latest
  (OpenSSH_for_Windows_9.5p2): the agent service REFUSES any lifetime or confirm constraint
  (`ssh-add -t` / `-c` and our `ADD_ID_CONSTRAINED` alike), and an unconstrained key is stored in
  `HKCU\Software\OpenSSH\Agent\Keys` (DPAPI) and survives service restarts — "until removed" is
  the only add Windows offers. So a passphrase-unlocked key is added (`agent-add.ts`, our own
  agent-protocol writer; ssh2 only lists and signs) ONLY when the host's own config says
  `AddKeysToAgent yes` (what Windows' ssh.exe would do) or the user turned on Settings → Remote
  (SSH) → "Keep unlocked keys in the Windows ssh-agent" (`settings.windowsSshAgentAddKeys`, default
  OFF, copy says Windows keeps it until `ssh-add -d`). A config lifetime is sent as a constraint and
  Windows' refusal stands: a refused constrained add is NEVER retried unconstrained. Fail-open: an
  agent error never affects the connection. Reboot persistence is inferred from the registry hive,
  not measured.
- **Not done yet:** sleep/wake verification on the native transport, a like-for-like timing against
  OpenSSH on the same project, and any run on a real Windows desktop (all evidence so far is CI plus
  the macOS run of the same code path).
