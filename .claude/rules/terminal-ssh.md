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
