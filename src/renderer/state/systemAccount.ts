import { create } from 'zustand'
import { waitForSystemAccountChange } from '../lib/systemAccountSwitch'

/**
 * Detected identity of the SYSTEM Claude account (the machine's default `~/.claude` login).
 * Managed accounts carry their captured email in settings, but the system account is implicit
 * (no ClaudeAccount record), so its email is resolved lazily from the usage endpoint's cached
 * credential lookup in main. Pickers/settings show it next to "System account" so it stays
 * distinguishable once managed accounts exist. Fail-open: no login / no network → null.
 */
interface SystemAccountState {
  email: string | null
  /** Guard so the lazy fetch runs once per app session (main caches the underlying lookup). */
  loaded: boolean
  ensure(): void
  /** Re-resolve NOW, bypassing main's 5-minute usage cache — after a `claude /login` under
   *  `~/.claude` the cached row still names the previous identity. Returns the fresh email. */
  refresh(): Promise<string | null>
  /** True while a system-account switch is in flight. Lives in the store (not in AccountsSection)
   *  because the switch closes the Settings overlay, which unmounts the section: a component-local
   *  flag would die with it while the poll ran on, and a reopened Settings would offer the button
   *  again and start a SECOND `claude /login` + poll against the same `~/.claude`. */
  switching: boolean
  /** Begin a system-account switch, or refuse a second one. Singleton, process-wide: while a
   *  switch is in flight a second call returns `'busy'` without dispatching the event or starting
   *  a second poll. It dispatches `nodeterm:switch-system-account` itself (Canvas spawns the login
   *  node and closes the overlay), then waits via `waitForSystemAccountChange`, clearing
   *  `switching` in a `finally`. */
  startSwitch(): Promise<'changed' | 'unchanged' | 'busy'>
}

export const useSystemAccount = create<SystemAccountState>((set, get) => ({
  email: null,
  loaded: false,
  ensure() {
    if (get().loaded) return
    set({ loaded: true })
    void window.nodeTerminal.usage
      .fetch()
      .then((u) => set({ email: u?.email ?? null }))
      .catch(() => {})
  },
  async refresh() {
    const u = await window.nodeTerminal.usage.refresh()
    const email = u?.email ?? null
    set({ email, loaded: true })
    return email
  },
  switching: false,
  async startSwitch() {
    if (get().switching) return 'busy'
    const before = get().email
    set({ switching: true })
    // Same channel the usage popover's "⇄ Switch account…" uses: Canvas opens a terminal running
    // `claude /login` under the SYSTEM env (no accountId) and closes the Settings overlay so it is
    // seen. That overlay close unmounts AccountsSection — the reason `switching` lives here.
    window.dispatchEvent(new CustomEvent('nodeterm:switch-system-account'))
    try {
      return await waitForSystemAccountChange({ before, readEmail: () => get().refresh() })
    } finally {
      set({ switching: false })
    }
  }
}))
