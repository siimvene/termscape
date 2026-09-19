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
  `fitView` there, that IS the origin jump.
  - **The two rect sources consume the chrome solve DIFFERENTLY, and that is not a wart.** The
    measured case passes `solveFitPadding`'s **directional pixel insets** against the **full pane**
    to `getViewportForBounds` — byte-identical to the fit it replaced, because that is exactly what
    the old `fitView` call did (`...FIT_NODE_OPTIONS` with `padding` overridden). The persisted case
    frames inside the **free region** with the flat 0.2 ratio, as it always did. They are NOT
    interchangeable: xyflow's numeric padding is a proportional inset applied **on top of** the
    bounds, so reducing the pane to the region AND passing 0.2 pays both, and its asymmetric path
    pushes the rect flush against the reserved edge rather than centring it in the remainder.
    [MEASURED: a 600×400 node at abs {5050,260}, 1280×900 pane, 400px pinned sidebar — old/correct
    `{x:-6569, y:-184.8, zoom:1.38}` vs region+ratio `{x:-5621.67, y:-105.07, zoom:1.2067}`, i.e.
    12% smaller and 20px off.] Pinned numerically, with the derivation, in `nodeFocus.test.ts`.
  - **Every rect and every computed viewport is finite-checked in `viewportForRectPadded`** (and the
    absolute position in `nodeFitRect`), because `setViewport({x: NaN, …})` is accepted without
    complaint — a blank, unpannable canvas that `onMove` then persists. Node positions arrive from a
    git-shared `.nodeterm/project.json` and from canvas peers, and neither is validated upstream;
    `Number.MAX_VALUE` is *finite* going in and only overflows at the zoom multiply, which is why
    both ends are checked. No rect / no viewport ⇒ stand still.
- **`fitAll` is imperative for the same reason, so NOTHING in Canvas queues a fit.** xyflow keeps
  **one global `fitViewQueued` slot** and nothing cancels it, so a fit-all queued while a ghost
  holds `nodesInitialized` false outlives the gesture: it resolves on some later
  `updateNodeInternals` and overrides a node focus that had already landed — and across a project
  switch its explicit old-project ids leave an empty fit set, i.e. the same origin jump, persisted
  by `onMove`. It now takes the bounds of the non-ghost nodes (`getNodesBounds`, which also counts a
  real node React Flow has not measured yet — the old explicit-ids fit set dropped those),
  `solveFitPadding` insets or the 0.1 ratio, and the canvas's own `CANVAS_MIN_ZOOM`/`CANVAS_MAX_ZOOM`
  (a fit-all must out-zoom the single-node clamp) → `setViewport(…, {duration:300})`. A canvas with
  no non-ghost node **stands still**: the old bare-`fitView` fall-through was a no-op only when
  React Flow's WHOLE lookup was empty, and with a ghost parked at the origin it fit an *empty
  filtered* set instead. `canvas-wiring.test.tsx` scans the WHOLE file for `fitView(` — prose there
  and here writes it without the paren on purpose.
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


---

## Upstream v0.3.7 merge additions (9e76faf84a5f..upstream/main (v0.3.7))

> Appended verbatim during the v0.3.7 upstream merge (2026-09-20). Upstream keeps ONE CLAUDE.md;
> the fork keeps this subsystem's deep reference in this rule file, so its new material lands
> here rather than re-inlining the root. New/changed text only; `[~ replaced N base line(s)
> here]` marks where upstream reworded text this file already carries above — reconcile at leisure.

### From CLAUDE.md § Canvas interaction & panels

  `lib/addMenuSpec` is the one source for WHICH kinds are addable, and since 2026-09 also for how
  the two `ContextMenu` surfaces GROUP them: `New terminal` · `New remote…` · the account-capable
  agents · `New agent ▸` · `New view ▸` · `Files ▸` · `Orchestrate ▸`, then the canvas actions. It
  replaced a flat 18-row list, on the rationale that ⌘K already makes every one of these
  searchable and the keybinding registry already carries a remappable command per agent and per
  node kind (`node.new*`) — so this menu does not have to be EXHAUSTIVE, it has to be FAST.
  Four rules hold it together, and the first is the one that is easy to get wrong:
  - **The submenu depth cap is STRUCTURAL.** `ContextMenu` renders a submenu's children with
    `if (child.type === 'colors' || child.type === 'submenu') return null` — a third level is
    dropped with no error and nothing on screen. Claude's and Codex's **account pickers are already
    level-two submenus**, so nesting either row behind `New agent ▸` would silently delete the
    account picker for exactly the users who have managed accounts. MEASURED, not assumed, in
    `components/ContextMenu.submenu-depth.test.tsx`; teach the component a third level and that
    test goes red so the pin can be reconsidered deliberately.
  - **Which agent rows stay at the first level is DERIVED, never a spelled-out agent id**
    (`isPinnedAgentEntry`): a row that IS a submenu (structural, per above) **or** whose agent is in
    `ACCOUNT_CAPABLE_AGENT_IDS` (`shared/agents/account-binding.ts` — the same list `boundAccountId`
    reads, so a third agent gaining managed accounts cannot light up one and not the other). The
    second half exists because rule one alone would move Codex in and out of the submenu as the
    user adds or removes accounts, and a menu that rearranges itself is a menu nobody can learn.
    A new builtin agent joins `New agent ▸` by itself; one that gains accounts is promoted by itself.
  - **`ADD_ITEM_GROUP` is a total `Record` over the kind union on purpose** — a new `AddItem` kind
    is a compile error until somebody routes it, instead of silently landing in one bucket forever.
    `remote` stays top-level because it is not an agent: burying the one SSH-session entry point
    under a menu named "New agent" puts it where nobody would look.
  - **Grouping is a rearrangement, never a filter, and a nested row keeps its REASON.** The rows
    still come from `contentAddItemsToMenuItems`, so `New worktree…` is greyed with
    `WORKTREE_SSH_HINT` inside `Orchestrate ▸` exactly as it was at the top level (the cap drops
    nested submenus, never a leaf's `disabled`/`hint`). Tests pin that nothing becomes unreachable.
  **Per surface**: the pane right-click and the sessions-sidebar project-header "+" share the
  grouped tree (`buildGroupedAddMenu`); the **group-frame** menu shares the agent half
  (`agentEntriesToMenuItems`) and keeps its own three content rows; the **Dock stays FLAT** (its
  popup is opened deliberately, it already omits terminal + remote, and its agent flyouts are
  bespoke JSX — grouping it means a second submenu implementation for crowding nobody reported);
  the **kanban column "+ New session" is NOT a consumer of the spec and never was** — its
  `KanbanCreateChoice` is a closed union of the kinds that become a CARD, so feeding it this list
  would offer kinds the board can never show. `addMenuSpec.surfaces.test.ts` pins all four.
  None of the add rows are in `ui-visibility`'s hide inventory (it covers the NODE menu and the
  terminal header), so grouping does not interact with hiding today; a future hideable add row
  would need the group's own row to disappear when it empties, which `buildGroupedAddMenu` already
  does — it emits no submenu for an empty bucket.
- **Edges** are all one React Flow type, `floating` (`canvas/FloatingEdge.tsx` over the pure
  `lib/floatingEdge.ts`): every family — ropes, context bridges, note links, subagent/loop card
  edges, trigger edges — is drawn between the midpoints of the two nodes' facing sides instead of
  fixed handle sides, so an edge to a node placed left of or above its source takes the short way
  round rather than looping across the canvas, and every edge using a side meets the node at ONE
  point (2026-09-03: enes's first try showed a hub with entries fanned along its whole top edge).
  Context and note links are the exception in one respect: they anchor only on the left/right
  sides (`data.anchor: 'horizontal'`), where the `link-out`/`link-in` drag handles are drawn. A terminal node's **eye** (`hide-fanout`, "Hide cards &
  connections") hides its subagent/loop cards AND every edge touching that node — display only:
  the links still authorise reads and an `--after` still waits. See the `--after` bullet under
  Canvas control for the rope model the eye hides.
  **Surfaces:** Desktop + Server Edition are identical (pure renderer + React Flow internals — no
  new IPC or bridge member); the kanban board is N/A (it shows cards, never edges); mobile is N/A
  (the transport protocol carries no edges).
    [~ replaced 14 base line(s) here]
- **"Go to node" (`goToNode` → `frameNode`)** — the one camera-travel path (notification click,
  sessions sidebar, ⌘K jump, presence travel, minimap double-click, double-click focus).
  **It computes the viewport itself and applies it with `setViewport`. It must never go through
  `fitView`.** React Flow's `fitView` frames nothing when you call it: it sets `fitViewQueued` and
  the fit is RESOLVED LATER — from a subsequent `setNodes` (and only once EVERY node is measured,
  `nodesInitialized`) or from the next `updateNodeInternals` — against whatever `nodeLookup` holds
  by then. Its fit set is also filtered by `measured` (no `width`/`height` fallback in
  `getFitViewNodes`), so a set that comes out EMPTY collapses the bounds to `{0,0,0,0}` and
  `getViewportForBounds` parks the canvas **ORIGIN** in the middle of the screen at max zoom. On a
  canvas whose nodes sit thousands of px out that is the field report verbatim: right project,
  empty stretch of canvas, *sometimes*. **Cross-project** focus lands in that window every time —
  switch project → load its nodes → frame the target, all before the mount-time measuring has
  settled — and the second click always works, which is what makes it read as intermittent.
  The geometry is `renderer/lib/nodeFocus.ts`: the node's rect from React Flow's own measurement
  when it has one (`getInternalNode` — `measured` reaches OUR node objects one render later via
  `onNodesChange`, and `internals.positionAbsolute` also accounts for `extent:'parent'` clamping),
  else `nodeFitRect` from the PERSISTED size, resolving the group-parent chain. Then
  `viewportForRect`: **centred in the pane, and nothing else.** Framing a single focused node
  against the chrome-free rectangle was tried twice and is wrong both ways — centred IN that rect
  ("too far right on an ultrawide, half off-screen on a laptop") and centred in the pane then
  nudged clear of it ("still not in the middle") — because `.sessions-sidebar` is a 300px absolute
  OVERLAY and it is open exactly when this feature is used, so either rule pushes the node right by
  most of its width. The couple of dozen pixels that end up behind the sidebar cost far less than
  losing the centre. The free-rect solve (`solveFitFrame` / `solveFitPadding`) stays where it earns
  its keep: `fitAll`, which fits EVERY node and would otherwise tuck them under the dock.
  Unknowable size or no pane ⇒ the camera **stands still**.
  **ONE exception, and it is not a walk-back of that rule (issue #743): a MAXIMIZED node**
  (`isMaximized` — `data.premaxRect`, the flag `maximizeNodeToRect` writes and
  `restoreMaximizedNode` clears) is framed against the same rectangle `maximizeTargetRect` placed
  it in, by passing `measurePinnedInsets(box)` to `viewportForRect`. The trade-off above rests on
  ONE number — how much of the node ends up behind the panel — and for a maximized node that
  number is set by the PANEL rather than the node, **by construction**: maximize sized it to be
  *exactly* the free area, so centring it in the wider pane buries half the inset less the margin.
  Measured by the reporter on a signed v0.3.5 build with the sidebar pinned: an ordinary node lost
  33px, the maximized one 137px, and the camera drifted by `322 / 2 = 161` px on every "go to
  another node and back". Because the node is that rectangle minus two margins, centring it in the
  free area reproduces maximize's own origin (`marginPx + insets.left`) exactly — which is what
  makes this a fix rather than a second opinion about placement. It applies to BOTH zoom branches
  (the rectangle question is the same one; splitting it would be two rectangles again, which is
  the bug), and with no pinned panel `insets` is zero and the whole thing is a mathematical no-op.
  A pane narrower than the panels over it falls back to the whole pane rather than solving against
  a negative width. `measurePinnedInsets` reads the DOM, so it is asked only for a node that can
  use the answer.
  `settings.focusZoomToNode` (Behavior, default ON) is the escape hatch for the rescale: off, the
  camera keeps the zoom `getZoom()` reports and only pans, and that zoom is passed through
  **unclamped** — it is one the canvas is already displaying, and re-clamping it to the framing
  range would rescale the view the option exists to leave alone. Two rules a refactor must not
  undo: framing goes through `frameNode` and nothing else (`canvas-wiring.test.tsx` pins that it
  contains no `fitView(`), and a "stands still" branch must never be "helpfully" replaced by a bare
  `fitView` — that IS the origin jump. `fitAll` still uses `fitView` deliberately: it is an
  explicit user gesture on a settled canvas and its fit set is every node, but it carries the same
  deferral, so do not reach for it from anything automatic.
- **Canvas layouts** (`@shared/canvas-layout`, `renderer/lib/canvasLayout.ts` capture/apply +
  `renderer/lib/canvasLayoutView.ts` for the menu wording and the fallback camera; Dock button
  after "Fit view", mirrored in ⌘K) - a NAMED SNAPSHOT OF NODE GEOMETRY (position, size,
  collapse state) per project, so an arrangement built for the ultrawide can be restored after a
  day on the laptop screen. Load-bearing rules:
  - **Geometry only, and that is the whole safety story.** A restore never creates, deletes,
    renames, recolors, reparents or respawns a node, and never touches a tmux session - so the
    worst a bad layout can do is move things, which ⌘Z takes back (the debounced history effect
    picks up the `setNodes` like any other placement, which is why restore has no confirm and
    delete does).
  - **The two DESTRUCTIVE row actions confirm; restore does not, and the split is the undo stack.**
    ⌘Z replays node arrays, and a layout lives beside them rather than in them, so delete and
    "update to the arrangement on screen" are both unrecoverable the moment they run while a restore
    is one undo away. Update exists because the three-step alternative already worked (save, retype
    the name you are looking at, confirm the replace) and re-typing a name is friction, not a
    decision; it reuses `saveLayout`'s replace-by-id path, so `createdAt` survives, `updatedAt`
    moves, and the window size and camera are re-captured because you are updating FROM this screen.
    Both dialogs are built from `layoutIsShared` + `deleteLayoutMessage`/`updateLayoutMessage`
    (`canvasLayoutView.ts`), ONE definition of who else a destructive edit reaches: a folder project
    and an SSH project both keep their `project.json` where other people read it, and only a
    cwd-less canvas does not. Gating that on `cwd` alone (the first version) told an SSH project's
    user their edit was private when it was not. The layout is re-resolved AT CONFIRM TIME, never
    captured with the dialog: it is open for as long as the user looks at it, and a pull or a peer
    mutation can retire it underneath.
  - **The content half is git-shared, the camera half is machine-local.** `Project.layouts` rides
    `.nodeterm/project.json` beside `nodes` and `kanban`, because node geometry is already shared
    content in that file and a restore writes exactly those fields. `Project.layoutViewports` (this
    machine's camera per layout) rides `IndexEntryV3` in `workspace.json`. **The camera precedent
    (`viewport`, `breadcrumbs`) deliberately does NOT reach the geometry**: those are facts about
    where one person was looking, and nobody else's canvas moves when I pan - but where the nodes
    SIT is the canvas itself, and sharing an arrangement with the repo is the point.
  - **Restore rules** (`applyLayout`, pure + tested): a live node the layout does not mention is
    left exactly where it is, never tidied or stacked at the origin; an entry whose node is gone is
    skipped and counted, never resurrected; a frame the layout addresses gets the rect the user
    saved and is NOT re-fitted afterwards (the fit would overwrite it and the arrangement would
    drift a little on every restore), while a frame the layout does not mention but whose
    descendant just moved IS re-fitted, deepest first, so an out-of-layout child cannot be clamped
    by `extent:'parent'` into an inverted range. The whole layout lands in ONE transform as an
    explicit two-pass (resolve every target root origin, then emit) - a reduce over N placements
    re-fits an ancestor between two of them, so the second node is measured against a frame the
    first just moved and the result is differently wrong depending on array order. `collapsed` is
    restored with the CHROME height on the node and the real one in `expandedHeight` (the
    `flowToNodeStates` rule: the stored height is ALWAYS the expanded one, or a
    save-while-collapsed shrinks the node permanently). `premaxRect` and every non-geometry field
    ride the spread untouched - a restore is a placement, not a maximize.
  - **The camera is applied with `setViewport`, NEVER `fitView`** - the "Go to node" invariant
    above, and a canvas that has just been rearranged is exactly the unmeasured state where a
    queued fit collapses the bounds and flies to the origin. This machine's recorded camera wins;
    a layout restored here for the first time (a teammate's, or one saved on another machine) gets
    `layoutFramingViewport`, which is the core `framingViewport` rule rewritten locally because the
    renderer has no import path into `src/core` and because a layout's rects are ROOT-space, so
    unlike `CanvasNodeState` positions every entry anchors the camera.
  - **The window size is a LABEL, never a matcher.** `CanvasLayout.window` is the author's window
    at save time, shown in the menu so the user can tell the two arrangements apart. Nothing
    auto-applies a layout on a display change: the file travels, so matching on it would pick a
    stranger's monitor for this user's screen - and a canvas that rearranges itself when you plug
    in a projector is worse than one that does not.
  - **Cap 20** (`CANVAS_LAYOUTS_CAP`; a full node-geometry list in a file that is committed and
    cloned), name capped at 60, and **both sanitized on BOTH serializer seams** (`fileToProject`
    on the way in, `projectToFile` on the way out) - the same two-seam rule `normalizeNodeIcon`
    and `sanitizeNodeTriggers` follow, because live node data is reachable by a peer canvas
    mutation and whatever we write is what the next machine trusts. `sanitizeLayouts` DROPS a
    layout whole rather than repairing it: a repaired layout no longer describes the arrangement it
    is named after, and a non-finite coordinate is a white-screen crash (`adoptUserNodes`
    dereferences the position unguarded) that `JSON.stringify` then writes back as `null`.
  - **Downgrade note:** a build older than this one drops `layouts` on its first save, because
    `projectToFile` builds an explicit object and simply does not know the field. The layouts are
    gone from that checkout's file until someone on a current build saves again; nothing else
    breaks, and the machine-local cameras are pruned to match on the next load.
  - **Surfaces:** Desktop full; **Server Edition full with NO new IPC** (pure renderer plus
    `workspace.save`, which both shells already boot); **relay tabs REFUSED with the reason** -
    the Dock button is disabled with "Layouts are managed on the host" and the ⌘K entries are
    omitted (the palette has no disabled row), because a relay tab is a live connection to another
    machine and never a workspace on this disk; kanban N/A (a board shows cards, and geometry is
    what a column layout discards); mobile N/A - *nodeterm mobile* attaches to tmux sessions over
    the transport protocol and has no canvas, so surfacing a layout means extending that protocol
    (follow-up in the iOS repo).
    [~ replaced 1 base line(s) here]
  desktop/server/SSH (`core/fs-ops.ts`, `main/ssh-fs.ts`). **Relay tabs are NOT degraded**: a
  relay tab's `fs` routes through `bridge/relay-api.ts:86` (`fs: files.fs`) → `buildFilesApi`'s
  `IPC.fsMkdir`/`IPC.fsExists` (`bridge/ws-bridge.ts:474-475`) → `core/fs-handlers.ts:43-44` →
  the real `fsOps.makeDir`/`fsOps.pathExists` on the peer's core, so both verbs are live there.
  What genuinely still lacks them is the legacy PHONE vocabulary
  (`main/remote/host-service.ts`), whose `handleFs` switches on `fs.list`/`read`/`readBinary`/
  `write` and nothing else, so `fs.mkdir`/`fs.exists` fall through to the dispatcher's
  `Unknown method` **rejection** (line 695) rather than degrading to `false` — a different
  dispatch path (`relay-host.ts:22-24`) from the relay tab above.
    [~ replaced 1 base line(s) here]
  agent-driven card movement yet, no board undo.
  **Mobile (nodeterm-ios) reaches the board through two relay verbs**, both landing in
  `WorkspaceStore.ensureRemoteBoard` / `setRemoteCardColumn` (host-service `handleKanban`; wired in
  `main/index.ts`'s `hostBridge.kanban`; pure transforms in `core/project-kanban-write.ts`):
  `projects.ensureBoard` seeds the default columns on a project that has none, `projects.setCardColumn`
  moves one card. Three things make them necessary rather than convenient. (1) The desktop board is a
  LAZY default — `kanban` is not written until the user's first board edit — so most project files
  carry NO board and the phone, which knows a project only by its file, could not offer one
  (measured: 1 of 13 project files on the author's machine had a `kanban` block). The default columns
  therefore live in `@shared/kanban-default-board`, read by `defaultKanban()` AND by the core seeder,
  and copied verbatim (under a pinning test on both sides) by iOS `KanbanDefaults`. (2) An SSH
  project's file is on a THIRD machine the phone has no credentials for; the verb writes the entry's
  `cache` and lets the ordinary mirror push it, which is exactly what a desktop card drag does — so
  it needs nothing new from `reconcileSsh` (that decides by `rev` and unions only `nodes`). Its cache
  change IS persisted to workspace.json, because for an ssh entry the cache is the local record. (3)
  The phone's older direct-SSH write inlines the whole project.json into one argv string and so dies
  at Linux's `MAX_ARG_STRLEN` — this repo's own `.nodeterm/project.json` measured 114,695 bytes,
  ~15 KB under the 128 KB ceiling. **Both verbs announce their write on `workspaceExternalChange`
  and that is not optional**: the renderer holds its own board and the next whole-workspace save
  serializes THAT, so a change the renderer never heard about is one the next autosave reverts.
- **Omni Kanban (global swimlanes)** (`components/kanban/GlobalKanbanView.tsx`; one swimlane per open project; `state/viewMode.ts` `globalKanban` (localStorage `nodeterm.globalKanban`, machine-local, like `viewByProject`) + `settings.omniKanbanEnabled` (feature gate, default OFF, `settings.json`) / `omniKanbanAsDefault` (when true, `view.kanbanToggle` — Cmd+Shift+B — opens Omni; otherwise per-project; `view.globalKanbanToggle` registry command — unbound, remappable — always opens Omni when enabled); `TabBar` and the menu IPC `onToggleKanban` share one `performKanbanToggle` decision, and `isGlobalKanbanOpen()` is the single gate (fail-closed, static import of `useSettings` — the earlier `require` failed open in the packaged renderer). The active project's lane is derived from serialized `p.nodes` via `toKanbanSessionState` — the persisted-state counterpart to `toKanbanSession` — and is committed (`commitActiveToStore`) before the overlay mounts so live React Flow edits are not stale; `pendingLaunch` never becomes `initialCommand` in the modal (the DAG launch must fire only when dependencies report done, and the canvas `TerminalNode` already delivers `initialCommand` via `writeWhenShellReady` after the `nodeterm:create-node` project switch). Active-project edits (rename / sticky / browser nav) route through Canvas live nodes (`setNodes` + `markDirty`), non-active through the store + `writeDisk`; delete uses `ConfirmDialog` (not `confirm`) and SSH-aware teardown (`transport.destroy` locally vs `sshProject.killSessions` with `everySocket` for a remote owner, plus `agentStatus` / `agentNodes` / `webviewKeepAlive` cleanup). The top bar's project pills and Cmd/Ctrl+1..9 (`nodeterm:swimlane-jump`) jump to the lane; header hint shows the correct mod (`Cmd` on Mac, `Ctrl` elsewhere). Server Edition works as-is, Mobile N/A.
- **Nothing raises the window without a user action** (issue #737, the THIRD in this family —
  #665 and #702 were canvas-control moving the user's VIEW; this one is the OS window activating
  over another app). The cause was `win.on('ready-to-show', () => win.show())`: `ready-to-show`
  fires on the first paint of EVERY main-frame navigation, not once per window (MEASURED on
  Electron 42.9.1 — a `webContents.reload()` on a VISIBLE window emits it again with `isVisible()`
  already true), and the crash auto-reload (`render-process-gone` → `webContents.reload()`) is an
  unattended navigation. So a backgrounded renderer being killed — macOS jetsam on a machine
  running several agent CLIs at 335 MB–1.2 GB each — silently raised nodeterm over whatever the
  user had ⌘Tabbed to. It is `win.once` now. **The gate must be FIRST PAINT, not `isVisible()`**:
  after macOS hide-on-close the window is hidden but alive, and an `isVisible()` gate would `show()`
  it on a background reload — the same bug inverted.
  The permitted raises are all a CLICK, and they are enumerated with their triggering action in
  **`src/main/window-raise.guard.test.ts`**, an allowlist-with-reasons in the shape of
  `fs-atomic.guard.test.ts`: a notification tap (the one exception the rule names), a Notch HUD
  row, a Dock activate, a second launch, and a file dropped onto a terminal. Nothing an AGENT can
  do reaches any of them — canvas control, trigger nodes, hook POSTs, relay/pairing/push and
  browser-drive contain no show/focus/dialog call, and agent confirms are in-renderer
  `ConfirmDialog`s, never native. The drop IPC's `app.focus({steal:true})` is the only
  renderer-reachable cross-app activation and now carries the same sender guard its two neighbours
  (`uiShortcutRecording`, `uiTerminalFocus`) already had — a `<webview>` guest is a webContents in
  this process. **KNOWN GAP, listed in the guard rather than fixed**: `standing-host.ts`'s
  `dialog.showErrorBox` for a locked keyring is app-modal, unparented, and raised from the relay
  RECONNECT TIMER; the honest fix routes it to a non-modal in-app surface and owes a macOS check
  that a sheet on a background window does not activate.
- **Window geometry is REMEMBERED** (`main/window-state.ts`, `<userData>/window-state.json`) — size,
  position and maximized state, restored at the next launch. Before this the window opened at a
  hard-coded 1400x900 every time, on every platform, so a user who works maximized re-maximized it
  on every launch; Electron persists nothing on its own and no platform does it for us. The module
  is Electron-free in the `keydown-intercept.ts` shape (pure decisions over plain rectangles,
  structural window interfaces), so the refusals below can be pressed by a test instead of only by
  someone with two monitors — `screen.getAllDisplays()` is called at the seam in `index.ts` and its
  **work areas** (not full display bounds) are passed in. The refusals ARE the feature, because each
  is a way the naive version is worse than the fixed size it replaces:
  - **While MAXIMIZED the size comes from `getNormalBounds()`, never `getBounds()`.** The latter
    returns the MAXIMIZED rectangle, so saving it makes the next un-maximize hand back a
    screen-sized window — state that looks right and behaves wrong, and only for the users who
    maximize. **Un-maximized it is `getBounds()`**, which is the same rectangle wherever both work:
    Electron documents `getNormalBounds()` as supported only on some Linux desktop environments, and
    the common case must not depend on the window manager. The maximized case still does and cannot
    be helped from here, but it matters less, because that record restores by re-maximizing rather
    than by its size.
  - **A position that is no longer reachable is DROPPED, not clamped.** A laptop undocked from the
    monitor its window was on would otherwise reopen the app off-screen: running, focusable from the
    dock, visible nowhere, with no gesture that rescues it. Reachable means a real overlap with some
    work area (`MIN_VISIBLE_WIDTH`/`HEIGHT`), judged against the CLAMPED size — a few pixels on
    screen is not a title bar anyone can grab. **Overlap alone is not enough, because it is
    symmetric**: a monitor mounted ABOVE the laptop and then unplugged leaves a record whose BOTTOM
    edge clips the laptop's work area by enough to clear the height floor while the title bar sits
    hundreds of px above the screen — and under `titleBarStyle: 'hiddenInset'` the title bar is the
    whole drag region. So the window's TOP edge must also land on that work area, within
    `TOP_OVERHANG_SLACK` (24px, because window managers report decorations inconsistently and a few
    pixels of overhang must not cost the user their position every launch). The rule is per-display,
    like the overlap it joins. Dropping keeps the user's size and lets the platform place a window it
    knows how to place; inventing a corner for it is the guess.
  - **No capture while minimized or fullscreen.** `isMaximized()` is FALSE while a macOS window is
    fullscreen, so capturing there records `maximized: false` and erases exactly the preference this
    exists to remember. The last non-fullscreen state stands, which also means the app never reopens
    INTO fullscreen — deliberate: a fullscreen window is usually a temporary mode and is much harder
    to escape on first launch than a maximized one.
  - **Maximize before the first paint**, while the window is still `show: false`; maximizing after
    `show()` is a visible jump from the restored size on every launch.
  - Every field is **re-validated as a number on read** — the file is hand-editable and its values
    reach the `BrowserWindow` constructor before there is a window in which to report a failure.
  - Saves are debounced (`resize`/`move` fire continuously through a drag) and flushed
    **synchronously** on `close`: that is the only moment guaranteed to see the final state, and an
    awaited write there races the process exit. Published through `renameAtomicSync` with a
    per-call unique temp, like every other store.
  - **NT_MULTI is excluded**: a throwaway dev sandbox may share the real app's userData, and it must
    not move the window of the app being developed.
  - Desktop only, and genuinely so — a browser tab's geometry is the browser's, and the mobile
    companion has no window. Nothing here belongs in `src/core`. **Wayland caveat**: a native-Wayland
    client cannot set its own position (the compositor owns placement), so x/y is honoured under
    XWayland and quietly ignored otherwise. Size and maximized restore either way, which is what the
    drop-don't-clamp rule already degrades to.
    [~ replaced 2 base line(s) here]
  bar (`TabBar.tsx`) is the drag region with the `nodeterm` logo + a **Chrome-style tab strip**
  (2026-09-16): inactive tabs are flat and separated by a 1px divider that drops on both sides of a
  hovered or active tab, hover is an inset pill, and the active tab is `--canvas-bg` with rounded
  top corners and two concave flares (`.tab.active::after`, radial gradients) so it merges into the
  surface below — which is also the kanban overlay's colour, so it merges under both views. In
  LIGHT the strip steps back to `--surface-deep` (`--tabbar-bg`), because `--panel` and
  `--canvas-bg` are one value apart there and a canvas-coloured tab would vanish.
  **A tab is as wide as its own NAME and never shrinks** (`max-width: var(--tab-max)` 260px,
  `flex: 0 0 auto`; the name is `flex: 0 1 auto; min-width: 0` with `text-overflow: ellipsis`): the
  strip SCROLLS when the tabs stop fitting, and nothing shortens a name except that cap. This is
  the deliberate departure from Chrome, which shrinks because it must keep every tab reachable
  without scrolling — here the sessions sidebar and ⌘1..9 both reach a project without touching
  the strip, so a readable name is worth more than a visible tab edge.
  **Two earlier rounds tried to ration the name between tabs and both spent the one thing the strip
  is for**, which is why the third does not: #789 gave every tab one flex basis (at 8 tabs / 1340px
  the ACTIVE name measured 24px — zero characters — because it carried the most furniture and hit
  its floor first), and #790 added a 60px floor plus a `tabDensity` level that shed furniture to
  pay for it — whose middle level hid the SSH chip, and 8 tabs in a 1340px window land on exactly
  that level, so every remote tab lost its `SSH` label at the width people work at.
  **`renderer/lib/tabDensity.ts` is deleted**: with full names there is no name budget to protect,
  so there is nothing for a density level to buy. Do not reintroduce one without first saying what
  it is buying. Measured on the third shape (headless Chrome, the real CSS, 86px traffic-light
  reservation): 8 tabs in 1340px — every name whole, every SSH chip present, the strip 14px past
  its width; 12 tabs — every name still whole, the strip scrolling 559px; a 60-character project
  name stops at the 260px cap and is the only thing that ellipsises.
  The fade mask went with the shrinking: a mask gradient is unconditional and would fade the tail
  of a name that fits perfectly, while `text-overflow` is self-conditioning. **The bar's height is ONE number in two places that cannot read each
  other**: `--tabbar-h` in styles.css (every top-anchored panel, the kanban overlay and the usage
  popover position against it) and `TABBAR_HEIGHT_PX` in `@shared/window-chrome-metrics`, from
  which main derives the traffic-light `y` (`trafficLightY`) — a literal 15 for a 44px bar was
  what made shrinking the bar hazardous. It is **40px** (36 for one release, which read as cramped
  once the tabs carried whole names) **by default — the height is a SETTING**
  (`settings.tabBarHeight`, Settings → Appearance, 28–64): `App.tsx` writes the resolved value to
  `--tabbar-h` on `<html>`, and main re-centres the macOS traffic lights on the same settings
  change (`win.setWindowButtonPosition(trafficLightPositionFor(h))`, change-gated), so the two
  cannot disagree. Every reader goes through `resolveTabBarHeight`, which answers the default for
  a non-number and clamps — the floor is what keeps the 12px lights inside the bar. The stylesheet
  token keeps the default LITERAL so an un-hydrated renderer draws the default bar, not none.
  `styles.tabbar.test.ts` pins the token to the constant and
  every dependant to the token. The New-project `+` is a **sibling** of `.tabbar__tabs`, not its last child — inside
  the scroller it vanished once the strip overflowed (no visible scrollbar to hint it was
  still there). The wrapping `.tabbar__projects` is `flex: 1` and stays a drag region (not
  `no-drag`); the pill itself must not be `flex: 1` or it inflates into an empty capsule.
  Cmd+M is intercepted in `main/keydown-intercept.ts` (`before-input-event`, installed from


### From CLAUDE.md § Idle energy: an animation is a frame loop, not a decoration [NEW upstream section]

## Idle energy: an animation is a frame loop, not a decoration

**A running CSS animation obliges the compositor to produce a frame every vsync — on a ProMotion
display 120 of them a second — for as long as it runs, and each of those frames re-rasters and
re-composites the whole window.** That cost is paid once for the WINDOW, not once per animation, and
it does not care whether anybody is looking: an unfocused window that is still visible (a second
monitor, half behind an editor) is not `document.hidden` by any definition Chromium uses, so it
keeps producing frames at full display rate.

MEASURED on the Server Edition, 40 terminal nodes on one canvas, headless Chrome, 25 s idle windows,
total CPU across every Chrome process (`/proc/<pid>/stat`):

| state | CPU |
|---|---|
| idle, nothing animating | **1.5 %** |
| **one** visible node with the `working` glow | **33 %** |
| five | 66 % |
| twenty | 101 % |
| twenty, but all panned OFF screen | 2.2 % |
| twenty, under an opaque full-screen overlay | 12.8 % |
| twenty, `animation-play-state: paused` | **1.6 %** |
| twenty, `animation: none` + a static opacity | 1.9 % |
| first-run mobile-launch card open (5 animations, no node glows) | 97 % |

Four things to take from that table, because each one contradicts a reasonable guess:

- **The step is at the FIRST animation, not the twentieth.** What costs is that frames are produced
  at all. So a gate that covers most of the app's animations buys nothing — one that keeps running
  holds the frame loop open, while everything the gate DOES cover still looks correctly frozen. That
  is why `--nt-anim-state` is applied to EVERY `infinite` animation in `styles.css` and enforced by
  scan (`styles.animation-gate.test.ts`) rather than applied to the worst few by hand.
- **Offscreen nodes are already free** (2.2 %): Chromium skips raster and compositing for layers
  fully outside the viewport. There is nothing to fix there, and a viewport-gated animation would be
  work with no measurable return. A canvas of 119 nodes costs what its VISIBLE animated nodes cost.
- **`paused` is as cheap as `none`** (1.6 % vs 1.9 %), so the gate freezes each animation where it
  stands instead of snapping it to a resting frame — nothing MOVES at the moment focus is lost, and
  refocusing resumes rather than restarts.
- **The renderer's MAIN thread is idle throughout.** Over the 25 s window with one node pulsing,
  `Performance.getMetrics` reported 0.15 s of `TaskDuration`, 1 layout and 51 style recalcs, while
  the renderer PROCESS burned 14.8 % and the GPU process 17.9 %. This is compositor and raster work,
  invisible to every JS-level profiler and to a timer census.

**What the numbers are NOT.** Headless Chrome here rasters in software (SwiftShader), so the
absolute percentages are inflated relative to a real GPU and none of them is a prediction about
macOS. What the A/B establishes is the MECHANISM and its direction; the magnitude on a given machine
has to be measured there (`powermetrics --samplers gpu_power,tasks`, and Activity Monitor's Energy
Impact, which weights GPU use and wakeups heavily).

**Timers are not the problem, and the census that said so is worth not repeating.** Over the same
idle window the renderer fired **56 timer callbacks in 30 s** (~1.9/s: 40 per-node liveness polls at
1/30 Hz, the 2 s terminal-focus mirror, the 30 s host-RAM read) and **zero** `requestAnimationFrame`
callbacks — the default renderer path has no self-perpetuating rAF loop (glyphgrid's parks after 30
idle frames and is opt-in; the dino game's is focus-gated). Before adding a timer gate for energy
reasons, measure: at these frequencies a JS wakeup is nothing beside one frame of compositing.

**The board is the second gate, and it is a SEPARATE attribute on purpose.** The canvas stays
mounted under the kanban overlay (`display: none` would 0x0-resize every terminal into a tmux
SIGWINCH), so its glows and pulses keep animating under something nobody can see through — 12.8 %
in the table above. `renderer/lib/canvasCovered.ts` marks `data-nt-canvas="covered"` for as long as
a full-page board view is MOUNTED (mount is the signal: both board views are conditionally
rendered, so it cannot drift from the view state the way a recomputed `kanbanOpen` flag can, and it
needs nothing from Canvas), and `:root[data-nt-canvas='covered'] .react-flow` overrides
`--nt-anim-state` on that subtree alone — the variable INHERITS, so that one declaration is the
whole gate for every animation reading it. It is not a second writer of `data-nt-window` because
the two facts are independent (a board on a focused window; an unfocused window with no board) and
one attribute with two owners is a race over who clears it. The claim is refcounted: React can
mount the incoming view before unmounting the outgoing one, and a plain set/clear pair would let
that unmount erase the live view's claim.

**Specificity is the quiet failure mode in all of this, and it has already happened twice.** The
three glows carry their own `animation:` shorthand, which RESETS `animation-play-state` — so
inheriting the variable does nothing for them and every gate has to name them explicitly. A first
draft of the covered rule used `.react-flow__node::after`, lost to
`.react-flow__node:has(.term-node.working)::after` on specificity, and measured EXACTLY the
unpatched number while looking correct in the diff. When you add a gate, verify the COMPUTED
`animation-play-state` on a real element, not the presence of the declaration.

The gate itself: `renderer/lib/windowActivity.ts` sets `data-nt-window="idle"` on the document
element when the window loses focus or the page hides, `:root[data-nt-window='idle']` flips
`--nt-anim-state` to `paused`, and the three per-node glows take a static-lit rule instead of the
shared pause — `nt-unread-glow` rests at `opacity: 0`, so pausing it is a coin flip on whether the
glow that says "this agent finished while you were away" is still on screen when you come back to
look for it. `hud.css` is deliberately excluded: the notch HUD's window is never focused, so the
shared gate would freeze it permanently rather than while nobody is looking.


