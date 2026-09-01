---
paths:
  - "src/renderer/nodes/**"
  - "src/renderer/editor/**"
  - "src/renderer/state/workspace.ts"
  - "src/renderer/state/webviewKeepAlive.ts"
  - "src/renderer/lib/webviewKeepAlive.ts"
  - "src/renderer/lib/markdown.ts"
  - "src/renderer/styles.css"
---
# Node kinds, group frames, editor/diff/video/web/browser nodes, resize hit-area, webview keep-alive

> Moved verbatim from the root `CLAUDE.md` on 2026-09-01 (see its "How this documentation is
> organized" section). Loads automatically when a file matching the `paths` above is read;
> when the root routing table points here, read this file before touching the subsystem.
<!-- moved-verbatim-from: CLAUDE.md -->

## Node kinds (all rendered by React Flow custom nodes)

- **terminal** (`TerminalNode.tsx`) — xterm + tmux (see `.claude/rules/terminal.md`). Header: collapse, color,
  click-to-rename title, ✦ AI-name, ×. Body has a **hover guard** overlay: dwell
  `settings.panHoverDelay` (default 600 ms) before the terminal takes focus — before that,
  drag = move node, scroll = pan canvas. **Cmd/Ctrl+M** (while hovered) toggles a markdown
  render of the captured output. Tag chips via `NodeTags`.
  **Selection + copy is tmux's** (its mouse is on — see `.claude/rules/terminal.md`): drag to select, wheel to
  scroll tmux's history. A drag copies via copy-mode, and tmux emits **OSC 52** to the client, whose
  handler writes the **system clipboard** — the one copy path on every platform *and* over SSH (no
  `pbcopy`). OSC 52 writes an app emits itself (vim `"+y`, gh, yazi) reach the clipboard through the
  same handler (write-only — a read query is refused). The emulator's own copy chords stay for a
  selection xterm *does* own (`copyKeyAction`/`isCopyShortcut`): **Cmd+C** (mac), **Ctrl+Shift+C**
  and **Ctrl+Insert** (Linux/Windows) — matched on `e.key` *or* the physical `KeyC`, so non-Latin
  layouts still copy. A copy chord is **always swallowed**, selection or not: letting Ctrl+Shift+C
  fall through would reach the pty as `\x03` (SIGINT). Ctrl+Insert exists because Chromium reserves
  Ctrl+Shift+C for the inspector and a page cannot `preventDefault()` it — which is where Server
  Edition users land. Plain **Ctrl+C** is never intercepted. To select in **xterm** instead of tmux
  (or inside an app that grabs the mouse, like vim/htop), hold **Option** (mac —
  xterm's `macOptionClickForcesSelection`) or **Shift** (Linux/Windows) while dragging.
  **Copying now says so**: the OSC 52 handler floats a transient `Copied N lines` pill over the
  terminal's BOTTOM-RIGHT corner (`.term-copy-pill`, the same class on the canvas node and the
  kanban card modal — one session seen twice must not speak in two voices; bottom-right because
  every agent CLI writes its input line bottom-left, and `pointer-events: none` because it sits on
  the terminal and fires on every copy), because tmux's `copy-pipe-and-cancel`
  clears the highlight at the exact instant it copies — which read as "the copy failed" to a user
  whose other pane ran claude. And a drag that produced NEITHER an OSC 52 nor an xterm selection
  means the pane's app captured the mouse (claude does, codex does not), so a one-time
  `Hold ⌥ to select text` hint fires instead (`nodeterm.seenSelectHint`). **The whole layer is
  OFF for an agent in `SELF_REPORTS_COPY` (`reportsOwnCopy` — claude, which prints its own
  "copied N chars to tmux buffer" line): a second message for one gesture is noise, and a claude
  terminal is byte-identical to before the feature. **One owner per pill:**
  the `copied` receipt is raised ONLY by the OSC 52 path, the hint ONLY by the drag path — the two
  never race for the same slot. The emulator's own copy **chord** (Cmd+C / Ctrl+Shift+C) deliberately
  raises nothing: Claude Code prints its own copy line ("copied N chars to tmux buffer"), and a
  second message for one gesture is noise. Decision logic is the pure `terminal/copy-feedback.ts`;
  `useCopyFeedback` is the glue (it also yields to a clipboard-failure `nodeterm:toast`, so the
  Server Edition never shows a green receipt beside a red banner), and the node publishes its sink
  through the module-level `copySubs` map because the OSC handler survives a park.
  **Shift+Enter** is remapped to `\x1b\r` (ESC+CR / M-Enter) so agent CLIs insert a newline
  instead of submitting (`terminalKeyAction` / `SHIFT_ENTER_SEQ` in `terminal-config.ts`; sent in
  all terminals — harmless in a plain shell). **Cmd (mac) / Ctrl+click** opens links in the
  output: URLs → default browser (`@xterm/addon-web-links`), file paths → editor node and
  directories → Explorer reveal (`terminal/file-links.ts`, existence-verified against the project
  fs via cached parent-dir listings, with `path:line[:col]` compiler-output suffixes). The path
  dialect follows the FILESYSTEM-OWNING CORE, not the viewer: desktop-local may use its own
  platform, Server Edition and relay tabs use the core's reported `process.platform`, and SSH
  projects are POSIX. A failed host-platform read disables file links for that connection — it
  never guesses from the browser. Standalone `ssh` terminal nodes remain URL-only because they
  have no remote fs API with which to verify a token; relay tabs do have a core-bound, jailed fs
  API and therefore support file links. Windows existence matching is case-insensitive and accepts
  both separators; UNC tokens are refused whole before they can be reinterpreted as cwd-relative.
- **Agent** (`createAgentNode(agentId, …)`) — a terminal preset that runs an agent CLI as its
  `initialCommand` (runs once on open via `transport.write`, then cleared), with `data.agentId`
  set. Builtins (`claude`/`codex`/`gemini`) come from `AGENT_CONFIG` (clay color etc.).
  Agent nodes get extra behavior **gated by the
  agent's capabilities** (see **Agent support** in `.claude/rules/agents.md`): a busy/working badge + unread dot +
  completion notification + session-name chip (hook-capable agents), content search, and the
  Claude-only **Branch conversation** action. Custom user-defined agents spawn + show
  process/terminal-title status only.
- **sticky** (`StickyNode.tsx`) — colored note, free text, collapsible. Has link handles:
  connect a sticky to any terminal node to attach the note as context (see Context Link).
- **group** (`GroupNode.tsx`) — real React Flow parent/child frame, and frames **nest** (2026-08):
  a group may contain other groups to any depth. `groupSelectedNodes` wraps objects that share ONE
  container — frames included — creating the wrapper inside that container; a mixed-container set,
  or an ancestor selected together with its own descendant, is **refused** rather than scrambled
  (positions are only comparable within one container, and the descendant would be torn out of the
  ancestor being wrapped). Box-selection routinely catches both, so structural actions normalize
  the selection to its subtree roots first (`selectedRootIds`). `ungroupNodes` promotes a frame's
  direct children into **its own parent** (not to the root — that would move them by the whole
  ancestor offset); `reparentNode` moves a node OR a whole frame subtree, keeps its **root-space**
  position fixed (`rootPosition`, not the old add-one-parent's-origin math) and refuses a cycle;
  `addSelectionToGroup` adds a selection to an existing frame; `reorderGroupWithinParent` reorders
  a frame among its siblings, carrying its subtree. `nodeStatesToFlow`/`groupsFirst` emit frames
  **depth-first from the root** — a flat "groups first" sort is not enough once two groups compare
  equal — and that persisted order is also the downgrade contract (a pre-nesting build's stable
  sort leaves it alone, so a nested tree still hydrates parent-first and renders there).
  **A frame that gains a child bigger than itself is re-fitted, ancestors included**
  (`fitGroupToChildren` up the chain): a wrapper created at `(minX-28, minY-62)` relative to its
  parent is routinely negative, and `extent:'parent'` would make React Flow clamp it into an
  inverted range — snapping the frame hundreds of px away and dragging the whole wrapped subtree
  with it. Visually: a dashed rounded frame in the group color with a floating label pill (color
  dot + editable name) on the top border and ungroup/× top-right (on hover/selected). **The pill
  is the frame's `dragHandle`** and the frame body is `pointer-events: none` — a frame is a
  background container, not a giant drag target, so its body passes clicks to the pane and an
  outer frame cannot swallow the clicks meant for a frame drawn inside it. The
  `NodeResizer` line is hidden (`lineStyle` transparent) so it can't draw a sharp-cornered
  box; the selection ring is a `box-shadow` instead, which follows the same `border-radius`.
- **editor** (`EditorNode.tsx`) — Monaco code editor for a `filePath`; reads/writes via
  `fs:read`/`fs:write`, auto-detects language from the path, ⌘S saves, dirty dot. A
  **Preview / Edit** toggle (or ⌘M while hovered) renders the live content as markdown.
  **Image files** (png/jpg/gif/webp/bmp/ico/svg/avif) skip Monaco and show an `<img>`
  preview instead — read as base64 via `fs:read-binary` into a `data:` URL (CSP allows
  `img-src data:`), on a checkerboard backdrop with the pixel dimensions in the header.
- **diff** (`DiffNode.tsx`) — Monaco diff editor; `diffStaged` chooses HEAD↔index (staged)
  vs index↔working (unstaged) via `git:show-file` + `fs:read`. Read-only.
- **video** (`VideoNode.tsx`) — a video player; a local file is served over the `nt-media://`
  protocol (allowlisted on mount via `media.allow`) with native controls; an SSH-project file
  (`data.sshFs`) is first pulled into the local media cache over the project's ControlMaster
  (`media.allowSsh`) then played the same way.
- **web** (`WebNode.tsx`) — an Electron `<webview>` (locked down, no `nodeintegration`) that loads
  a live `data.url`, or serves local html at `data.filePath` over `nt-media://`.
- **browser** (`BrowserNode.tsx`) — a navigable Chromium browser wrapping the shared
  `BrowserSurface` (webview + toolbar); the last top-level URL persists to `data.url`, and the same
  surface backs the kanban card modal's browser popup.
- **dino** (`DinoNode.tsx`) — a small self-contained T-Rex-style runner on a canvas (no PTY);
  high score persists via `data.highScore`.
- **subagent** / **loop** (`SubagentNode.tsx` / `LoopNode.tsx`) — render-only, hook-driven viz
  nodes, **never persisted**. `subagent` visualizes a subagent the Claude session spawned (type +
  task + live timer, expand for its live transcript — subagents have no PTY); `loop` shows a
  loop/schedule/cron kind + task + per-iteration summaries, Play re-issues the task into the parent
  terminal's tmux session.
- **chat** — **REMOVED 2026-07.** The SDK-driven Claude chat node (`ChatNode.tsx`, `main/chat-driver.ts`,
  the `@anthropic-ai/claude-agent-sdk` dependency, and the whole chat-events/chatSessions stack) is
  gone — dropping the bundled SDK also removed a ~240 MB native binary per platform. A persisted `chat`
  node is migrated by `nodeStatesToFlow` into a **sticky tombstone** in place, carrying a
  `claude --resume <chatSessionId>` hint so the conversation continues in any terminal (a chat was an
  ordinary resumable Claude session). `CHAT_CAPABLE` / `canChat` survive but now gate **only** the
  ⌘M **ChatPanel** transcript view on a Claude *terminal* node (see the terminal bullet's Cmd/Ctrl+M),
  not any SDK chat node.

**Node resize is a HIT-AREA problem, not a clipping one** (2026-08-28, measured via CDP
`elementFromPoint` sweeps — do not re-derive this from reading CSS, it is counter-intuitive twice
over). `NodeResizer`'s controls are a 1px edge line and a 5px corner dot, and canvas zoom scales
both DOWN. Two independent defects; fixing either alone changes nothing a user can feel:
- **Width** — widened hit-only by `.react-flow__resize-control ::after` boxes in `styles.css`
  (8px out / 4px in, outward-biased). Visuals are untouched: hit-testing credits a pseudo-element's
  box to the element that owns the drag listener, so GroupNode's transparent `lineStyle` still
  renders as nothing.
- **Stacking** — the controls ship `z-index: auto`, and `.term-node` is **`position: static`**, so
  every overlay inside it (`.term-hover-guard` z 2 covering the whole body, offscreen plate 3,
  closed plate 4) competes in the SAME stacking context and wins. The inward half of any widening
  is dead until the controls are raised (now `z-index: 5` — deliberately below the bridge/link
  handles at 20 and the upload overlay at 30, which must stay grabbable).
- **…but NEVER on a group frame** (`:not(.react-flow__node-group)`, consort finding, MEASURED). A
  frame has none of those inner overlays, so it never needed the raise — and the raise breaks it
  outright: `.group-node__label` / `.group-node__actions` are `top: 0` + `translateY(-50%)`, i.e.
  centred ON the top border at `z-index: auto`, so a raised top-edge control covered the pill and
  the rename input, colour dot, Ungroup, Close **and the pill itself (the frame's `dragHandle`)**
  all hit-tested to the resize line the moment the frame was selected. Left at `auto` they win on
  DOM order, since GroupNode renders the resizer before them. **Any future raise of a node-level
  control owes the same question: what sits ON the border of a frame?**

The **visible** half is the other half of the same feature (Siim, 2026-08-28: "bolder frame around
agent windows to better handle resizing"): `.term-node`'s border is **2px**, not a 1px hairline that
reads as decoration rather than as something grabbable, and hovering a grab zone tints it accent at
20% so the widened band is discoverable instead of being an invisible 11px you must already know
about. A wider hit zone nobody can see is still guesswork — ship the two together. Thickening the
border is bounded only because `* { box-sizing: border-box }` is global: the node does not GROW, the
content box shrinks by 1px per thickened side instead. That is **not** the same as "no reflow" — a
terminal near a cell boundary can lose a column or row on the upgrade render, which the
ResizeObserver reports to the pty as an ordinary resize. One re-fit per node, once.

The static-position fact also kills the obvious wrong theory: `.term-node` is `overflow: hidden`,
but an overflow clip only applies to descendants whose CONTAINING BLOCK is inside it — the controls
are positioned against `.react-flow__node`, an ancestor — so they were never clipped, and moving
`<NodeResizer>` out of the root is a pure no-op. **Known remaining dead spot:** the bridge/link
handles are 13×13 at the vertical centre of the left and right edges, so resize is unreachable
there by design; the rest of each edge is a ~12px band.

Monaco is wired in `renderer/editor/monaco-setup.ts` (language workers bundled via Vite
`?worker` — no CDN; CSP `worker-src` allows them). Markdown rendering is shared in
`renderer/lib/markdown.ts` (`marked` + DOMPurify sanitize).

### Webview keep-alive across project switches (browser/web nodes)

Issue #301: a project switch used to reload every browser node's page — SPA state, forms, scroll,
websockets gone — because the load effect swaps the whole React Flow node array and an Electron
`<webview>`'s guest process dies on DOM detach (a webview cannot be parked like xterm). The fix
keeps the ELEMENT mounted instead of trying to preserve anything through a remount. The facts it
rests on are measured (Electron 42.x probes + in-app verification, 2026-08-26):

- A guest **survives** sibling insert/remove around its element (React reconciliation of kept,
  order-stable keyed children never touches them), and **survives `display:none`** of itself or an
  ancestor — state intact, viewport size and scroll kept (the guest is NOT resized to 0), repaint
  pixel-identical on reveal, timers running throttled like a background tab.
- A guest **dies** on any DOM *move* (`insertBefore`/`appendChild` of an attached element detaches
  first), taking a full page reload with it. React moves a kept child exactly when its RELATIVE
  ORDER among kept children changes (`lastPlacedIndex`), and React Flow renders nodes in
  prop-array order keyed by id (`adoptUserNodes` rebuilds `nodeLookup` in array order) — so the
  merged prop's order discipline IS the feature.

Mechanics (`renderer/lib/webviewKeepAlive.ts` pure + tested, `state/webviewKeepAlive.ts` store,
merged in Canvas exactly like the ephemeral subagent cards — Canvas state, persistence, undo and
the wire never see any of it):

- Every webview-hosting node (`browser`/`web`) renders in ONE stable **pool region** at the tail
  of the `<ReactFlow>` nodes prop, ordered by the pool's entries; entry order never changes while
  an entry lives (append/remove only — `webviewKeepAlive.test.ts` pins the order-stability
  invariant, `webview-keepalive-reconcile.test.tsx` pins the no-detach consequence against real
  React). Visible cost of the hoist: an unselected browser/web node paints above other unselected
  z-0 nodes it overlaps (selection's z 1000 still wins).
- On switch-away the outgoing project's pages become **ghosts**: same node id, `display:none`,
  non-interactive, parked at the origin, `data.ghost` telling the surfaces to route facts at the
  pool (`updateGhostData`) instead of `updateNodeData`. On return the SAME element goes live
  again; `overlayKeepAliveData` folds ghost-time navigations into the loaded nodes inside the one
  `setNodes`, so the `url` prop never moves under the surviving surface (which would navigate it).
- **The merge is keyed on the MOUNTED project (`keepAliveFromRef`), never `activeProjectId`, and a
  mounted entry whose node is missing falls back to its ghost.** Both exist because the pool store
  (zustand/useSyncExternalStore), the ref and `setNodes` do not land in one commit: a switch renders
  interleavings where the id would otherwise drop out of the merged list for one commit — and one
  absent commit is an unmount, i.e. a dead guest ([MEASURED]: the ghost→live direction remounted
  every returning page until the fallback; live→ghost never did). A genuinely deleted node's entry
  is dropped at the deletion funnels (handleNodesChange's `remove`, `deleteNodes`, the peer-mutation
  remove, project deletion/prune), with the next retire as backstop — never by the merge.
- **Memory bounds** (same posture as park/WebGL: a lever must not end live work): a ghost is
  hidden, so the existing Browser Memory Saver discards its guest after `BROWSER_DISCARD_MS`
  unless loading/audible/agent-driven — `onGuestDiscarded` then drops the entry (a husk would hold
  a cap slot). `BACKGROUND_WEBVIEW_MAX` (8) hard-caps live background guests, evicting
  longest-retired first; `activateProject` runs BEFORE `retireProject` on every switch so a
  returning page sheds its background clock before that eviction can pick it.
- E2E-verified under Xvfb (CDP): same webContents across Alpha→Beta→Alpha, typed form text + JS
  state + tick counter continuous, zero reloads; wrapper + webview DOM elements identity-stable in
  both directions. Server Edition: inert (no `<webview>` in a plain browser — ghosts are empty
  husks, nothing to preserve). Mobile: N/A (no canvas).
