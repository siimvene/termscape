// TEST-ONLY — issue #629. The worker half of the tmux sandbox; see `tmux-sandbox.ts` for why.
//
// `globalSetup` runs in vitest's main process and the workers inherit its environment, so this file
// is usually re-stating what is already true. It exists because that inheritance is vitest's
// implementation detail, not its contract: a pool that snapshotted the environment before
// `globalSetup` ran would silently hand every worker the DEFAULT tmux directory — i.e. the
// machine's live `node-terminal` server — and nothing in a green suite would say so.
//
// It refuses rather than inventing a directory of its own. A per-worker fallback would be a sandbox
// nobody ever removes, and "the isolation is not wired" is exactly the thing that must be loud.
import fs from 'fs'
import path from 'path'
import { SANDBOX_ENV, enterSandbox } from '../../src/core/tmux-test-socket'

const sandbox = process.env[SANDBOX_ENV]
if (!sandbox || !fs.existsSync(sandbox)) {
  throw new Error(
    `tmux sandbox missing (${SANDBOX_ENV}=${sandbox ?? 'unset'}). vitest.config.ts must keep ` +
      'test/setup/tmux-sandbox.ts in `globalSetup` — without it a test naming `node-terminal` ' +
      "binds this machine's live nodeterm tmux server. See issue #629."
  )
}
enterSandbox(sandbox)

// Managed CODEX account homes get the same treatment as tmux sockets, for the same reason. A
// suite that hands `codexAccountHome` a temp `userDataDir` is NOT isolated: the digest is only the
// leaf, and the ROOT defaulted to the developer's real `~/.nodeterm/cx` — so every account a test
// created was minted into the live managed-account namespace (measured: 1552 stray digest dirs).
// `NODETERM_CX_ROOT` (read by `codexAccountHome`, unset in production) is pointed INSIDE the tmux
// sandbox, which `tmux-sandbox.ts` removes at teardown. It is deliberately short: the app-server
// control socket lives at `<root>/<16 hex>/app-server-control/app-server-control.sock`, 59
// characters past the root, and the sandbox was already sized for a 40-character socket name
// under `tmux-<uid>/`, so it fits the same macOS `SUN_LEN` budget the sockets do.
//
// The two scope variables a session inherits from the shell that launched vitest are dropped as
// well: a suite run from inside a Codex-scoped nodeterm terminal carries `CODEX_HOME` and
// `NODETERM_CODEX_ACCOUNT_ID`, and `systemCodexHome()` honors the former — so an "unscoped means
// ~/.codex" assertion passed in one shell and failed in another (measured: 7 of 399 in a normal
// shell, 0 with an isolated env). Production strips both from every pane it spawns for the same
// reason a stale scope must not leak (ACCOUNT_SCOPE_UPDATE_ENV).
process.env.NODETERM_CX_ROOT = path.join(sandbox, 'cx')
delete process.env.CODEX_HOME
delete process.env.NODETERM_CODEX_ACCOUNT_ID
