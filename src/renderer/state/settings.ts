import { create } from 'zustand'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'

interface SettingsState {
  settings: Settings
  /** True once settings have been loaded from disk (so first-run logic can wait). */
  hydrated: boolean
  hydrate(): Promise<void>
  update(patch: Partial<Settings>): void
  /**
   * Persist any coalesced edit NOW and resolve once the shell has ACKNOWLEDGED the save — i.e.
   * once the server-side settings cache holds it (settings-store's `saveNow` updates the cache
   * before it touches the disk, and the RPC resolves after both). Ordinary edits keep the debounce
   * below; this is the one barrier for a caller that is about to trigger server-side work which
   * READS settings, and must not do so until the server can see what the renderer just wrote.
   *
   * Origin: "Add Codex account" pushed the minted id into this store and opened its `codex login`
   * terminal in the same tick. PtyManager injects the managed `CODEX_HOME` only when it finds the
   * id in ITS settings, which arrive up to 300 ms later — so if the pty won the race the login ran
   * against the SYSTEM Codex account and overwrote the user's default credential, while the poll
   * watched a managed home nothing was writing to. On desktop the window was tight; over the
   * Server Edition's WebSocket it was wide open. A sleep was rejected: it narrows a race, it does
   * not close it (the same lesson as the settled-account login grace in accountHeal.ts).
   *
   * Resolves immediately when nothing is pending and nothing is in flight. Rejects if the save
   * itself rejects — the caller must then treat the write as NOT registered.
   */
  flush(): Promise<void>
}

// Coalesce disk writes: the settings inputs fire update() per keystroke/step-click, and each
// save is a full temp-file write + rename in main. The in-memory store stays synchronous (UI
// and xterm/Monaco react immediately); only the persistence trails, at most one write per
// window, always with the latest snapshot.
const SAVE_COALESCE_MS = 300
let saveTimer: ReturnType<typeof setTimeout> | null = null
let pendingSave: Settings | null = null
// The most recent save still awaiting the shell's acknowledgement. Tracked so `flush()` can wait
// on a save whose timer has ALREADY fired: the shell serialises saves FIFO (settings-store
// `saveChain`), so the latest in-flight save resolving implies every earlier one landed too.
let saveInFlight: Promise<void> | null = null

/** Send the pending snapshot (if any) to the shell now; returns the save to await. */
function saveNow(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const snapshot = pendingSave
  pendingSave = null
  if (!snapshot) return saveInFlight ?? Promise.resolve()
  // `Promise.resolve(...)` rather than `.finally` on the raw return: this runs from a TIMER, so a
  // bridge whose `save` returns undefined (a test double, an older preload) throws an uncaught
  // exception nobody is positioned to catch — it does not reject the flush, it escapes the tick.
  // Observed as vitest's "1 unhandled error" out of ShortcutsSection's stub, with its own warning
  // that it can turn into a false positive elsewhere.
  const save = Promise.resolve(window.nodeTerminal.settings.save(snapshot)).finally(() => {
    if (saveInFlight === save) saveInFlight = null
  })
  saveInFlight = save
  return save
}

function scheduleSave(next: Settings): void {
  // Same guard as the beforeunload flush below: this module is transitively imported by
  // node-environment unit tests, where `window` doesn't exist and the timer would throw.
  if (typeof window === 'undefined') return
  pendingSave = next
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    // The timer-driven save is fire-and-forget; a failure here has no caller to report to.
    void saveNow().catch(() => {})
  }, SAVE_COALESCE_MS)
}
// Reload/quit inside the coalesce window must not lose the last edit. (Guarded: this module
// is transitively imported by node-environment unit tests, where `window` doesn't exist.)
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    void saveNow().catch(() => {})
  })
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  hydrated: false,

  async hydrate() {
    const s = await window.nodeTerminal.settings.load()
    set({ settings: { ...DEFAULT_SETTINGS, ...s }, hydrated: true })
  },

  update(patch) {
    const next = { ...get().settings, ...patch }
    set({ settings: next })
    scheduleSave(next)
  },

  flush() {
    if (typeof window === 'undefined') return Promise.resolve()
    return saveNow()
  }
}))
