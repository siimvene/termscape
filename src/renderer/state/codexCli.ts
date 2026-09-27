/**
 * The renderer's half of the Codex approval-vocabulary gate.
 *
 * Same shape as `codexIdentity.ts` and as claude's `--permission-mode auto` gate: a memoized probe
 * whose unknown answer is the conservative one, read at the moment a launch command is built and
 * never rendered from — so it is a module memo, not a store.
 *
 * WHAT THE CONSERVATIVE ANSWER IS HERE, because it is not "emit nothing". An unprobed launch falls
 * back to the BASELINE vocabulary (`on-request`, `never` — every codex from 0.146.0 to 0.154.0
 * takes both), so Auto and Bypass keep the exact command line they have always had. The one value
 * that moved is `untrusted`, removed in 0.149.0, and that one is emitted only when a probe has
 * actually SEEN this binary advertise it. Unknown therefore costs at most "Ask each time"
 * degrading to Codex's own default — never a launch that dies on a value clap does not know.
 */
import {
  UNKNOWN_CODEX_CLI_CAPS,
  type CodexCliCaps
} from '@shared/types'
import type { ApprovalCaps } from '@shared/agents/approval-mode'

const CAPS_WAIT_MS = 3000

let caps: CodexCliCaps = UNKNOWN_CODEX_CLI_CAPS
let capsPromise: Promise<CodexCliCaps> | null = null

/** Probe once per app run. Never rejects; a slow bridge resolves to what we have so far. The
 *  timeout is what makes "a launch is never blocked on the probe" true by construction — in the
 *  Server Edition this call goes over WS-RPC, which does not reject pending requests when the
 *  socket drops. */
export function ensureCodexCliCaps(): Promise<CodexCliCaps> {
  if (!capsPromise) {
    const probe = Promise.resolve()
      .then(() => window.nodeTerminal.codex.cliCaps())
      .then((c) => (caps = c ?? UNKNOWN_CODEX_CLI_CAPS))
      .catch(() => UNKNOWN_CODEX_CLI_CAPS)
    const timeout = new Promise<CodexCliCaps>((resolve) =>
      setTimeout(() => resolve(caps), CAPS_WAIT_MS)
    )
    capsPromise = Promise.race([probe, timeout])
  }
  return capsPromise
}

export function codexCliCapsNow(): CodexCliCaps {
  return caps
}

/**
 * The approval caps to build a launch line with. `remote` is anything truthy that marks the session
 * as running on another machine (`project.ssh`, `data.ssh`, `data.sshRemoteTmux` — the caller
 * passes whichever it holds; only its truthiness is read), exactly like `codexSharedIdentity`.
 *
 * A REMOTE session runs the HOST's codex, which this probe never looked at and whose version is
 * unrelated to ours — a host on 0.154 would be handed `untrusted` because the laptop still has
 * 0.148, and the node would die on the host with the laptop reporting the mode as supported.
 * CLAUDE.md already states the general form of this ("the version that matters is the one on the
 * HOST"); claude answers it with a remote probe at connect, codex has none yet, so remote resolves
 * to the baseline and the mode degrades honestly instead of guessing across machines.
 */
export function codexApprovalCaps(remote?: unknown): ApprovalCaps {
  return { codexApprovalValues: remote ? null : caps.approvalValues }
}

/** Test seam: drop the memo (and optionally preload a known answer). */
export function resetCodexCliCapsForTests(next?: CodexCliCaps): void {
  caps = next ?? UNKNOWN_CODEX_CLI_CAPS
  capsPromise = null
}
