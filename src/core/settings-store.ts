import { readFileSync, statSync } from "fs";
import path from "path";
import { writeFileAtomic } from "./fs-atomic";
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

/** The shape every shell-owned account row shares: an id, and a login-resolution flag. */
interface OwnedAccountRow {
  id: string;
  label?: string;
  pending?: boolean;
}

/**
 * The slice of `SettingsStore` an account service needs: the live cache, and the read-modify-write
 * that is the ONLY writer of a shell-owned account list's membership. Narrow on purpose — the
 * desktop passes its real store, the Server Edition its own, and a test a store over a temp dir.
 */
export interface AccountRowStore {
  get(): Settings;
  mutate(fn: (current: Settings) => Settings): Promise<Settings>;
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
 *    back would re-label a resolved account "New account" for as long as the stale tab lives.
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
    } else if (edited.pending && edited.label === placeholderLabel) {
      // Stale on resolution AND still carrying the placeholder: not an edit, the capture's label
      // stands. (A non-placeholder label from the same stale tab was taken above.)
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
   * re-reads — the safe direction. A missing or unparseable file yields the CACHE as the base (a
   * fresh install has nothing on disk yet, and a corrupt file must not be "repaired" by a mutate
   * that wipes every setting to the defaults) with a null stamp, which never matches a later
   * stat, so such a write is re-checked once and then lands.
   */
  private readDisk(): DiskRead {
    const stamp = this.diskStamp();
    if (stamp === null) return { base: this.cache, stamp: null };
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      return { base: mergeSettings(JSON.parse(raw)), stamp };
    } catch {
      return { base: this.cache, stamp: null };
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
   * Read-modify-write against the FILE. `apply` runs on what is on disk right now (merged like
   * `init` merges it), and the result is written only if the file has not changed since that
   * read; if it has, the loop re-reads and re-applies (bounded — after `RMW_MAX_RETRIES` it
   * writes anyway rather than spin against a hot writer, so the LAST retry can still lose to a
   * write that lands in the window below).
   *
   * WHAT THIS DOES AND DOES NOT GUARANTEE. Within one process the chain makes every write see
   * every earlier one — that part is exact. Across processes sharing a directory the re-read
   * shrinks the lost-update window from "however long this process's cache has been stale"
   * (whole user think-time) to the gap between the stamp check and `writeFileAtomic`'s rename —
   * microseconds to a few milliseconds — and the stamp check catches a write that lands anywhere
   * before it. It is a check-then-act, not a lock: a write by another process inside that final
   * gap is still overwritten, silently. The complete fix is an advisory lock held across
   * read + rename (`flock`, which Node does not expose without a native dependency) or a
   * version counter inside the file that the rename is conditioned on; neither is done here.
   */
  private async readModifyWrite(
    apply: (base: Settings) => Settings,
  ): Promise<Settings> {
    for (let attempt = 0; ; attempt++) {
      const { base, stamp } = this.readDisk();
      const next = mergeSettings(apply(base));
      if (attempt < RMW_MAX_RETRIES && this.diskStamp() !== stamp) continue;
      return this.persist(next);
    }
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
