// Reconciling a managed Claude account RECORD against its config dir — the dir is the truth.
// Pure decision logic + a thin async runner; the impure edges (window.nodeTerminal, the settings
// store) are injected so everything here is unit-tested.
//
// Three defects this closes, all hit by a real user:
//  (1) No self-heal: an account whose dir already holds a completed login (`.claude.json` has
//      oauthAccount) sat "pending / New account" forever unless a human found Retry.
//  (2) Silent capture window: after Add, the app polled 5 min then gave up with no visible change.
//  (3) Retry spawned a junk login node: it opened `claude /login` BEFORE checking whether the dir
//      was already logged in, when capture then lands in <=2 s and the node is pure noise.
import type { ClaudeAccount } from '@shared/types'
import { useSettings } from '../state/settings'

/** How long the Retry race waits for a fast capture before opening a login node (defect 3). */
export const RETRY_GRACE_MS = 5000

type WaitLogin = (id: string) => Promise<{ email: string } | null>
type ApplyAccounts = (fn: (accs: ClaudeAccount[]) => ClaudeAccount[]) => void

/** Adopt a captured email into a record: clear `pending`, set `email`, and take the email as the
 *  label ONLY when the user has not named it (empty, or the placeholder 'New account'). */
export function healedAccount(account: ClaudeAccount, email: string): ClaudeAccount {
  const named = !!account.label && account.label !== 'New account'
  return { ...account, email, pending: false, label: named ? account.label : email }
}

/**
 * For every LOCAL account, ask `waitLogin` (which resolves immediately for a dir already logged
 * in) and reconcile the record on capture: a PENDING record is flipped (healedAccount), and a
 * NON-pending record whose stored email no longer matches the dir's login has its email refreshed
 * (label untouched — the user re-logged the dir under another identity, which is how a stale
 * email haunted the usage popover). Remote accounts (`host` set) are SKIPPED: their capture needs
 * a live ssh connection, which only the Retry button — with its projectId context — has at
 * launch. Fired all at once, independent; a null (timeout / no login) changes nothing, and a
 * REJECTED wait (IPC failure; the Server Edition's always-rejecting stub) is treated as null so
 * one bad account can never kill the whole heal.
 */
export async function healPendingAccounts(
  accounts: readonly ClaudeAccount[],
  waitLogin: WaitLogin,
  applyAccounts: ApplyAccounts
): Promise<void> {
  const local = accounts.filter((a) => !a.host)
  await Promise.all(
    local.map(async (account) => {
      const captured = await waitLogin(account.id).catch(() => null)
      if (!captured) return
      // Guarded on !a.host as well as the id: a hand-edited settings file can hold a local and
      // a remote record sharing one id, and a LOCAL capture must never flip the remote row
      // (consort finding).
      if (account.pending) {
        applyAccounts((accs) =>
          accs.map((a) => (a.id === account.id && !a.host ? healedAccount(a, captured.email) : a))
        )
      } else if (account.email !== captured.email) {
        applyAccounts((accs) =>
          accs.map((a) => (a.id === account.id && !a.host ? { ...a, email: captured.email } : a))
        )
      }
    })
  )
}

type TimerHandle = unknown

/** Injected dependencies for `raceLoginCapture` (clock included, so it is deterministic in tests). */
export interface LoginRaceDeps {
  /** Start the (single) capture poll; both the grace timer and the caller await THIS promise. */
  waitLogin: () => Promise<{ email: string } | null>
  /** Open the `claude /login` terminal — called at most once, only if the grace elapses first. */
  dispatchLoginNode: () => void
  setTimer: (fn: () => void, ms: number) => TimerHandle
  clearTimer: (h: TimerHandle) => void
}

/**
 * Race a login capture against the Retry grace: begin polling immediately and open the login node
 * ONLY if nothing is captured within the grace window (defect 3 — an already-logged-in dir
 * captures in <2 s, so the login node never appears). Awaits the same poll either way and returns
 * its result, so the caller can flip the row or mark it "not captured".
 *
 * For a PENDING account's Retry only. The grace is deliberately not configurable any more: a
 * previous shape took `graceMs`, and the settled-account "Sign in again" path passed `graceMs: 0`
 * expecting "no grace ⇒ the terminal always opens". It does not. The timer callback only fires
 * from the macrotask queue, and a capture that resolves before it (an EXPIRED-but-once-logged-in
 * dir satisfies "`.claude.json` has an oauthAccount" on the first poll, i.e. inside the same tick
 * on an already-settled promise) runs the `finally` that CLEARS the timer — so the terminal never
 * opened and the button did visibly nothing. Zero delay narrowed that window; it did not close
 * it. A caller that needs the terminal regardless of capture uses `openLoginNodeThenCapture`.
 */
export async function raceLoginCapture(deps: LoginRaceDeps): Promise<{ email: string } | null> {
  let captured = false
  const wait = deps.waitLogin()
  const timer = deps.setTimer(() => {
    if (!captured) deps.dispatchLoginNode()
  }, RETRY_GRACE_MS)
  try {
    const result = await wait
    captured = !!result
    return result
  } finally {
    deps.clearTimer(timer)
  }
}

/**
 * Open the login node FIRST — synchronously, unconditionally — then start the capture poll and
 * return its result. No timer, no race: there is no ordering of promise resolution that can skip
 * the dispatch, which is the property `raceLoginCapture` cannot offer (see its note).
 *
 * The two callers where the terminal is the whole point of the click:
 *  - a SETTLED account's "Sign in again": its dir already carries a (stale) identity, so a
 *    capture-first race resolves off the old file and would open nothing. The capture that lands
 *    after the terminal only refreshes the email.
 *  - a FRESH Add: the dir was minted milliseconds ago, so waiting a grace before showing the
 *    terminal reads as "clicked Add, nothing happened" (review finding).
 * The pending-account Retry keeps `raceLoginCapture`: there an already-logged-in dir captures in
 * under 2 s and a login node would be pure noise (defect 3).
 */
export async function openLoginNodeThenCapture(
  deps: Pick<LoginRaceDeps, 'waitLogin' | 'dispatchLoginNode'>
): Promise<{ email: string } | null> {
  deps.dispatchLoginNode()
  return deps.waitLogin()
}

// ── Launch heal runner ─────────────────────────────────────────────────────────────────────────
// Impure glue kicked once from main.tsx. Deps are injectable for tests; defaults reach the real
// bridge + settings store. A module latch guards against a dev-HMR double mount of main.tsx.
let launchHealStarted = false

/** Resolve once the settings store has loaded from disk (so we never heal an empty store). */
function whenSettingsHydrated(): Promise<void> {
  if (useSettings.getState().hydrated) return Promise.resolve()
  return new Promise((resolve) => {
    const unsub = useSettings.subscribe((s) => {
      if (s.hydrated) {
        unsub()
        resolve()
      }
    })
  })
}

/** Fresh-read/transform of the account list (avoids a stale snapshot after the awaited heal). */
function applyAccountsLive(fn: (accs: ClaudeAccount[]) => ClaudeAccount[]): void {
  const s = useSettings.getState()
  s.update({ claudeAccounts: fn(s.settings.claudeAccounts) })
}

/** Kick the launch heal once (idempotent). Waits for settings, then heals local pending accounts. */
export function healPendingAccountsOnLaunch(deps?: {
  waitLogin?: WaitLogin
  applyAccounts?: ApplyAccounts
  getAccounts?: () => readonly ClaudeAccount[]
  whenReady?: () => Promise<void>
}): void {
  if (launchHealStarted) return
  launchHealStarted = true
  const waitLogin = deps?.waitLogin ?? ((id) => window.nodeTerminal.claudeAccounts.waitLogin(id))
  const applyAccounts = deps?.applyAccounts ?? applyAccountsLive
  const getAccounts =
    deps?.getAccounts ?? (() => useSettings.getState().settings.claudeAccounts)
  const whenReady = deps?.whenReady ?? whenSettingsHydrated
  void whenReady().then(() => healPendingAccounts(getAccounts(), waitLogin, applyAccounts))
}
