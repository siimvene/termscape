---
paths:
  - "src/core/git-service*.ts"
  - "src/core/commit-message*.ts"
  - "src/core/remote-ssh/remote-git.ts"
  - "src/shared/worktree*.ts"
  - "src/shared/scm-scope.ts"
  - "src/renderer/components/SourceControlPanel.tsx"
  - "src/renderer/state/worktrees.ts"
  - "src/renderer/state/scmCache.ts"
  - "src/renderer/state/scmDraft.ts"
  - "src/core/git-env.ts"
---
# Source Control panel, AI commit messages, git worktrees bound to group frames

> Moved verbatim from the root `CLAUDE.md` on 2026-09-01 (see its "How this documentation is
> organized" section). Loads automatically when a file matching the `paths` above is read;
> when the root routing table points here, read this file before touching the subsystem.
<!-- moved-verbatim-from: CLAUDE.md -->

- **Source Control** (`main/git-service.ts` system `git` + `gh`, `SourceControlPanel.tsx`,
  ⎇): file-level **stage/unstage** (+/−), **discard**, click a file → **diff node**,
  **branch switch/create**, commit (message box at top) + push / sync / publish, **gh
  sign-in** banner (runs `gh auth login` in a new terminal via `initialCommand`), recent
  commits. **AI commit message** (✦ Generate) and **AI terminal naming** both use
  `main/commit-message.ts`: a BYO local agent CLI (claude/codex/custom) spawned read-only on
  the staged diff / captured terminal output (no built-in model); agent + extra prompt in
  Settings. The panel operates on a **selected scope**, not on the project cwd — see Worktrees.
  **Open latency + reopen**: `status()` must never await `gh auth status` — it hits the GitHub
  API (~700ms) and used to hold the panel's first paint hostage; `ghAuthedSwr()` returns the
  cached answer and refreshes in the background (the accurate `ghAuthed()` is still awaited on
  the publish flow). Status/history live in the per-cwd `state/scmCache.ts` store (same pattern
  as `scmDraft`), so the close→reopen cycle paints the last-known data instantly while the
  mount refresh replaces it silently — do not move them back into component `useState`.
- **Worktrees** (bound to **group frames**) — a git worktree binds to a group node
  (`data.worktree: GroupWorktree {repoPath, branch, baseRef, path, createdByApp}`, persisted), and
  every node created inside that frame inherits the worktree path as its `cwd`
  (`cwdForNewNodeIn`) — the frame *is* the binding, so an agent per branch is just a group per
  branch. Creation is **one step** — **"New worktree…"** from the pane menu / command palette /
  Source Control — with the repo resolved from the project cwd via `git.repoRoot()` and existing
  worktrees listed for adoption. (Both git IPCs existed before this feature and had **zero**
  renderer callers, which is why it was unusable: the dialog's repo field was always empty and had
  to be typed by hand. Don't re-strand them.)
  - **Default location** — `settings.worktreePathTemplate` is a machine-global Behavior setting,
    expanded only by `shared/worktree.computeWorktreePath` for both the dialog and canvas-control
    CLI. It is relative to the repo root and supports `$repoName` (`$reponame` /
    `$defaultFolderName` aliases) and `$branch` in bare or `${…}` form. If branch is omitted, its
    safe slug is appended automatically. The shipped `../${repoName}.worktrees/${branch}` keeps
    worktrees beside — not nested inside — the main checkout. There is no general project-settings
    surface today, so the setting is intentionally global rather than hidden in a one-off menu.
  - **One store, one poller** — `renderer/state/worktrees.ts` is the **only** caller of the worktree
    /status *read* IPCs (`git.repoRoot`, `git.worktreeList`, `git.status`); the group chip, the
    creation dialog and the Source Control panel all read that store. Three independent pollers would
    triple the `git` subprocess load and drift out of sync. It is **epoch-guarded** (a project switch
    bumps the epoch, so a stale in-flight refresh can never overwrite the newer project's
    `repoRoot`/orphans — worktrees are *created* under `repoRoot` and orphans are offered for
    *deletion*) and **fails open**. Exactly **two** direct `git.status` reads live outside it, both in
    `Canvas.tsx` and both deliberate: the one-shot probes on the **Remove** confirm (the dirty-file
    count in the warning) and on **↪ Move into worktree** (staleness only arrives by poll, so the
    directory is re-checked immediately before an irreversible session kill). Anything recurring
    belongs in the store.
  - **Scoped Source Control** — the panel operates on a selected `ScmScope` (the main checkout or a
    bound worktree). A worktree scope's **id is its group node id**, which is what lets the canvas
    selection preselect it. `scmScopes` / `defaultScmScope` / `selectedScmGroupId`
    (`shared/scm-scope.ts`) decide the list and the default. The panel derives its `cwd` **once** so
    its ~49 call sites follow — and every Canvas callback it invokes (`onOpenDiff`,
    `onOpenCommitDiff`, `onExplainCommit`, `onRunInTerminal`) must take the **scope's** cwd, never
    the project's.
  - **Reconciliation** (`shared/worktree-reconcile.ts`) — bindings are reconciled against `git
    worktree list`: a worktree deleted outside the app makes its group **stale** (chip reads
    "· missing", Merge/Remove hide, ↪ hides, and nothing spawns into the dead path — Unbind is the
    only action, and it takes the dead cwd off the children with it); a worktree bound to no group
    is an **orphan**, recoverable from the creation dialog.
  - **Two non-obvious facts the code depends on — do not "simplify" these away:**
    1. `git worktree list --porcelain` **keeps listing a worktree whose directory was deleted
       behind git's back**, tagging it `prunable` — and that tag only exists on **git ≥ 2.36**. So
       `worktreeList` additionally **stats** each path through an injected `pathExists` seam
       (`prunable: e.prunable || !pathExists(path)`; `git-service` wires `fs.existsSync`), or the
       whole stale/orphan story silently fails on the Server Edition's own target platform (Debian 11
       / Ubuntu 20.04 ship git 2.30).
    2. **A failed git read is never evidence of absence.** `listWorktrees` returns `{ok, entries}`
       so "git failed" (spawn EAGAIN, NFS hiccup, corrupt index) stays distinguishable from "git
       listed nothing" — a transient failure must never be read as "the worktree is gone", at any
       layer (`ok:false` changes no facts). Staleness from the status poll likewise needs **two
       consecutive** failed reads (`WORKTREE_STALE_STRIKES`), and the streak is scoped per project
       so a there-and-back tab switch cannot forget it.
  - **Destructive safety** — `createdByApp` gates removal: nodeterm deletes only worktrees it
    created; one the user merely **adopted** unbinds by default, and deleting its directory is an
    explicit opt-in that **defaults to off** (its branch is kept either way).
    `isDangerousWorktreeRemovalPath` refuses a path that is the repo, `$HOME`, `/`, or an ancestor
    of any of them, on **every** removal path. **Merge** always confirms — it merges into the base's
    *working tree* (`decideMergeStrategy`: merge in the base's checkout when it is clean, else a
    `fetch . branch:base` when the base is checked out nowhere, else blocked) — and its push to
    `origin/<base>` is disclosed in that dialog and **opt-in, default off**: a push to origin cannot
    be politely undone.
  - **Every path that drops a bound group goes through unbind** — Unbind, Remove, **Ungroup** and
    **Delete** all route through `releaseWorktreeBinding`, the one place that knows what a dropped
    binding owes: `displacedByWorktree`'s descendants (terminals whose cwd sits inside the
    worktree) get that cwd taken off them, and git's registration gets a `pruneOnly` prune. Ungroup
    and group-delete *keep* the children, so skipping this left a **dead cwd persisted in
    `project.json`** — invisible until a reboot cold-starts the terminal into a directory that is not
    there — and left a stale registration that makes a later `worktree add` at the same path fail.
  - **SSH projects: not supported in v1** — every affordance is shown **disabled with that reason**
    (a silently-missing row teaches nothing). The gate asks whether the node is a **remote session**
    (`data.ssh` / `data.sshRemoteTmux`) or the project is an SSH project — **not** `data.remote`,
    which only *relay* nodes carry: guarding the wrong field let a live remote tmux session be
    killed into a local path that does not exist on the host (`isRemoteSessionNode` asks about all
    three). The ops themselves **refuse** a remote repo (`git-service.isRemoteRepo`, via
    `resolveGitRemote`) rather than guess: the `git` executor routes over the project's ControlMaster
    while `pathExists` is a **local** `fs.existsSync`, so answering would stat the wrong machine and
    report *everything is gone* — a refusal is a plain failed op and, crucially, never `worktreeGone`,
    so nothing is destroyed on a bad guess. Real support needs the worktree path to derive from the
    connection's cached `remoteHome` and `pathExists` to stat the **remote** fs (a `test -e` over the
    ControlMaster).
  - **Mobile companion: not applicable in v1** (the three-surfaces call, made deliberately). A
    worktree binds to a **group frame** on the canvas, and *nodeterm mobile* (separate repo, `nodeterm-ios`)
    has no canvas — it attaches to tmux sessions over the `TerminalTransport` protocol, which carries
    no group/binding concept at all. So there is nothing to degrade gracefully: a worktree's terminals
    are ordinary tmux sessions and mobile already reaches them, it simply cannot see that they belong
    to a worktree. Surfacing the binding (a read-only "worktree: <branch>" label per session, say)
    would mean extending the transport protocol — a **follow-up in the iOS repo**, not this branch.
    Creation/merge/remove stay desktop+server only: they are destructive git operations, and a phone
    is the last place to confirm one.
  - **Known follow-up** — the Explorer tree and the ⌘K file index stay scoped to the **project cwd**,
    so a bound worktree's files are not browsable/searchable from them (its terminals and editor
    nodes work fine). Deliberately out of scope here: both index a single root, and making them
    scope-aware is the same "which checkout am I looking at?" question Source Control already answers
    with `ScmScope` — that is the seam to reuse when it is built.
