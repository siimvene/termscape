/**
 * Waiting for a SYSTEM-account switch to land.
 *
 * Managed accounts have `claudeAccounts.waitLogin(id)`: core polls the account dir's
 * `.claude.json` for an `oauthAccount` and resolves on capture. The system account (`~/.claude`)
 * has no such channel and, worse, no such condition: a machine that is already logged in
 * satisfies "has an oauthAccount" before the user has typed anything, so a capture-shaped wait
 * would resolve instantly off the OLD identity. What a switch changes is WHICH identity the
 * credential resolves to, so the wait is for the resolved email to DIFFER from the one shown when
 * the button was pressed, read through the same credential lookup the usage pill uses
 * (`usage.refresh(undefined)` — refresh, not fetch, because fetch serves a 5-minute cache and
 * would never see the new login inside the window).
 *
 * `unchanged` is not a failure. Picking the same org again in the CLI's picker is a legitimate
 * outcome, and a stale `~/.claude.json` (measured 2026-09-17: identity file said one org, the
 * Keychain token was another's) also reads as unchanged. Callers clear the waiting line and say
 * nothing; the popover / pill keep telling the truth about what the credential resolves to.
 */
export interface SystemAccountSwitchDeps {
  /** Resolve the system account's current email (null when signed out / unreadable). */
  readEmail: () => Promise<string | null>
  /** The email displayed when the switch was started; `null` when none was known. */
  before: string | null
  intervalMs?: number
  timeoutMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export const SYSTEM_SWITCH_POLL_MS = 10_000
export const SYSTEM_SWITCH_TIMEOUT_MS = 5 * 60 * 1000

export async function waitForSystemAccountChange(
  deps: SystemAccountSwitchDeps
): Promise<'changed' | 'unchanged'> {
  const intervalMs = deps.intervalMs ?? SYSTEM_SWITCH_POLL_MS
  const timeoutMs = deps.timeoutMs ?? SYSTEM_SWITCH_TIMEOUT_MS
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const started = now()
  while (now() - started < timeoutMs) {
    await sleep(intervalMs)
    let email: string | null = null
    try {
      email = await deps.readEmail()
    } catch {
      // a failed refresh (offline, keychain locked) is "no answer yet", not "changed"
      continue
    }
    if (email && email !== deps.before) return 'changed'
  }
  return 'unchanged'
}
