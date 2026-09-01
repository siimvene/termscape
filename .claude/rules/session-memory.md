---
paths:
  - "src/core/session-memory*.ts"
  - "src/core/session-budget.ts"
  - "src/renderer/components/SystemResourcePill.tsx"
  - "src/renderer/components/SessionMemoryPanel.tsx"
  - "src/renderer/state/sessionMemory.ts"
  - "src/renderer/lib/sessionKill.ts"
  - "docs/session-memory.md"
---
# Session memory: the RAM pill, the per-session panel, socket fan-out kills

> Moved verbatim from the root `CLAUDE.md` on 2026-09-01 (see its "How this documentation is
> organized" section). Loads automatically when a file matching the `paths` above is read;
> when the root routing table points here, read this file before touching the subsystem.
<!-- moved-verbatim-from: CLAUDE.md -->

## Session memory (the RAM pill + the per-session panel)

A bottom-left **RAM pill** (`components/SystemResourcePill.tsx`) beside the usage pill, and the
**session-memory panel** it opens (`components/SessionMemoryPanel.tsx`): used/total RAM of the
machine the **active project** runs on, and every `nt-*` tmux session on that machine sorted by the
memory its whole process TREE holds, each row travelable (`goToNode`) and killable. Scope is
`usageScopeKey` — the same helper the usage indicator uses, so the two pills can never disagree
about which machine they describe. Reading + parsing is `core/session-memory.ts` (this machine) and
`core/session-memory-remote.ts` (an SSH project's host), served over one RPC by
`core/session-memory-service.ts`, which BOTH shells boot. Full write-up + the device checklist:
**`docs/session-memory.md`**.

- **The memory is the agent CLI's own V8 heap — nodeterm does not allocate it, and it is not a
  leak.** Measured on the production host that prompted this (64 GB, 95 live `claude` processes): a
  `claude` process alone averages **335 MB** and peaked at **1159 MB**; 95 of them held **31.1 GB**;
  MCP children add 30–200 MB per session (playwright-mcp + Chrome ≈ 200 MB alone), so one "Claude
  terminal" tree is **440 MB – 1.2 GB**. `RssAnon` is essentially all of the RSS (1165 MB of 1187 MB
  on the largest process) and the repo sets no `NODE_OPTIONS`, so V8 sizes its heap off system RAM
  (`heap_size_limit` 4144 MB there). It is flat with process age — 0–24 h avg **340 MB** vs 7 day+
  avg **326 MB** — so each process takes a baseline and never returns it. **Write those numbers down
  rather than re-deriving them.** The user's number was right and their attribution was wrong; what
  the product was missing was not the allocation but the **blindness** — nothing told them 18
  sessions were live, that one was 1.2 GB, or that six belonged to a project they closed weeks ago.
- **The reaper is deliberately unchanged.** `core/session-budget.ts` reaps only **detached** sessions
  past a grace window, so on that host its kill list was **EMPTY** — 60 `nt-` sessions, 50 attached,
  0 eligible — while 31 GB sat there. An open canvas is attached, and attached is untouchable.
  Retargeting it is a separate change with separate risk; this feature adds **sight**, not policy.
- **`ok:false` is not `ok:true` with no rows** — the rule the whole feature exists to honour, and
  every layer preserves it. A sweep fails (no tmux, unreadable process table, **no socket answered**,
  a missing or out-of-order marker in the SSH reply, a rejected call) ⇒ `ok:false` and no rows; the
  panel then says "Could not measure sessions on this machine", and the grand total and the "*n*
  sessions" count are gated on a `measured` flag so a failure can never render as `0 B / 0 sessions`.
  "We looked and there is nothing" is its own sentence. A socket with **no tmux server** is an
  ANSWER, not a failure (`isNoServerError`), and that classifier is **anchored to tmux's own connect
  message**: `promisify(execFile)` folds stderr into `err.message`, and a bare `no such file or
  directory` also matches a tmux client missing a shared library (exit 127 on *every* socket) and a
  dead ssh ControlMaster — laundering either into "no sessions here" prints an empty panel over 20
  live ones. **The SSH leg applies the SAME classifier to the same rule**: each socket is fenced in
  the reply with its tmux exit status and its stderr (`##SOCK <name>` … `##SOCKRC <n>`, `2>&1`), and
  zero answers ⇒ `ok:false`. Its first form threw both away (`{ tmux …; tmux …; } || true`), so a
  host whose tmux client could not start emitted a stream byte-identical to an idle host's and the
  panel reported thirty live sessions as "No sessions are running here.". Do not "simplify" the
  fence back out — and do not replace the classifier with a blunt "any error ⇒ ok:false" either: on
  a host with no tmux server at all EVERY socket fails, and there "there are no sessions" is the
  honest answer.
- **`readMemInfo` has exactly one home** (`core/session-memory.ts`); `session-budget.ts` imports and
  re-exports it. The reaper's watermark and the pill must never disagree about how much RAM is free,
  and a second copy is exactly the drift these rule files warn about elsewhere. `null` = could not read,
  never zero.
- **The local reader reads `/proc/<pid>/status`, never `statm`.** `status` carries `PPid` and `VmRSS`
  in one file, already in kB; `statm` reports RSS in **pages**, forcing a page-size assumption — a
  hard-coded 4096 under-reports **4×** on a 16 KiB-page arm64 kernel and **16×** on the 64 KiB-page
  enterprise arm64 builds (40 MB printed for a 640 MB session). **Do not optimise this back to
  `statm`.** Non-Linux falls through to one `ps -eo pid,ppid,rss` call, through the same injectable
  seam as tmux.
- **`childCount` counts ALL descendants**, the agent CLI included: `pane_pid` is the pane's SHELL, so
  a claude session with two MCP servers reports **3**. The UI therefore says "**child processes**",
  never "MCP" — a plain `npm run dev` has children too.
- **The cadence split follows the cost.** A **local** scope polls the pill's number every 30 s
  (`HOST_POLL_MS`, one file read, free). An **SSH** scope is **never polled**: one read on scope
  entry, one when that project's ControlMaster comes up (an SSH project is opened before its master
  is ready, and with no timer behind it a first read against a dead master leaves the pill blank),
  and one per panel open / `⟳`. Same rule `.claude/rules/agents-accounts-usage.md` already sets for **Remote usage**, for the same
  reason: every remote read is an ssh exec plus a `ps` of somebody else's whole process table. The
  full sweep runs on the panel's MOUNT (it is unmounted while closed) and on `⟳` — never on a timer,
  never from the pill. One more consumer, same discipline: the welcome screen runs ONE **local**
  sweep per appearance (only while "Recently closed" is non-empty) for its per-project
  live-session badges (issue #442), bypassing the panel's store on purpose — it must not disturb
  `state/sessionMemory.ts`'s module-level scope stamp, and its scope is always THIS machine.
- **The pill is the single owner of the store's `startHostPoll` / `stopHostPoll`** — the timer and the
  active-scope stamp are MODULE SINGLETONS. The panel must never call them: a `stopHostPoll` on
  unmount would clear the pill's interval with nothing left to restart it, and the number would
  silently freeze until the next scope change.
- **A closed project is not an orphan.** `closeProject` keeps the project and its nodes on disk, so
  its sessions resolve to a real title and are labelled with their project; calling them orphans
  would invite the user to kill sessions they deliberately parked. `resolveSessionRows` is therefore
  fed EVERY project — filtering to the open tabs defeats the rule silently, from outside the file
  that states it. And **`orphan` is the distinguishing field, NOT `state === null`**: a plain
  terminal never enters the agent-status map, so deriving orphan-ness from a missing agent state
  would flag every one of them. Orphans are the point — they are what the reaper cannot see and no
  canvas can show.
- **On an SSH scope the kill routes over the ACTIVE project's master** (`lib/sessionKill.ts` →
  `sshProject.killSessions`), because `transport.destroy(nodeId)` reaches a remote session only
  through a LIVE local client carrying `sshRemote` — which an orphan has not, and neither has a node
  owned by a non-active project. Before this, every orphan row's `×` on an SSH project **promised a
  kill it could not perform**: the local socket was touched, the host's `nt-<id>` kept running, and
  the row came back on the next refresh unexplained. It is safe because it is a **round trip, not a
  lookup** — the row's `nodeId` is literally `session.slice('nt-')` from the sweep and `killSessions`
  maps it back through the same idempotent `sessionName()`, so the exact session name the sweep
  observed is killed on the host it observed it on (node ids are only per-launch unique, and nothing
  here rests on more). Ownership is re-resolved at click time, not taken from the row's stale
  `orphan` flag, so a node created since the sweep is not killed as an orphan.
- **The name and the host were never the hard part — the SOCKET was.** Two nodeterm tmux sockets
  live on one machine at once (`node-terminal` for a nodeterm running ON it, `nodeterm-rmt` for one
  SSH-ing INTO it) and the sweep lists **both**, while the kill targeted one — so every row off the
  other socket got "this stops its tmux session" and a kill that landed nowhere. Not exotic: a host
  running its own `nodeterm-server` while being SSH'd into is exactly that, and the local mirror
  (this machine's panel listing the `nodeterm-rmt` sessions another machine's nodeterm spawned here,
  all orphans locally) is the same shape. A kill that knows only a NAME therefore goes to **every
  socket that name could be on** (`KILL_TMUX_SOCKETS` → `remoteTmuxKillEverySocketArgs` /
  `localKillSockets`), which is safe because tmux's "can't find session" was already the ignored
  case, because the target is **exact** (`-t =nt-<id>`: without `=` tmux falls back to fnmatch then
  PREFIX matching on a miss, and `nt-…-1` is a prefix of `nt-…-12`, so a miss could kill a different
  session), and because the fan-out is **opt-in and asked for by exactly one caller**: it needs both
  "we do not know the socket" AND `everySocket` from the caller (`localKillSockets(live, everySocket)`,
  `sshProject.killSessions(…, {everySocket:true})`, `transport.destroy(id, {everySocket:true})` —
  the wire legs demand a literal `true`). A destroy for a session we HOLD still fires exactly one
  kill; and the unheld branch is not rare — an ordinary node-× on a node never mounted in this
  process takes it, which is the norm after an app restart — so project deletion and every ordinary
  × stay narrow rather than inheriting the panel's blast radius. The sweep and the reaper keep their own copies of
  the socket list **on purpose**: for them the ORDER decides first-wins de-duplication, for a kill
  it means nothing.
- **The generated SSH shell is tested under a real `/bin/sh`** (`session-memory-remote.test.ts`
  against a fake host tree, same discipline as `remote-claude-usage.test.ts` and
  `canvas-control-shim.test.ts`) — and it is not ceremony: the plan's own script said `echo ##MEM`,
  which prints an **EMPTY LINE** under POSIX sh (an unquoted `#` starts a word-initial comment) and
  would have made **every healthy host report `ok:false`**. The markers are quoted for that reason,
  every section header is printed unconditionally (a missing one means the stream was cut short, not
  that the host had nothing), and the socket names + `-F` format come from the shared constants so
  the two legs cannot look at different sockets.
- **Which machine answers** is decided in `session-memory-service.ts` by OR-ing two independent
  claims of remoteness — the renderer's `remote` flag and the shell's `isRemoteProject` — because a
  source that answers "no" while momentarily uninformed (index not loaded, master just dropped)
  would turn a remote query into a LOCAL sweep and publish this machine's sessions under the host's
  name. `sshScopePredicate` answers from **identity, not liveness** (`workspaceStore.sshProjectIds()`
  — a DISCONNECTED SSH project is still someone else's machine), OR-ed with the live masters. The
  `remote` option pair is deliberately asymmetric: `run` is optional, `isRemoteProject` is
  **required** — reading-without-knowing is a compile error.
- **Surfaces.** **Desktop**: full. **Server Edition**: the service runs and the ws-bridge has a REAL
  implementation, so the pill and panel describe the machine the server is served from; an SSH scope
  answers `ok:false` (no ControlMaster injected) and says so **by identity** via `sshScopePredicate`
  rather than trusting the renderer's flag — see docs/SERVER.md, including the silent dependency on
  the boot-time `workspaceStore.load()`. **Relay tabs**: the stub answers `ok:false` and the panel
  says session memory is not available there, which is a different story from a failure. **Kanban**:
  Canvas passes `overBoard={kanbanOpen}` (the same prop `UsageIndicator` takes), raising the pill to
  z 26 over the board's opaque 25, and an open panel to 60; with the board CLOSED the open panel
  still has to clear the sessions sidebar (z 12), which is the separate
  `.sysres-indicator:has(.sessmem-panel) { z-index: 13 }` — both `:has()` rules work only because
  the pill cluster is mounted OUTSIDE `<ReactFlow>`, whose wrapper's inline `z-index: 0` would trap
  any value inside it. **Mobile**: **N/A for v1** — *nodeterm
  mobile* attaches to tmux sessions over the transport protocol and has no per-session host-memory
  concept; adding one means extending that protocol (follow-up in the iOS repo).

**Offscreen release makes the macOS reaper bug far more visible, and the two shipped days apart.**
A node released while offscreen detaches its PTY client — so it becomes a DETACHED tmux session and
joins the reaper's candidate pool once past the 6 h grace. On a Mac reading `os.freemem()` the
watermark was permanently tripped, so those sessions were culled on the next sweep. More automatic
detaching + an always-true pressure signal is why the symptom read as "my sessions keep
disappearing" rather than as an occasional cull. The `vm_stat` reader is what makes the pool safe
again; the grace window was never the thing that was wrong.
