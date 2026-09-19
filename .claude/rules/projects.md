---
paths:
  - "src/renderer/state/projects*.ts"
  - "src/renderer/state/reopenHistory.ts"
  - "src/renderer/components/TabBar.tsx"
  - "src/renderer/components/WelcomeScreen.tsx"
  - "src/renderer/components/SessionsSidebar.tsx"
  - "src/renderer/components/SessionRow.tsx"
  - "src/renderer/lib/projectOpen.ts"
  - "src/renderer/lib/projectCloseSessions.ts"
  - "src/renderer/canvas/Canvas.tsx"
  - "src/renderer/lib/closedHistory.ts"
  - "src/renderer/components/ClosedHistorySection.tsx"
  - "src/renderer/components/ClosedTranscriptDialog.tsx"
  - "src/shared/project-name.ts"
---
# Projects (tabs): switch, close/park, reopen, delete, open-folder recovery

> Moved verbatim from the root `CLAUDE.md` on 2026-09-01 (see its "How this documentation is
> organized" section). Loads automatically when a file matching the `paths` above is read;
> when the root routing table points here, read this file before touching the subsystem.
<!-- moved-verbatim-from: CLAUDE.md -->

## Projects (tabs)

Each project is one canvas/page; terminals and notes belong to a project. The `projects`
zustand store (`renderer/state/projects.ts`) holds project metadata + the *serialized* nodes
of all projects. **React Flow remains the single live source of truth for the *active*
project's nodes only.** The contract:

- The active-project effect in `Canvas.tsx` (keyed on `activeProjectId`) loads that project's
  serialized nodes into React Flow. `loadingRef` suppresses dirty-marking during this load.
  A real switch applies the project's saved viewport; an **in-place reload**
  (`reloadActiveProject` — external file change / SSH reconcile) sets `preserveViewportRef` so
  the load **keeps the user's current camera** — the incoming file's viewport is wherever
  another machine last saved, and restoring it mid-work teleported the camera (most visibly
  right after a cross-project sidebar focus, when the connect-time SSH reconcile landed a
  second after fitView centered the node).
- **Project order = array order**, and it is ONE order shared by the tab bar and the sessions
  sidebar (the sidebar no longer hoists the active project to the top). Both surfaces reorder
  via drag-drop through `reorderProject(draggedId, beforeId|null)` (null = to the end; tab
  strip empty area and sidebar body are the end-drop zones), persisted like any node reorder.
  Sidebar disclosure is **persisted**, for group frames as well as projects:
  `settings.sidebarCollapsedItems` maps `project:<id>` / `project:<id>:group:<groupId>` → collapsed
  (`isGroupCollapsed`), and `settings.sidebarAutoCollapse` (default on) now only supplies the
  DEFAULT for a project row nobody has toggled (on = active expanded / others collapsed, off =
  everything expanded). **This deliberately replaced the old "a project switch resets every manual
  toggle" effect** (2026-08, with the nested sidebar tree): a tree the user shaped by hand should
  still be that shape after a restart, and one transient rule for projects plus a sticky one for
  frames would have been two contracts in one list. `projectHeadClickAction` is unchanged — an
  inactive project row switches, the active one toggles its own (now persisted) collapse — and
  every write **prunes** keys that no longer address a live project/frame (`pruneCollapsedItems` /
  `liveCollapseKeys`), because settings.json is forever and a canvas churns through group ids.
- The bottom-left **canvas lock** freezes the CAMERA only (pan/zoom): nodes stay draggable,
  resizable and connectable while locked — the point is "stop the map sliding", not "freeze
  the work".
- Before any project switch / add / delete, `commitActiveToStore()` serializes the live
  React Flow nodes back into the store, so nothing is lost. Then disk is written.
- Switching away unmounts the old project's `TerminalNode`s → their tmux clients detach but
  the sessions keep running; switching back reattaches. tmux session names are per-node-id
  (globally unique), so projects never collide.
- The tab caret menu's **Close project** (`closeProject`) is **non-destructive**: it sets
  `project.closed = true` (hidden from the tab bar, kept on disk with all nodes) and leaves the
  tmux sessions running, so closing just detaches like a project switch. Closed projects are
  reopenable from the **"Recently closed"** list on `WelcomeScreen` (`reopenProject` → restores
  nodes, which reattach warm or cold-restore). `hasProjects` counts only **open** projects, so
  closing the last open one shows the welcome screen. **Permanent** deletion (`deleteProject`:
  `transport.destroy(nodeId)` per terminal + drop agent status + SSH teardown) now only happens
  via the `×` on a "Recently closed" entry. **Closing now SAYS what it parks** (issue #442 —
  "close" read like cleanup while meaning "hide, and keep running"): a project with terminal
  nodes gets a confirm naming the count, with an opt-in **"end its sessions too"** checkbox
  (default OFF — parking stays the rule; checked flips the confirm to danger). The pure half is
  `renderer/lib/projectCloseSessions.ts`: **one definition of N** — the project's terminal-kind
  nodes, exactly the set the action addresses (`transport.destroy` is idempotent on a dead
  session), never a liveness-verified count that could disagree with the action; the END happens
  at confirm time against the re-resolved node set (agents spawn nodes on their own). A relay tab
  or a 0-terminal project closes silently (byte-identical old path). `endProjectSessions` mirrors
  `deleteProject`'s teardown EXCEPT it keeps agent status (the persisted sessionId is what lets a
  reopen cold-restore `--resume`) and never disconnects SSH masters (close never managed the
  connection). The `×` also confirms now, via `deleteConfirmCopy` — a relay tab gets "removes
  only this machine's view; reconnecting brings it back" with no danger styling (deleting the
  view is what turns the next connect into a first-connect re-adopt), local/SSH get the session
  count + "the folder (incl. .nodeterm/project.json) is not deleted". And "Recently closed" rows
  show a **live-session badge** (`closedSessionCounts` over ONE on-demand local
  `sessionMemory.read` per welcome-screen appearance — never a timer; `ok:false` ⇒ no badge,
  never "0"; an SSH project's host-side sessions are deliberately not claimed by the local
  count). Server Edition: all renderer-side; the ws-bridge `sessionMemory` is real, so badges
  describe the server machine; the `sshProject` legs only run for `project.ssh`, which that
  shell never has.
- **Closing a NODE keeps a pointer to its transcript** (issue #531). The per-project
  `closedSessions` ledger records the agent session id as `ClosedSessionEntry.sessionId`, captured
  at delete time from the live `agentStatus` entry — which that same delete drops, so this is the
  last instant it exists anywhere — falling back to the minted `node.agentSessionId`. It is a
  POINTER, never a copy: the `.jsonl` the agent CLI owns stays the only text, and a second store of
  transcript text would age, drift and need its own retention policy. The "Recently closed" row
  spends it on the **existing ⌘M reader** (`ChatPanel` in `readOnly` mode, hosted by
  `ClosedTranscriptDialog`), so resolution, the `{found}` vs empty distinction and Retry cannot
  drift from the live-node path. Two rules: it rides `IndexEntryV3.closedSessions` and is therefore
  **machine-local** — a session id is a `$HOME`-anchored fact about one person's machine, and
  `projectToFile` must never emit it — and it is **re-checked as a string** in
  `sanitizeLoadedClosedSessions`, because workspace.json is hand-editable and the value goes
  straight to a resolver. `closedTranscriptTarget` (pure) owns the refusals and NAMES each: a
  REMOTE session is refused (its transcript is on the host; locating it over the ControlMaster is
  separate work and must not hold the local fix hostage) and a pre-#531 entry says its id was never
  recorded. Only the "this was never an agent" refusal may render as nothing — for the others a
  vanished control would leave the user believing that closing destroyed the record, which is the
  belief this exists to correct.
- A project's `cwd` (folder picker, `dialog:select-folder`) is passed to terminal/Claude
  node factories so new terminals open there. **Folder ↔ project is deduped:** "Open folder…"
  reuses the existing project with that `cwd` (and its nodes) instead of creating a duplicate.


---

## Upstream v0.3.7 merge additions (9e76faf84a5f..upstream/main (v0.3.7))

> Appended verbatim during the v0.3.7 upstream merge (2026-09-20). Upstream keeps ONE CLAUDE.md;
> the fork keeps this subsystem's deep reference in this rule file, so its new material lands
> here rather than re-inlining the root. New/changed text only; `[~ replaced N base line(s)
> here]` marks where upstream reworded text this file already carries above — reconcile at leisure.

### From CLAUDE.md § Projects (tabs)

    [~ replaced 1 base line(s) here]
  the work". It is **transient by default and opt-in to remember**: a lock that survives a
  restart reads as "the app is frozen" to whoever opens the app next, and the lit button is a
  small thing to spot, so `settings.rememberCanvasLock` (Behavior, default OFF) is what turns it
  into a preference. The bit itself lives in localStorage (`nodeterm.canvasLocked`,
  `renderer/lib/canvasLock.ts`) beside the view mode and the explorer pin, never in settings.json
  and never in the git-shared `project.json`: the SETTING says whether to remember, the lock is
  one person's view state. Note the two tiers differ per surface: on Desktop both are
  machine-local, but in the **Server Edition** the setting rides that server's settings.json
  (shared by every browser hitting it) while the bit is per browser PROFILE, so two profiles can
  legitimately disagree about the lock. Desktop + Server Edition; **Mobile: N/A** (no canvas).
  It is one GLOBAL bit rather than per-project
  because `<Canvas />` is mounted once and is not keyed by project, so the lock always carried
  across project switches within a session. Restore is gated on settings HYDRATION (Canvas mounts
  first, so a `useState` initializer would read the default and the opt-in would silently never
  work) and latched to the first run, so switching the setting on mid-session never reaches into
  storage and locks a canvas somebody is working on.

