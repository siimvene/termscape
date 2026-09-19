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
  `lib/addMenuSpec` is the ONE source for which kinds are addable and (since 2026-09) how the two
  `ContextMenu` surfaces GROUP them (`New terminal` · `New remote…` · the account-capable agents ·
  `New agent ▸` · `New view ▸` · `Files ▸` · `Orchestrate ▸`, then the canvas actions). It replaced a
  flat 18-row list: the menu need not be EXHAUSTIVE (⌘K and the keybinding registry already carry a
  remappable command per agent and node kind), it has to be FAST. Four rules hold it:
  - **The submenu depth cap is STRUCTURAL:** `ContextMenu` drops a submenu's `colors`/`submenu`
    children (returns `null`), so a third level vanishes silently. Claude's and Codex's account
    pickers are already level-two, so nesting either behind `New agent ▸` would delete the picker for
    exactly the managed-account users. MEASURED in `ContextMenu.submenu-depth.test.tsx`.
  - **Which agent rows stay first-level is DERIVED, never a spelled-out id** (`isPinnedAgentEntry`): a
    row that IS a submenu, or whose agent is in `ACCOUNT_CAPABLE_AGENT_IDS` (the list `boundAccountId`
    reads). Otherwise the menu would rearrange itself as the user adds/removes accounts.
  - **`ADD_ITEM_GROUP` is a total `Record` over the kind union** — a new `AddItem` kind is a compile
    error until routed. `remote` stays top-level (it is not an agent; burying the one SSH entry point
    under "New agent" hides it).
  - **Grouping is a rearrangement, not a filter:** a nested row keeps its `disabled`/`hint` (e.g.
    `New worktree…` greyed with `WORKTREE_SSH_HINT` inside `Orchestrate ▸`). Per surface — pane
    right-click + sidebar "+" share `buildGroupedAddMenu`; the group-frame menu shares the agent half
    + its own content rows; the **Dock stays FLAT**; the kanban "+ New session" is NOT a consumer
    (`KanbanCreateChoice` is a closed union of card-able kinds). `addMenuSpec.surfaces.test.ts` pins
    all four.
- **Undo/redo**: debounced snapshot of the nodes array on settle (drag/edit), `pastRef`/
  `futureRef` stacks, ⌘Z / ⌘⇧Z + dock buttons. History resets per project load; skipped
  while typing in inputs/terminals.
- **Selection/pan**: box-select on left-drag (`SelectionMode.Partial` — touch to select);
  pan = middle-drag or trackpad two-finger (`panOnScroll`, `zoomOnScroll:false`); pinch
  zoom. Right mouse is free for the context menu.
- **Edges** are all one React Flow type, `floating` (`canvas/FloatingEdge.tsx` over the pure
  `lib/floatingEdge.ts`): every family (ropes, context bridges, note links, subagent/loop and trigger
  edges) is drawn between the midpoints of the two nodes' facing sides, so an edge to a node left of
  or above its source takes the short way and meets the node at ONE point. Context and note links are
  the exception: they anchor only left/right (`data.anchor: 'horizontal'`), where the
  `link-out`/`link-in` handles are. A terminal node's **eye** (`hide-fanout`) hides its subagent/loop
  cards AND every edge touching it — display only: the links still authorise reads and an `--after`
  still waits. Desktop + Server Edition identical (pure renderer); kanban and mobile N/A.
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
  **`frameNode` computes the viewport itself and applies it with `setViewport`; it must NEVER call
  `fitView`.** In `@xyflow/react` 12 `fitView` is DEFERRED — it parks `fitViewQueued` and resolves on
  a later `setNodes` (only while `nodesInitialized`) or `updateNodeInternals`, against whatever
  `nodeLookup` holds by then. The **webview keep-alive ghosts** (`display:none`, no width/height,
  deliberately not `hidden`) hold `nodesInitialized` false FOREVER (`.claude/rules/nodes.md`), so a
  queued fit never resolves on time; after a project switch the target id has left the lookup, the fit
  set comes out EMPTY, bounds collapse to `{0,0,0,0}` and `getViewportForBounds` parks the world
  ORIGIN at max zoom — which `onMove` then PERSISTS into the project's machine-local viewport.
  Cross-project focus (load + focus in one tick) hits this every time; the second click works, which
  is what makes it read as intermittent.
  - **Geometry (`renderer/lib/nodeFocus.ts`):** the rect is React Flow's own measurement when it has
    one (`getInternalNode`; `measured` reaches OUR node objects one render later via `onNodesChange`,
    `internals.positionAbsolute` resolves the group chain + `extent:'parent'`), else `nodeFitRect`
    from the PERSISTED size walking the parent chain. Then `viewportForRect`: **centred in the pane,
    nothing else.** Framing against the chrome-free rectangle was tried twice and is wrong both ways
    (centred IN it: too far right on an ultrawide, half off on a laptop; centred in pane then nudged
    clear: still not the middle), because `.sessions-sidebar` is a 300px absolute OVERLAY open exactly
    when this is used. The couple of dozen px behind the sidebar cost less than the centre. The
    free-rect solve stays in `fitAll` (below), which fits EVERY node and would tuck them under the dock.
  - **ONE exception, not a walk-back (issue #743): a MAXIMIZED node** (`isMaximized` —
    `data.premaxRect`) is framed against the rectangle its own placement used, via
    `measurePinnedInsets(box)` → `viewportForRect`. The trade-off above rests on one number — how much
    of the node ends up behind the panel — and for a maximized node that number is set by the PANEL by
    construction: `maximizeTargetRect` sized it to be *exactly* the free area, so centring it in the
    wider pane buries half the inset. Measured (signed v0.3.5, sidebar pinned): an ordinary node lost
    33px, the maximized one 137px, the camera drifting `322 / 2 = 161`px per round trip. With no pinned
    panel `insets` is zero and it is a no-op; a pane narrower than its panels falls back to the whole
    pane. `measurePinnedInsets` reads the DOM, so it is asked only for a node that can use the answer.
  - **`settings.focusZoomToNode`** (Behavior, default ON) is the rescale escape hatch: off, the camera
    keeps the zoom `getZoom()` reports and only pans, and that zoom is passed **unclamped** (it is one
    the canvas already shows; re-clamping it to the framing range would rescale the view the option
    exists to leave alone).
  - **Finite guards:** every rect and computed viewport is finite-checked in `viewportForRect` /
    `viewportForRectPadded` (and the absolute position in `nodeFitRect`), because `setViewport({x:
    NaN, …})` is accepted without complaint — a blank, unpannable canvas that `onMove` then persists.
    Node positions arrive from a git-shared `.nodeterm/project.json` and from peers, neither validated
    upstream; `Number.MAX_VALUE` is finite going in and only overflows at the zoom multiply. No rect /
    no pane ⇒ the camera **stands still**; never "helpfully" fall back to a bare `fitView` there —
    that IS the origin jump.
- **`fitAll` is imperative for the same reason, so NOTHING in Canvas queues a fit.** It takes the
  bounds of the non-ghost nodes (`getNodesBounds`, which also counts a real node React Flow has not
  measured yet — the old explicit-ids fit set dropped those), the `solveFitPadding` insets or a 0.1
  ratio against the current chrome layout, and the canvas's own `CANVAS_MIN_ZOOM`/`CANVAS_MAX_ZOOM`
  (a fit-all must out-zoom the single-node clamp) → `setViewport(…, {duration:300})`. A canvas with no
  non-ghost node **stands still**. `canvas-wiring.test.tsx` scans the WHOLE file for `fitView(` — prose
  here writes it without the paren on purpose — and pins that both `frameNode` and `fitAll` contain none.
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
  desktop/server/SSH (`core/fs-ops.ts`, `main/ssh-fs.ts`). **Relay tabs are NOT degraded** — their
  `fs` routes to the peer's core (`fsOps.makeDir`/`pathExists`), so both verbs are live there; only
  the legacy PHONE vocabulary (`main/remote/host-service.ts`) lacks `fs.mkdir`/`fs.exists`, which fall
  through to its dispatcher's `Unknown method` rejection.
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
