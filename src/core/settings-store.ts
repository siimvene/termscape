import { readFileSync, statSync } from "fs";
import path from "path";
import { writeFileAtomic } from "./fs-atomic";
import { withFileLock } from "./file-lock";
import { IPC } from "../shared/ipc";
import { platform } from "./platform";
import {
  DEFAULT_SETTINGS,
  NEW_CLAUDE_ACCOUNT_LABEL,
  type ClaudeAccount,
  type Settings,
} from "../shared/types";
import { NEW_CODEX_ACCOUNT_LABEL, type CodexAccount } from "../shared/codex-account";

/**
 * Merge a possibly-partial/legacy `Settings` object over `DEFAULT_SETTINGS`. A plain
 * `{ ...DEFAULT_SETTINGS, ...saved }` shallow merge is right for top-level keys (a missing key
 * picks up the default), but WRONG for nested objects: an old `settings.json` that has a
 * `speech` object without a newly-added key (e.g. `shortcut`) would have its whole `speech`
 * object override the default one-for-one, silently dropping the new key. Nested settings are
 * merged one level deeper so old files still pick up new defaults.
 */
function mergeSettings(saved: Partial<Settings> | null | undefined): Settings {
  const merged = { ...DEFAULT_SETTINGS, ...saved };
  merged.speech = { ...DEFAULT_SETTINGS.speech, ...saved?.speech };
  merged.modelGateway = {
    ...DEFAULT_SETTINGS.modelGateway,
    ...saved?.modelGateway,
  };
  // One-shot dictation migration: a customized legacy `speech.shortcut` becomes the
  // `speech.dictation` override that every consumer now reads (renderer lib `dictationBinding()`).
  // Once the key exists — user-set, seeded, or explicitly disabled (`[]`) — it is the truth and
  // this never runs again; the legacy field lives on only as a downgrade mirror (the renderer
  // write path keeps it in sync so an older build still finds the user's chord).
  // A shortcut EQUAL to the default seeds nothing: the override would only restate what the
  // registry already says, and would then pin that chord against any future default change.
  // **The seeded value survives the read path.** `speech.dictation` has its OWN conflict bucket
  // (`conflictBucket` in shared/keybindings.ts), so it can never be a participant in a
  // cross-command collision, and the READ path's sanitizer (`sanitizeKeybindingOverrides`) has
  // nothing to strip — neither the seed nor the user's own override on the same chord. (It used
  // not to: both were deleted on load, and dictation silently fell back to the registry default.)
  // What a shared chord costs is PRECEDENCE, not the binding: dictation's own keyed listener
  // claims it first in plain app focus, and the other command still gets it everywhere dictation
  // does not listen — terminal focus, say. That is exactly the pre-migration behavior of a legacy
  // `speech.shortcut` that happened to match an app chord, which is what this seed must preserve.
  if (
    merged.speech.shortcut !== DEFAULT_SETTINGS.speech.shortcut &&
    !(merged.keybindings && "speech.dictation" in merged.keybindings)
  ) {
    merged.keybindings = {
      ...(merged.keybindings ?? {}),
      "speech.dictation": [merged.speech.shortcut],
    };
  }
  // One-shot markdown-preview default flip (#495, maintainer decision): every file written
  // before the flip gets `openMarkdownPreview: true` exactly once — INCLUDING one saved by
  // v0.3.3, the sole release that defaulted off, whose full-snapshot saves materialized `false`
  // for users who never touched the toggle (indistinguishable from an explicit off, so the
  // absent-key merge alone could not reach them). The stamped `openMarkdownPreviewMigrated`
  // is what makes it one-shot: once present, the stored value is the user's own and an opt-out
  // is permanent. Same shape as the dictation seed above — keyed on the marker's absence in
  // the SAVED file, never on the merged value.
  if (!saved?.openMarkdownPreviewMigrated) {
    merged.openMarkdownPreview = true;
    merged.openMarkdownPreviewMigrated = true;
  }
  // Legacy `terminalGpuRendering` was a boolean whose default (true) was merged into every saved
  // file — so a stored `true` is indistinguishable from "never touched" and maps to the new
  // 'auto' (platform-aware) default, while a stored `false` was always an explicit escape-hatch
  // choice and stays 'off'. See the field's doc in shared/types.ts.
  //
  // Every value that is not one of the four known modes ('auto' | 'on' | 'off' | 'shared')
  // normalizes to the DEFAULT: settings.json is hand-editable, and an unrecognised mode must not
  // be handed to the renderer's resolver to interpret.
  const gpu = (saved as { terminalGpuRendering?: unknown } | null | undefined)
    ?.terminalGpuRendering;
  if (gpu === false) merged.terminalGpuRendering = "off";
  else if (gpu !== "on" && gpu !== "off" && gpu !== "auto" && gpu !== "shared")
    merged.terminalGpuRendering = "auto";
  return merged;
}

/** Thrown by a write path when the settings file EXISTS but its bytes could not be parsed. Such a
 *  file may be recoverable by hand, so a mutate/save refuses rather than publishing defaults over
 *  it — see `readDisk`. A MISSING file is not this: it yields the defaults base and writes. */
export class SettingsCorruptError extends Error {
  constructor(filePath: string) {
    super(`Refusing to overwrite an unparseable ${filePath} with defaults`);
    this.name = "SettingsCorruptError";
  }
}

/** Thrown when a cross-process write kept losing the race to another writer past the retry budget.
 *  The write is abandoned, never landed with a stale base — a failed save stays failed. */
export class SettingsWriteConflictError extends Error {
  constructor(filePath: string) {
    super(`Gave up persisting ${filePath}: it kept changing under the read-modify-write`);
    this.name = "SettingsWriteConflictError";
  }
}

/** Thrown by a write path when settings.json EXISTS but could not be READ this instant — a transient
 *  EPERM/EACCES/EIO on stat or read of a file that is still there. Only `ENOENT` (a genuinely
 *  missing file) counts as "missing" and may write defaults; any OTHER error is refused exactly like
 *  the unparseable case (`SettingsCorruptError`), because publishing defaults over a file we merely
 *  failed to read this instant is the same data loss on a different trigger. See `readDisk`. */
export class SettingsUnreadableError extends Error {
  readonly code: string;
  constructor(filePath: string, cause: unknown) {
    super(`Refusing to overwrite ${filePath}: it exists but could not be read`);
    this.name = "SettingsUnreadableError";
    this.code = codeOf(cause);
  }
}

/** The `.code` of a Node fs error, or "" when there is none. */
function codeOf(err: unknown): string {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : "";
}

/** The shape every shell-owned account row shares: an id, and a login-resolution flag. `labelEdited`
 *  is a transient renderer HINT (never persisted here) — see the placeholder branch in
 *  `reconcileOwnedAccountList`. */
interface OwnedAccountRow {
  id: string;
  label?: string;
  pending?: boolean;
  labelEdited?: boolean;
}

/**
 * The slice of `SettingsStore` an account service needs: the live cache, and the read-modify-write
 * that is the ONLY writer of a shell-owned account list's membership. Narrow on purpose — the
 * desktop passes its real store, the Server Edition its own, and a test a store over a temp dir.
 */
export interface AccountRowStore {
  get(): Settings;
  mutate(fn: (current: Settings) => Settings): Promise<Settings>;
  /** The on-disk account membership, read under the RMW lock — the AUTHORITATIVE list, not this
   *  process's (possibly stale) cache. Account removal reads a row's provenance (`host`) from here
   *  so a stale cache cannot route another process's REMOTE account down the local teardown path
   *  (leaving an authenticated dir orphaned on the host). Rejects with `SettingsUnreadableError` /
   *  `SettingsCorruptError` exactly as a write would, failing the removal closed rather than acting
   *  on membership it could not read. */
  readAccountsFromDisk(): Promise<Settings>;
}

/**
 * The fields of a shell-owned account row the RENDERER may still write through its snapshot save:
 * the display edits (label, color) and the login-capture payload (email). Everything else on the
 * row — `id`, `host`, `createdAt`, and whatever a later field turns out to be — is the shell's,
 * and a snapshot cannot change it. `host` is the one that matters: it is what removal reads to
 * decide whether the credential home is on THIS machine (deleted) or on an SSH host (left alone),
 * and `settings:save` is reachable by a paired relay peer (it is not in `HOST_ONLY_CHANNELS`), so
 * a snapshot that could rewrite `host` could turn a local account into one whose home is never
 * deleted while the UI reports the removal as complete.
 */
const RENDERER_OWNED_FIELDS = ["label", "color", "email"] as const;

/**
 * Reconcile a SHELL-OWNED account list against a renderer snapshot. The renderer's `settings:save`
 * is a full snapshot of whatever that tab loaded plus its own edits, and two tabs (Server Edition)
 * or a tab and the shell (an add / remove verb) can hold different lists at once. Membership is the
 * shell's, so:
 *  - a row only the CACHE has is kept (it was added through `mutate` after the snapshot was taken);
 *  - a row only the SNAPSHOT has is dropped (the renderer cannot mint a row — it goes through
 *    `mutate` — and a snapshot that predates a removal cannot bring the row back);
 *  - a row both have is merged FIELD BY FIELD: the shell-owned fields (`id`, `host`, `createdAt`,
 *    …) come from the cache, only `RENDERER_OWNED_FIELDS` are taken from the snapshot (a key that
 *    is present, even as `undefined`, is an edit — that is how a color is cleared; an absent key
 *    is not one, and keeps the cache's value);
 *  - login resolution is MONOTONIC: a snapshot may flip a row `pending → resolved` (that flip is
 *    the renderer's capture, and it carries the email), but a snapshot that still says `pending`
 *    for a row the cache has already resolved predates the capture and cannot un-resolve it. Its
 *    label is still an edit the user may have typed in that stale tab, so it is honoured — EXCEPT
 *    when it is the mint-time placeholder, which the capture replaced with the email: taking that
 *    back would re-label a resolved account "New account" for as long as the stale tab lives. That
 *    "unedited" judgement no longer rests on the label STRING (a user who names an account exactly
 *    "New account" would have lost it): the renderer stamps `labelEdited` on a row the user
 *    actually renamed, and an explicitly-edited placeholder is taken like any other edit.
 */
function reconcileOwnedAccountList<T extends OwnedAccountRow>(
  cache: readonly T[] | undefined,
  snapshot: unknown,
  placeholderLabel: string,
): T[] {
  const incoming = new Map<string, T>();
  if (Array.isArray(snapshot)) {
    for (const row of snapshot as T[]) {
      if (row && typeof row === "object" && typeof row.id === "string") {
        incoming.set(row.id, row);
      }
    }
  }
  return (cache ?? []).map((row) => {
    const edited = incoming.get(row.id);
    if (!edited) return row;
    const next: T = { ...row };
    for (const field of RENDERER_OWNED_FIELDS) {
      if (field in edited) (next as Record<string, unknown>)[field] = edited[field as keyof T];
    }
    if (row.pending) {
      // Still pending in the cache: the snapshot may resolve it (or leave it pending).
      if ("pending" in edited) next.pending = edited.pending;
      else delete next.pending;
    } else if (edited.pending && edited.label === placeholderLabel && !edited.labelEdited) {
      // Stale on resolution AND still carrying the placeholder AND not explicitly edited: not an
      // edit, the capture's label stands. (A non-placeholder label — or a placeholder the user
      // deliberately typed, flagged `labelEdited` — from the same stale tab was taken above.)
      next.label = row.label;
    }
    return next;
  });
}

/** What `readDisk` saw. `stamp` identifies the file version the base was read from; null when the
 *  file was absent or unreadable (then `base` is the cache — see `readDisk`). */
interface DiskRead {
  base: Settings;
  stamp: string | null;
}

/** Bounded re-reads when another PROCESS lands a write between our read and our write. */
const RMW_MAX_RETRIES = 3;

/**
 * Stores user settings in settings.json. Keeps a synchronous cache so the PtyManager
 * can read shell/tmux preferences immediately at terminal creation.
 *
 * Two write paths, one FIFO chain, one persist:
 *  - `save(snapshot)` — the renderer's full snapshot. Every key is taken as sent EXCEPT the
 *    shell-owned account lists, which are reconciled against the store's own membership
 *    (`reconcileOwnedAccountList`).
 *  - `mutate(fn)` — the shell's own read-modify-write: `fn` runs against the LATEST settings, on
 *    the chain, and its result is persisted as-is. Membership of `codexAccounts` and
 *    `claudeAccounts` is written only here (`codex-accounts-service.ts` /
 *    `claude-accounts-service.ts` add/remove), so two concurrent adds compose instead of racing.
 *
 * "Latest" means the FILE, not this process's cache (`readModifyWrite`). The chain serializes
 * writers inside ONE process; a second process on the same directory (two Server Edition
 * instances on one `--data-dir`, or a desktop sharing it — docs/atomic-writes.md) has its own
 * cache and its own chain, and a mutate applied to a cache that another process has since
 * overtaken would publish that process's add straight out of existence. Every write therefore
 * re-reads settings.json first and applies itself to what is actually on disk.
 */
export class SettingsStore {
  private cache: Settings = DEFAULT_SETTINGS;
  private listeners = new Set<(s: Settings) => void>();
  /** In-flight save chain: saves run FIFO (same idiom as WorkspaceStore.saveChain). The handler
   *  has overlapping callers in both builds (the renderer's coalesced timer save, the
   *  `beforeunload` flush, concurrent WS frames on the Server Edition); unordered, the last RENAME
   *  wins the disk while the last CALL wins the cache — and they can disagree until next boot.
   *  Each caller still sees only ITS OWN save's failure. */
  private saveChain: Promise<unknown> = Promise.resolve();

  private get filePath(): string {
    return path.join(platform().userDataDir, "settings.json");
  }

  /** Subscribe to saves (fires after each successful `settings:save`). Additive; used by the
   *  desktop shell to create/destroy runtime-toggled subsystems (e.g. the Notch HUD). Returns an
   *  unsubscribe. Never throws into a save. */
  onChange(cb: (s: Settings) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Load synchronously into cache (call after app is ready). */
  init(): void {
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      this.cache = mergeSettings(JSON.parse(raw));
    } catch {
      this.cache = DEFAULT_SETTINGS;
    }
  }

  get(): Settings {
    return this.cache;
  }

  /** Persist a full settings snapshot. Public so startup migrations can use the exact same atomic
   *  FIFO writer as renderer IPC instead of reaching into the cache or duplicating disk semantics.
   *  The shell-owned account lists are reconciled against the cache, never replaced — see
   *  `reconcileOwnedAccountList`. */
  save(settings: Settings): Promise<void> {
    return this.enqueue(() => this.saveNow(settings)).then(() => undefined);
  }

  /**
   * Read-modify-write on the save chain: `fn` sees the LATEST settings — re-read from disk, so a
   * write another process landed since this one's cache was filled is part of the base (every
   * earlier save or mutate of THIS process has landed too, by the chain) — and its result is
   * persisted verbatim. This is the only path that changes the MEMBERSHIP of a shell-owned
   * account list. `fn` must be pure: it is re-run against a fresh read when a concurrent write is
   * detected (`readModifyWrite`). A throw from `fn` rejects this call and leaves the cache and the
   * disk untouched; the chain survives for the next caller. Resolves with what was persisted.
   */
  mutate(fn: (current: Settings) => Settings): Promise<Settings> {
    return this.enqueue(() => this.readModifyWrite((base) => fn(base)));
  }

  /** See `AccountRowStore.readAccountsFromDisk`. A pure read under the same cross-process lock the
   *  RMW takes — NOT on the save chain, so it competes with this process's writers for the lock
   *  (waiting ms) rather than queueing behind them. `readDisk` yields the on-disk settings (or the
   *  cache with a null stamp when the file is genuinely absent — a fresh install has no accounts to
   *  route), and throws on an unreadable/corrupt file so the caller fails closed. */
  readAccountsFromDisk(): Promise<Settings> {
    return withFileLock(this.filePath, async () => this.readDisk().base);
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.saveChain.then(job);
    this.saveChain = run.catch(() => {});
    return run;
  }

  registerIpc(): void {
    platform().handle(IPC.settingsLoad, () => this.cache);
    platform().handle(IPC.settingsSave, (settings: Settings) =>
      this.save(settings),
    );
  }

  private saveNow(settings: Settings): Promise<Settings> {
    // Membership of these lists is the shell's: `mutate` above is the only writer that adds or
    // removes a row (`codex-accounts-service.ts` and `claude-accounts-service.ts`, add / remove).
    // The reconcile runs against the settings ON DISK, not this process's cache, for the same
    // reason `mutate` does — a snapshot save is the write most likely to be stale across two
    // processes, and its job here is to carry display edits, never to decide membership.
    return this.readModifyWrite((base) => {
      const next = mergeSettings(settings);
      next.codexAccounts = reconcileOwnedAccountList<CodexAccount>(
        base.codexAccounts,
        settings?.codexAccounts,
        NEW_CODEX_ACCOUNT_LABEL,
      );
      next.claudeAccounts = reconcileOwnedAccountList<ClaudeAccount>(
        base.claudeAccounts,
        settings?.claudeAccounts,
        NEW_CLAUDE_ACCOUNT_LABEL,
      );
      return next;
    });
  }

  /**
   * The settings currently ON DISK, plus a stamp naming that file version. The stamp is taken
   * BEFORE the bytes are read: if a rename lands in between, the stamp is the older file's and
   * the bytes the newer's, so the pre-write comparison in `readModifyWrite` sees a change and
   * re-reads — the safe direction.
   *
   * Two absences are DIFFERENT, and conflating them is the corrupt-file bug:
   *  - MISSING (ENOENT, or ENOENT-vanished between the stat and the read): a fresh install has
   *    nothing on disk yet, so the CACHE is the base with a null stamp (which never matches a later
   *    stat, so the write is re-checked once and then lands). This is the ONLY case that may write
   *    defaults.
   *  - EXISTS-BUT-UNREADABLE (any non-ENOENT stat/read error — EPERM/EACCES/EIO): the file is there
   *    but a transient error stopped us reading it. Treating that as "missing" and repairing to
   *    defaults is the same data loss as the corrupt case on a different trigger, so we THROW
   *    `SettingsUnreadableError` — never persist defaults over a file we simply could not read.
   *  - EXISTS-BUT-UNPARSEABLE: the file has bytes we could not parse — possibly a recoverable
   *    hand-edit or partial write. Persisting defaults over it is data loss, so we THROW
   *    `SettingsCorruptError` and the write refuses rather than "repairs". (An EMPTY file carries
   *    nothing to lose and is treated as defaults, matching `init`.)
   */
  private readDisk(): DiskRead {
    let stamp: string;
    try {
      const st = statSync(this.filePath);
      stamp = `${st.ino}:${st.mtimeMs}:${st.size}`;
    } catch (err) {
      if (codeOf(err) === "ENOENT") return { base: this.cache, stamp: null };
      throw new SettingsUnreadableError(this.filePath, err);
    }
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf-8");
    } catch (err) {
      // Vanished between the stat and the read: genuinely missing.
      if (codeOf(err) === "ENOENT") return { base: this.cache, stamp: null };
      // Any other read error (EPERM/EACCES/EIO) on a file that just stat'd fine: refuse.
      throw new SettingsUnreadableError(this.filePath, err);
    }
    if (raw.trim() === "") return { base: mergeSettings(null), stamp };
    try {
      return { base: mergeSettings(JSON.parse(raw)), stamp };
    } catch {
      throw new SettingsCorruptError(this.filePath);
    }
  }

  /** Identity of the file version on disk: inode + mtime + size. A `writeFileAtomic` publishes a
   *  NEW inode (temp file, renamed over), so a concurrent atomic writer changes the stamp even on
   *  a filesystem with coarse mtime; null when the file does not exist. */
  private diskStamp(): string | null {
    try {
      const st = statSync(this.filePath);
      return `${st.ino}:${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  }

  /**
   * Read-modify-write against the FILE, under a CROSS-PROCESS lock held across the whole read +
   * write (`withFileLock` on `lockPath`, docs/atomic-writes.md). `apply` runs on what is on disk
   * right now (merged like `init` merges it), and its result is persisted.
   *
   * WHAT THIS GUARANTEES. Within one process the FIFO chain makes every write see every earlier
   * one. Across processes sharing a directory, the lock makes each process's read + rename
   * atomic with respect to every OTHER process that also takes it (both write paths here do), so
   * no cooperating writer's change is lost — closing the check-then-act window the previous
   * version left open. The lock is advisory: a writer that does NOT take it (a raw external write)
   * is still not serialized, so the stamp re-read below stays as a second line of defence and, on
   * detecting such a landed write, RE-RUNS `apply` against it (bounded by `RMW_MAX_RETRIES`).
   *
   * NEVER PERSISTS STALE. If the base kept changing under us past the retry budget (a hot
   * non-cooperating writer), or the lock could not be acquired in time, the write is ABANDONED
   * with a throw (`SettingsWriteConflictError` / `FileLockTimeoutError`), not landed on top of a
   * base it never saw — a failed save stays failed, which is the contract callers like
   * `codex-accounts:add`'s rollback depend on. A genuinely corrupt or unreadable file THROWS from
   * `readDisk` before any write, so defaults are never published over recoverable bytes.
   *
   * CROSS-PROCESS EXCLUSION rests on `withFileLock` (proper-lockfile: an atomic `mkdir` lock kept
   * fresh by an mtime heartbeat, with compromise detection). A holder broken out from under it —
   * the stale-break race, or a heartbeat that missed its window — is DETECTED and the write is
   * FLAGGED (`FileLockCompromisedError`): the atomic rename may already have landed (last-writer-wins,
   * never torn), so this signals a non-exclusive write for the caller to retry, it does not prevent
   * it — turning the hand-rolled lock's SILENT double-acquire into a loud, recoverable one. A
   * cross-process add/add therefore no longer silently loses a row. Single-process is covered by the
   * FIFO chain regardless.
   */
  private readModifyWrite(
    apply: (base: Settings) => Settings,
  ): Promise<Settings> {
    return withFileLock(this.filePath, async () => {
      for (let attempt = 0; ; attempt++) {
        const { base, stamp } = this.readDisk();
        const next = mergeSettings(apply(base));
        if (this.diskStamp() === stamp) return this.persist(next);
        if (attempt >= RMW_MAX_RETRIES) throw new SettingsWriteConflictError(this.filePath);
      }
    });
  }

  /** Write, then publish: the cache takes the new value only once it is on disk, so a failed write
   *  leaves memory and disk agreeing on the OLD settings (a `mutate` whose write fails has changed
   *  nothing, which is what lets `codex-accounts:add` roll its minted home back). */
  private async persist(next: Settings): Promise<Settings> {
    // Atomic write (temp + rename) so a mid-write crash can't corrupt settings.json. The temp
    // name is unique per call because nothing serializes this handler and its callers overlap:
    // on the desktop the renderer's coalesced timer save, the `beforeunload` flush that fires
    // outside that window, and any still-in-flight earlier save are all fire-and-forget
    // (src/renderer/state/settings.ts); on the Server Edition every WS frame is dispatched
    // concurrently (src/server/ws.ts), so even one browser tab can have two saves in the air.
    // With a shared name, one writer's rename publishes the other's half-written bytes, or moves
    // the file out from under it entirely. writeFileAtomic covers all of it: a per-call unique
    // temp, 0600 at open(2) before any bytes land (the rename carries it onto settings.json —
    // CodeQL's js/insecure-temporary-file flagged the old default-mode outlier here), a rename
    // that retries Windows sharing violations, and temp cleanup on failure. The error still
    // propagates, so a failed save stays a failed save — and the listeners below still only run
    // on success. There is deliberately no sweep of orphans from killed processes as
    // provider-cookie does: an orphaned settings temp is config litter, not a live credential.
    await writeFileAtomic(this.filePath, JSON.stringify(next, null, 2), {
      mode: 0o600,
    });
    this.cache = next;
    for (const cb of this.listeners) {
      try {
        cb(this.cache);
      } catch {
        // A listener must never break a settings save (or its siblings).
      }
    }
    return next;
  }
}
