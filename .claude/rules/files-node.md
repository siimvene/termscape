---
paths:
  - "src/renderer/nodes/FilesNode.tsx"
  - "src/renderer/lib/filesNode.ts"
  - "src/renderer/lib/reopenNode.ts"
  - "src/renderer/canvas/toKanbanSession.ts"
---
# files node (`FilesNode.tsx`)

A file-manager node: ONE directory listing (`data.cwd`, persisted), pinned beside the terminals
working in it (not a second Explorer — several give you different dirs at once). Navigate in place,
filter, create file/folder, copy path, reveal, open a terminal in the folder (`nodeterm:open-terminal`).

- **Adds NO new IPC** (existing `FsApi` `list`/`mkdir`/`exists`/`write`), so it works on Desktop,
  Server, SSH and relay tabs day one (`mkdir`/`exists` are LIVE on a relay tab). Rename/move/delete are
  the deliberate v1 gap (each needs an `fs-ops` leaf + IPC + preload + ws-bridge + `ssh-fs` quoting +
  relay host-service + guards).
- **Which filesystem is `EditorNode`'s decision:** `data.sshFs` → the SSH host; else the node's own
  SESSION api (local core, or the PEER's for a relay tab). Reading it off `useSession()` not
  `window.nodeTerminal` is why a relay tab browses the right machine.
- **Opening is delegated** (`nodeterm:open-file`), so editor/video/image routing stays in Canvas's one
  `openFile`. `fileOpenTarget` decides canvas-vs-OS; a REMOTE listing never reaches the OS branch
  (`shell.openPath` opens on THIS machine), which is also gated on being ABLE to open locally
  (`shell.openPath` is a `noop` in Server; a browser session `source` is always `'local'`, so only
  `isBrowserRuntime()` detects a browser) via `canUseLocalShell` — ONE predicate for every `shell.*`
  path action (`canRevealLocally` kept as its older alias; reveal was gated and openPath was not).
- **Empty-vs-unreadable is probed on the PARENT** (`classifyEmptyListing`, pure → `missing`/`empty`/
  `unreachable`/`unknown`), because `FsApi.list` is fail-open (`catch { return [] }`; SSH returns `[]`
  for a dead ControlMaster) and `fs.exists` is `stat`-based. The parent CONTAINS this dir so cannot be
  childless → an empty parent listing is `unreachable` (used to answer `unknown` and render "This
  folder is empty" over a dead ControlMaster). `unknown` is reserved for parents that CANNOT answer (a
  non-`/`-absolute cwd — SSH `remoteCwd` defaults to `~`, whose parent `/` has no `~`; a `.git` cwd;
  `.`/`..`; case-folded match counts present). `missing` must be sure; nothing publishes until the
  verdict is in.
- **The list is stored WITH its cwd**, so a cwd change IS the loading state (before, "Loading…" showed
  only on first mount and later changes showed the previous dir's rows); a re-list after a create keeps
  its rows.
- **Displacement + read guard:** a files node in a removed worktree is displaced by path
  (`displacedByWorktree`, like an editor — no session to disturb). `displacedFilesPatch` returns `null`
  = LEAVE IT ALONE on the dead path (the parent probe tells the truth; `resetDisplacedCwd`'s fallback
  can be `undefined`, which would cost the node the one thing it knows). The READ side is guarded too:
  no `cwd` says so instead of `'/'` (`project.json` is hand-editable). `createFilesNode` places through
  `placeNode` (snap-to-grid applies to size); the title tracks the folder only while `titleAuto` holds.
- **"New terminal here" was broken on BOTH remote kinds:** `createTerminalNode` does `cwd: ssh ?
  ssh.remoteCwd : cwd`, so SSH DISCARDED the on-screen folder (a hole in `addTerminal`'s `cwdOverride`
  contract). Fixed via the existing `nodeSshFor` (handed `cwdOverride`, never the resolved `cwd`). On a
  RELAY tab there is no `ssh` to rebind, so the row is WITHHELD.
- **Creation needs a project dir (`hasCwd`); the row degrades EXPLICITLY** — disabled +
  `FILES_NO_CWD_HINT` on pane/Dock/sidebar (rule #621: a vanished row hides its reason while "Set
  folder…" is one menu away), except **⌘K HIDES it** (a disabled palette row is a dead search result).
  Inside a group frame it inherits a bound worktree's cwd via `cwdForNewNodeIn`.
- **A kind not registered in `lib/reopenNode.ts` is a trap:** every kind must sit in `UNRESTORABLE` or
  a `buildBase` `case`; `files` was in neither, so ⇧⌘T recorded a snapshot `default: return null` could
  never restore (a dead entry that passes tests). `files` now has a `case`; `trigger` is excluded for
  the same reason. Registration is a checklist item.
- **Kanban: not a card** — `toKanbanSession.ts` maps `browser`/`sticky`/`terminal`, `null` otherwise;
  a files node has no session/text, its value is spatial adjacency (a column layout discards it).
- `folderTitle` lives in `lib/explorerCreate.ts` (zero-import leaf), not `lib/filesNode.ts` (which
  imports `isVideoFile` — importing back closes a cycle); re-exported.
- **`/`-separator is a KNOWN gap shared with `explorerCreate`** (`C:\x\y` = one segment): the TRAVERSAL
  half is closed (`newEntryPath` splits `..` on `[\\/]`, refuses Windows-absolute); construction stays
  `/` (a backslash is legal on POSIX). Guard both dialects, construct in one.
- **Mobile:** N/A (no canvas / file-browsing over the transport protocol).
