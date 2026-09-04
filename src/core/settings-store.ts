import { readFileSync } from "fs";
import path from "path";
import { writeFileAtomic } from "./fs-atomic";
import { IPC } from "../shared/ipc";
import { platform } from "./platform";
import { DEFAULT_SETTINGS, type Settings } from "../shared/types";
import type { CodexAccount } from "../shared/codex-account";

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
  pending?: boolean;
}

/**
 * Reconcile a SHELL-OWNED account list against a renderer snapshot. The renderer's `settings:save`
 * is a full snapshot of whatever that tab hydrated, so with two Server Edition tabs (or a tab and
 * its reload) the later save REPLACES the earlier one's rows: an account tab A added (and whose
 * credential home tab A's `add` already minted on disk) vanished from settings when tab B, still
 * holding the snapshot from before, saved a label edit — an authenticated `auth.json` nothing can
 * list, switch to, or remove. Union by id would fix the loss but resurrect a removed row for the
 * same reason. So MEMBERSHIP is the cache's alone:
 *
 *  - a row only the cache has is KEPT (the renderer cannot drop a row; `remove` goes through
 *    `mutate`, below);
 *  - a row only the snapshot has is DROPPED (the renderer cannot add a row; `add` goes through
 *    `mutate` — and a snapshot that predates a removal cannot bring the row back);
 *  - a row both have takes the snapshot's FIELDS (label, color: the edits the renderer still owns),
 *    EXCEPT that login resolution is monotonic: a snapshot that still says `pending` for a row the
 *    cache has already resolved predates the login capture, and its whole row is the older one —
 *    keeping it would flip a usable account back to pending (and out of every picker) until some
 *    tab's reconcile loop noticed.
 */
function reconcileOwnedAccountList<T extends OwnedAccountRow>(
  cache: readonly T[] | undefined,
  snapshot: unknown,
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
    if (!row.pending && edited.pending) return row;
    return edited;
  });
}

/**
 * Stores user settings in settings.json. Keeps a synchronous cache so the PtyManager
 * can read shell/tmux preferences immediately at terminal creation.
 *
 * Two write paths, one FIFO chain, one persist:
 *  - `save(snapshot)` — the renderer's full snapshot. Every key is taken as sent EXCEPT the
 *    shell-owned account lists, which are reconciled against the cache (`reconcileOwnedAccountList`).
 *  - `mutate(fn)` — the shell's own read-modify-write: `fn` runs against the LATEST cache, on the
 *    chain, and its result is persisted as-is. Membership of `codexAccounts` is written only here
 *    (`codex-accounts-service.ts` add/remove), so two concurrent adds compose instead of racing.
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
   * Read-modify-write on the save chain: `fn` sees the LATEST cache (every earlier save or mutate
   * has landed), and its result is persisted verbatim — this is the only path that changes the
   * MEMBERSHIP of a shell-owned account list. A throw from `fn` rejects this call and leaves the
   * cache and the disk untouched; the chain survives for the next caller. Resolves with what was
   * persisted.
   */
  mutate(fn: (current: Settings) => Settings): Promise<Settings> {
    return this.enqueue(() => this.persist(mergeSettings(fn(this.cache))));
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
    const next = mergeSettings(settings);
    // Membership of these lists is the shell's: `mutate` above is the only writer that adds or
    // removes a row. `claudeAccounts` is NOT listed yet — its add/remove still come from the
    // renderer as a full snapshot, and reconciling a list whose rows are only ever added that way
    // would drop every new account. It joins once `claude-accounts-service.ts` writes its rows
    // through `mutate` too.
    next.codexAccounts = reconcileOwnedAccountList<CodexAccount>(
      this.cache.codexAccounts,
      settings?.codexAccounts,
    );
    return this.persist(next);
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
