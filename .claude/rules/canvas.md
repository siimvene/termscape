---
paths:
  - "src/renderer/canvas/Canvas.tsx"
  - "src/renderer/components/ContextMenu.tsx"
  - "src/renderer/components/Dock.tsx"
  - "src/renderer/components/CommandPalette.tsx"
  - "src/renderer/components/ExplorerPanel.tsx"
  - "src/renderer/components/SessionsSidebar.tsx"
  - "src/renderer/components/SessionRow.tsx"
  - "src/renderer/components/WelcomeScreen.tsx"
  - "src/renderer/components/ShortcutsPanel*.tsx"
  - "src/renderer/components/ConfirmDialog.tsx"
  - "src/renderer/components/settings/**"
  - "src/renderer/lib/breadcrumbs.ts"
  - "src/renderer/lib/nodeFocus.ts"
  - "src/renderer/lib/zoom*.ts"
  - "src/renderer/lib/ui-visibility.ts"
  - "src/renderer/lib/explorerPin.ts"
  - "src/renderer/state/explorer.ts"
  - "src/renderer/styles.css"
  - "src/renderer/canvas/zoom-limits.ts"
  - "src/renderer/lib/gridSnap.ts"
  - "src/renderer/lib/resizeSnap.ts"
  - "src/renderer/lib/pinnedInsets.ts"
  - "src/renderer/lib/sidebarFilter.ts"
  - "src/renderer/lib/explorerCreate.ts"
  - "src/renderer/bridge/dialog-picker*.tsx"
---
# Canvas interaction & panels: menus, undo, zoom, goToNode, breadcrumbs, palette, sidebar, explorer, settings, theme

> Moved verbatim from the root `CLAUDE.md` on 2026-09-01 (see its "How this documentation is
> organized" section). Loads automatically when a file matching the `paths` above is read;
> when the root routing table points here, read this file before touching the subsystem.
<!-- moved-verbatim-from: CLAUDE.md -->

## Canvas interaction & panels (`Canvas.tsx` is the hub)

- **Context menus** (`components/ContextMenu.tsx`, portal, icons from `components/icons.tsx`):
  pane right-click = add nodes at cursor (terminal / Claude / sticky / open file) + select
  all + fit + **Tidy canvas** (`arrangeAllNodes` — packs every top-level node, including group
  frames as rigid units, into a non-overlapping grid via `arrangeNodes`, sorted by current
  (y, x) so the pack roughly preserves reading order; mirrored in ⌘K as "Tidy canvas" and in the
  keybinding registry as `canvas.tidy` (default ⌘/Ctrl+Shift+A, remappable); both
  hidden below 2 top-level nodes, where it could only be a visual no-op that still writes
  `project.json`) + restart-idle-agents (the bulk in-place agent restart, mirrored in ⌘K; both
  hidden when the canvas holds no restartable agent node, where they could only report "0
  restarted");
  node/selection right-click = group, color, duplicate, align-to-grid, collapse,
  markdown-view (terminals), refresh-terminal (terminals — bumps `respawnNonce`: fresh PTY attach
  to the SAME tmux session; manual recovery for a stuck/unpainted terminal, and the same action
  sits in the node header as `term-node__refresh` since a dead view is a bad place to hunt for a
  right-click; nothing running is interrupted), restart-agent
  (single agent node — the in-place CLI restart in `.claude/rules/terminal.md`; absent for a CLI we cannot quit + resume,
  disabled with a hint while the session is busy or has no id yet), delete. Actions live
  in `Canvas.tsx`, operate on `targetIds`. The non-destructive rows are user-hideable from
  **Settings → Appearance** ("Node menu items" / "Terminal header buttons"), stored as HIDDEN
  lists in `settings.hiddenNodeMenuItems` / `settings.hiddenHeaderButtons` (empty = everything
  shows). `lib/ui-visibility.ts` owns the two inventories and `isHidden`, which only answers for
  ids it knows — so Delete, restart-agent, branch/transfer, terminal Search and Close can never
  be hidden, whatever settings.json says. The group-frame menu's colors strip answers to the same
  `colors` id; builders run through `tidySeparators` so a hidden row leaves no dangling rule.
- **Add menu** = bottom dock (`Dock.tsx`) `+`, mirrored by the pane menu and command palette.
- **Undo/redo**: debounced snapshot of the nodes array on settle (drag/edit), `pastRef`/
  `futureRef` stacks, ⌘Z / ⌘⇧Z + dock buttons. History resets per project load; skipped
  while typing in inputs/terminals.
- **Selection/pan**: box-select on left-drag (`SelectionMode.Partial` — touch to select);
  pan = middle-drag or trackpad two-finger (`panOnScroll`, `zoomOnScroll:false`); pinch
  zoom. Right mouse is free for the context menu.
- **Delete** (Delete/Backspace) opens `ConfirmDialog` before removing selected nodes.
- **Zoom chords** (`renderer/lib/zoomShortcut.ts`): **⌘/Ctrl+0 → `zoomTo100`** (actual size — what
  the browser AND Electron's default View menu already mean by that key) and **Shift+1 → `fitAll`**
  (the Figma/tldraw/Excalidraw "zoom to fit"). Matched on `e.code`, like the project-jump chord,
  which excludes `Digit0` so the two can never collide. The module is a PURE decision because both
  chords move the camera and a camera move here is not read-only — `onMove` → `markDirty` persists
  the viewport and casts it to the team session — so it refuses while the kanban board is up and
  while focus is in a text surface (input/textarea/contenteditable/Monaco/xterm, where Shift+1 is
  just the `!` key), and on auto-repeat (both actions animate; a held chord would restart the tween).
  Desktop ⌘0 does NOT arrive as a keydown: the default menu's `resetZoom` accelerator wins, so
  `main/index.ts` intercepts it in `before-input-event` and forwards `app:zoom-actual-size`, which
  re-asks the same refusals. Server Edition needs no intercept (no menu; Chrome/Firefox hand ⌘0 to
  the page) and stubs the subscription.
- **"Go to node" (`goToNode` → the single `frameNode`)** — the one camera-travel path (notification
  click, sessions sidebar, ⌘K jump, presence travel, minimap double-click, double-click focus).
  **`frameNode` NEVER calls `fitView`**; both its cases compute the framing themselves and drive the
  camera imperatively with `setViewport`, and "simplifying" it back to `fitView({nodes:[{id}]})`
  reintroduces the origin jump. Why: in `@xyflow/react` 12 `fitView` is **DEFERRED** — it only parks
  `fitViewQueued` + `fitViewOptions` in the store and resolves on a later `setNodes`, and **only
  while `nodesInitialized === true`**, which this canvas can never be relied on to be: the **webview
  keep-alive ghosts** sit in the `<ReactFlow nodes>` prop with `display:none`, no width/height and
  deliberately not `hidden` (a hidden node unmounts the guest — see `.claude/rules/nodes.md`), so
  React Flow's ResizeObserver never measures them and `adoptUserNodes` keeps `nodesInitialized`
  false forever. [MEASURED 2026-09-02, while `frameNode` used `fitView`] the click moved the camera
  **not at all** ("I have to scroll to the node myself"), and the fit stayed queued until some
  unrelated `updateNodeInternals` — frequently after a project switch, by which point the target id
  has left `nodeLookup`, so `getFitViewNodes` returns an **EMPTY** set (it filters by `measured` and
  by the option ids), `getInternalNodesBounds` collapses to `{0,0,0,0}` and `getViewportForBounds`
  divides by zero ⇒ **maxZoom (138%) centred on the world ORIGIN**: empty canvas, the node alone in
  the far minimap corner — which `onMove` then **persists** into the project's machine-local
  `viewport`, so every later activation of that project re-lands there. So `frameNode` picks the
  rect (React Flow's own measurement when the store has one — `measuredFitRect`, whose
  `internals.positionAbsolute` already has the group chain resolved — otherwise the node's PERSISTED
  size via `nodeFitRect`, which walks the parent chain itself) and runs ONE path from there:
  `solveFreeRegion` → `viewportForRect` → `setViewport(…, {duration:300})`, which is synchronous and
  has no call→resolve window the target can vanish from. The measured check still reads React Flow's
  **store** (`getInternalNode`), not our node object — `measured` reaches our state one render later
  (via `onNodesChange`), so our copy lies about nodes the store has long sized; the persisted case is
  the first tick after a project loads, i.e. every **cross-project** focus (load and focus in the
  same tick). Unknowable size / no pane yet ⇒ the camera **stands still**; never fall back to a bare
  `fitView` there, that IS the origin jump. Pinned by `canvas-wiring.test.tsx` ("frameNode never
  uses the DEFERRED fitView") plus the `measuredFitRect` geometry tests in `nodeFocus.test.ts`.
  `fitAll` still uses `fitView` on purpose — it frames everything and guards the empty-node case
  explicitly, so a late resolve there is harmless rather than a teleport.
- **Breadcrumb trail** (`renderer/lib/breadcrumbs.ts` — all the pure logic lives there) — every
  deliberate `goToNode` landing records a `NavStop` ({nodeId, at, note}) for the ACTIVE project, and
  **Cmd+[ / Cmd+]** (`canvas.goBack` / `canvas.goForward`, bound in `shared/keybindings.ts`) plus the
  two Dock buttons walk that trail; on a project activation a once-per-app-run **`ResumeCard`** offers
  the last few distinct stops ("resume where you left off") — **opt-in via
  `settings.showResumeCard` (Settings → Appearance, default OFF)**: while disabled the
  once-per-app-run slot is not spent, so enabling it later still shows the card on the next
  activation; the chords/Dock buttons work regardless. Load-bearing facts:
  - **The trail is MACHINE-LOCAL and rides `IndexEntryV3.breadcrumbs`, never `.nodeterm/project.json`** —
    the same tier as `viewport` / `defaultAccountId` / `capabilityAck`, for the same reason: a repo must
    not carry one person's camera history to everyone who clones it. `fileToProject` therefore ignores a
    `breadcrumbs` field found in the shared file (a forgery), and `projectToFile` never writes one.
  - **The cursor is not persisted either.** Only `list` rides the entry; `BreadcrumbState.index` is
    renderer-only and resets to the tip on activation. A step records no breadcrumb and rewrites no
    `project.json` — the only persistence it triggers is the ordinary `onMove` viewport persist
    (machine-local, same as any camera move; see the Zoom-chords bullet).
  - **Cap 20** (`BREADCRUMB_CAP`, oldest dropped) and a **3 s dedupe** (`BREADCRUMB_DEDUPE_MS`, so a
    re-triggered focus on the already-current node is a no-op — `recordBreadcrumb` returns the SAME
    object, which is the caller's skip test). Recording past a back-step drops the forward tail, exactly
    like a browser tab.
  - **`stepBreadcrumb` skips stops whose node is gone** (never lands on a dead entry; no reachable stop
    ⇒ `null` ⇒ the camera stands still), and `goToNode` **refuses to record ephemeral `subagent` / `loop`
    nodes**: they are merged into the `<ReactFlow nodes>` prop but never persisted (cleared on the next
    turn), so a breadcrumb for one is an id nothing can ever resolve, burning a slot forever.
  - The `note` is a **snapshot** taken at record time (agent nodes reuse the sessions sidebar's own
    `sessionStatusKind` + `STATE_LABEL` phrasing, preferring session name → node title → agent label), so
    a later state change never retroactively rewrites history.
  - **Surfaces:** Server Edition works as-is (shared renderer code + `WorkspaceStore`, which both
    shells boot — no new bridge member); mobile is N/A (no canvas, no camera); the kanban board is
    likewise N/A, and a project that activates ON the board neither shows nor spends its
    once-per-run resume card (it would sit invisible under the opaque overlay).
- **Command palette** (`CommandPalette.tsx`): ⌘/Ctrl+K; `Canvas.buildCommands` (create,
  switch project, jump to node by title/tag, open file…).
**The sessions list marks the CANVAS SELECTION** (`SessionRowVM.selected` → `.ss-row.is-active`,
2026-08-28). `.ss-row.is-active` existed in `styles.css` from the start but **nothing ever set the
class on a row** — `is-active` reached only `.ss-tab` and `.ss-group` — so the list never showed
which agent you were looking at, and a dead rule read as a working feature to everyone who grepped
it. Selection rides the existing `liveActiveNodes` memo (which already recomputes on every `nodes`
change, so carrying `n.selected` is free) and is therefore **only ever true for the ACTIVE
project**: every other project's rows come from the serialized store, which holds no selection.
That asymmetry is correct — one canvas, one selection — so do not "fix" it by persisting selection.
Accepted edge (consort, ACKNOWLEDGED not fixed): during the documented one-render project-switch
window React Flow still holds the OUTGOING project's nodes while `activeProjectId` is already the
incoming one, so a selected row can flash under the wrong project header for a frame. Cosmetic and
self-correcting on the next render; guarding it would mean threading ownership through the memo.

- **Explorer** (`ExplorerPanel.tsx`, 🗂 / ⌘⇧E): lazy file tree of the active project `cwd`
  (`fs:list`); click a file → opens an editor node; right-click → Copy Path / Reveal /
  **New File… / New Folder…** (empty-area right-click targets the root; SSH projects create on the
  host). Canvas pane right-click and ⌘K also expose **New file…** (creates under the project cwd,
  opens an editor node). These use `mkdir` + `exists` added to `FsApi`/`SshFsApi` across
  desktop/server/SSH (`core/fs-ops.ts`, `main/ssh-fs.ts`; relay remote-fs degrades to `false`).
  Expanded dirs **persist per project** across drawer close + app restart (`state/explorer.ts`
  zustand store, localStorage `nodeterm.explorerExpanded`). The header pin docks it like the
  sessions sidebar (`lib/explorerPin.ts`, `nodeterm.explorerPinned`, default off): overlay
  click-outside closes the modal only, and a pinned overlay is `pointer-events: none` so it
  cannot steal canvas clicks. × is a transient hide and does not clear the pin. Pinned z-index
  is 26 so the tree stays visible on the kanban board with the controls cluster. Desktop +
  Server Edition (personal `localStorage`). Mobile companion: N/A — no explorer there. Source
  Control stays a modal.

- **Settings** (`SettingsPage.tsx`, ⚙ / ⌘,): font/cursor (live to xterm + Monaco), default
  shell, grid + snap, **default node size** (`defaultNodeWidth`/`defaultNodeHeight` — new
  terminal/agent nodes only, clamped in `terminalNodeSize()` in `state/workspace.ts`),
  pan-hover delay, double-click focus, accent, tmux on/scrollback, commit agent,
  `seenShortcuts`.
- **Shortcuts** (`ShortcutsPanel.tsx`, ? / ⌘/): shown once on first launch (`seenShortcuts`).
  **Derived from the registry, never hand-listed** — see the Keybindings invariant below.
- **Welcome** (`WelcomeScreen.tsx`): shown when no projects exist.

- **Theme**: macOS dark palette as CSS tokens in `styles.css` `:root` (`--accent` = systemBlue,
  label/separator opacities, SF font stack). Canvas background is black with dot grid.
