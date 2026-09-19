---
paths:
  - "src/shared/canvas-layout.ts"
  - "src/renderer/lib/canvasLayout.ts"
  - "src/renderer/lib/canvasLayoutView.ts"
---
# Canvas layouts (named node-geometry snapshots per project)

`@shared/canvas-layout` + `lib/canvasLayout.ts` (capture/apply) + `lib/canvasLayoutView.ts` (menu
wording, fallback camera). A NAMED SNAPSHOT of node geometry (position, size, collapse state) per
project, so an ultrawide arrangement restores after a day on the laptop.

- **Geometry only** — a restore never creates/deletes/renames/recolors/reparents/respawns a node or
  touches a tmux session, so the worst it does is MOVE things, which ⌘Z takes back. Hence no confirm.
- **The two DESTRUCTIVE actions (delete, "update to on-screen") confirm; restore does not** (⌘Z
  replays node arrays, a layout lives beside them, so both are unrecoverable while a restore is one undo
  away). Both dialogs use `layoutIsShared` (`canvasLayoutView.ts`), ONE definition of who a destructive
  edit reaches: a folder AND an SSH project keep `project.json` where others read it, only a cwd-less
  canvas does not (gating on `cwd` alone told an SSH user their edit was private when it was not).
  Re-resolved AT CONFIRM TIME (a pull/peer mutation can retire it underneath).
- **Content half git-shared, camera half machine-local:** `Project.layouts` rides `project.json`,
  `Project.layoutViewports` (this machine's camera per layout) rides `IndexEntryV3`. The
  `viewport`/`breadcrumbs` precedent deliberately does NOT reach geometry — where one looked is local,
  where nodes SIT is the shared canvas.
- **Restore (`applyLayout`, pure):** an omitted live node is left where it is; a gone node is skipped +
  counted; an addressed frame gets the saved rect and is NOT re-fitted (a fit would drift it every
  restore), while an unmentioned frame whose descendant just moved IS re-fitted, deepest first, so an
  out-of-layout child cannot be clamped by `extent:'parent'`. ONE transform, explicit two-pass (resolve
  every root origin, then emit) — a reduce re-fits an ancestor mid-stream. `collapsed` restores the
  CHROME height + the real one in `expandedHeight` (else a save-while-collapsed shrinks the node
  permanently); `premaxRect` rides the spread untouched.
- **Camera applied with `setViewport`, NEVER `fitView`** (the "Go to node" invariant in `canvas.md`; a
  just-rearranged canvas is the unmeasured state where a queued fit flies to the origin). This machine's
  recorded camera wins; a first-time restore (a teammate's, or one saved elsewhere) gets
  `layoutFramingViewport` (the core `framingViewport` rule rewritten locally — no renderer import into
  `src/core` — and since a layout's rects are ROOT-space, every entry anchors the camera).
- **`CanvasLayout.window` is a LABEL, never a matcher.** Nothing auto-applies on a display change — the
  file travels, so matching would pick a stranger's monitor.
- **Cap 20** (`CANVAS_LAYOUTS_CAP`), name 60, both sanitized on BOTH serializer seams (peer mutation
  reaches live node data). `sanitizeLayouts` DROPS a layout whole rather than repairing it (a repaired
  one no longer matches its name; a non-finite coord is a white-screen crash in `adoptUserNodes`).
- **Downgrade:** an older build drops `layouts` on its first save (`projectToFile` does not know the
  field); machine-local cameras prune to match on the next load.
- **Surfaces:** Desktop full; Server full, NO new IPC; relay tabs REFUSED with the reason ("Layouts are
  managed on the host"); kanban N/A; mobile N/A (iOS follow-up).
