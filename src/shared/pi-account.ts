// The shared managed-Pi-account record. Import-safe from `src/core` (path builders, the service)
// and `src/renderer` (settings UI): it pulls in NOTHING from `src/core`, so the renderer can type
// and label a pi row without dragging the impure path machinery into its bundle.
//
// A managed pi account is exactly one isolated PI_CODING_AGENT_DIR — `<userData>/pi-accounts/<id>`
// (`core/pi-config-dir.ts`). pi relocates its WHOLE agent dir from that variable (MEASURED on pi
// 0.84.1: a fresh dir reports `credentials_not_configured` while the home dir reports `ready`), so
// every subscription the user logs into pi with lives in its own `auth.json`. pi owns login and
// token refresh inside that dir; nodeterm never writes a credential.

/** The label a freshly minted pi account carries until its login is captured. The capture
 *  (`pi-accounts:wait-login`) replaces exactly this string with the logged-in provider list, and
 *  the settings store's snapshot reconcile treats it as "not an edit" for the same reason — one
 *  definition, shared across the seam. */
export const NEW_PI_ACCOUNT_LABEL = 'New Pi account'

export interface PiAccount {
  id: string
  /** Display label. Defaults to the captured provider list (`openai-codex`, or
   *  `anthropic, openai-codex` for a dir logged into two), because pi's `auth.json` carries no
   *  email for an OAuth login (MEASURED on 0.84.1: an `openai-codex` entry is
   *  `{type, access, refresh, expires, accountId}`). */
  label: string
  /** Reserved for a provider that does report one; never derived from token contents. */
  email?: string
  /** True until `/login` inside pi completes in the account dir (auth.json gains a provider). */
  pending?: boolean
  /** Optional default node color for nodes opened under this account (Settings → Accounts);
   *  unset = pi's own brand color. Read through `accountNodeColor`, which re-validates it as a
   *  string — settings.json is hand-editable and nothing checks it field-by-field on load. */
  color?: string
  createdAt: number
  /** Transient renderer HINT (not persisted by the store's reconcile): true once the USER has
   *  renamed this row by hand, so a stale-pending snapshot whose label happens to equal the mint
   *  placeholder is still taken as an edit rather than discarded. See `reconcileOwnedAccountList`. */
  labelEdited?: boolean
}

/** What `piAccounts.add` resolves with once the row is on disk. */
export interface PiAccountAddResult {
  id: string
  /** The account's PI_CODING_AGENT_DIR (absolute, on this machine). */
  agentDir: string
  account: PiAccount
}

/** What `piAccounts.waitLogin` resolves with once `auth.json` holds at least one provider. */
export interface PiLoginCapture {
  /** Provider ids present in the account's `auth.json`, in file order (e.g. `['openai-codex']`). */
  providers: string[]
}
