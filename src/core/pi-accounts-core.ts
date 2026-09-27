// Pure pieces of the managed-pi-account model: the env name that carries an account, the tmux
// `-e` pair for it, and the login-capture parser over the account's `auth.json`. No fs, no
// platform seam, so the spawn path, the service and the tests all share one definition.
//
// Facts this rests on (MEASURED on pi 0.84.1, /opt/homebrew/bin/pi):
//  - `PI_CODING_AGENT_DIR=<dir>` relocates pi's WHOLE agent dir (credentials, settings, sessions,
//    extensions). A fresh dir answers `pi auth check --provider openai-codex --json` with
//    `{"status":"not_ready","reason":"credentials_not_configured"}`; a logged-in one with
//    `{"status":"ready",...}`. That is the entire isolation mechanism: one dir per account.
//  - Credentials live in `<agentDir>/auth.json` (0600), a JSON object keyed by provider id, each
//    value `{type:"oauth"|"api_key", ...}`. A fresh interactive run creates it as `{}` — so the file
//    merely EXISTING says nothing; "logged in" is ">= 1 provider key".
//  - An OAuth entry carries no email (`openai-codex` = `{type, access, refresh, expires,
//    accountId}`), which is why a captured account is labelled by its provider list.

/** The env var a managed pi account rides on. Listed in `ACCOUNT_SCOPE_UPDATE_ENV` (pty-manager)
 *  so a tmux server started by one pi account's client cannot leak its dir into other sessions. */
export const PI_ACCOUNT_ENV = 'PI_CODING_AGENT_DIR'

/** The file pi keeps its per-provider credentials in, inside the agent dir. */
export const PI_AUTH_FILE = 'auth.json'

/** The tmux `-e` pair that pins a LOCAL session to a pi account dir. The shared tmux server is
 *  long-lived, so session env must come from the creation args, never from client inheritance. */
export function piAccountTmuxEnvArgs(agentDir: string): string[] {
  return ['-e', `${PI_ACCOUNT_ENV}=${agentDir}`]
}

/**
 * The provider ids a pi `auth.json` holds credentials for, or null while nothing is logged in
 * (unparsable, not an object, or no provider entry yet). An entry counts only when its value is an
 * object — pi's own shape — so a stray scalar key in a hand-edited file does not read as a login.
 * Only the KEYS are returned: token material never leaves this function.
 */
export function parsePiLoginCapture(rawAuthJson: string): { providers: string[] } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawAuthJson)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const providers = Object.entries(parsed as Record<string, unknown>)
    .filter(([key, value]) => key.length > 0 && !!value && typeof value === 'object' && !Array.isArray(value))
    .map(([key]) => key)
  return providers.length ? { providers } : null
}

/** The default label for a captured account: its provider list, e.g. `openai-codex` or
 *  `anthropic, openai-codex`. */
export function piAccountLabelFor(providers: readonly string[]): string {
  return providers.join(', ')
}
