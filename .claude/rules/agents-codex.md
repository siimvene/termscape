---
paths:
  - "src/core/codex-thread-identity-sh.ts"
  - "src/core/codex-identity-*.ts"
  - "src/core/codex-shim-identity.integration.test.ts"
  - "src/main/codex-shim-identity.integration.test.ts"
  - "src/main/codex-identity-record-wiring.test.ts"
  - "src/main/codex-relay-daemon.ts"
  - "src/server/codex-shared-identity.ts"
  - "src/main/remote-ssh/remote-shim-neutrality.guard.test.ts"
  - "docs/shared-codex-node-identity.md"
  - "docs/codex-shared-identity.md"
---
# Codex shared-thread node identity (tool-shell recovery, the exported record)

Codex's shared-identity spine, split out of `agents.md` during the v0.3.7 merge so it loads only
when the codex-identity code is touched. General agent rules stay in `agents.md`; the full argument
is `docs/shared-codex-node-identity.md`.

- **Every LOCAL generated sh client recovers shared-Codex identity BEFORE its env gate.** A tool
  shell forked by the account-scoped app-server carries `CODEX_THREAD_ID`, not the pane's
  `NODETERM_*`. Managed hooks, local `nodeterm.sh` and local `context.sh` therefore prepend
  `codexThreadIdentityResolverSh(codexThreadIdentityRoot())` before testing
  `NODETERM_NODE_ID`/`NODETERM_CANVAS_CONTROL` — else both user-facing shims declared that
  first-class Codex session as being *outside* nodeterm.
- **SSH constants stay machine-neutral.** The local record root is invalid on a remote host and must
  never be baked into its copy (`remote-shim-neutrality.guard.test.ts`, two legs: the exported
  neutral bodies carry no record root or prelude, and `remote-hooks.ts` cannot even NAME a
  parameterised builder). The failure is silent and one-sided — a remote shim carrying the prelude
  keeps working; the only symptom is this machine's userData layout sitting in a file on someone
  else's server.
- **The prelude is shared; the RECORD it reads is desktop-only.** The record's writers are the two
  hook-server handlers `src/main/index.ts` registers and — since the daemon-reset work —
  `wireServerCodexSharedIdentity` (`src/server/codex-shared-identity.ts`) at Server Edition boot.
  That shell used to answer a flat `shared: false` (`UNKNOWN_CODEX_IDENTITY_CAPS`) as a deliberate
  degrade; it no longer does, because the Server Edition now has the same local app-server, signed
  node tokens and persistent canvas store, so it wires the spine **after** those secrets exist (the
  late registration is why `registerCodexIdentityIpc()` answers from the live resolver, so an early
  browser caller waits for the refresh instead of being pinned to a false "plain Codex" answer).
  Desktop-only remains the record's REMOTE leg (SSH shims carry no record root or prelude).
- **The prelude EXPORTS what the record says; it never decides.** `NODETERM_AGENT_ID` and
  `NODETERM_CANVAS_CONTROL` were once constants there (`codex`, granted); both are `buildPtyEnv`'s
  answers about the PANE — the node's OWN agent id (`custom:<uuid>` for a custom agent whose
  `baseAgent` is codex, not `codex`) and the grant gated on `canControlCanvas`. The constants
  mislabelled every custom codex-based node and asserted a grant that agreed with the pane only
  because `SHARED_IDENTITY_CAPABLE ⊆ CANVAS_CONTROL_CAPABLE` — a coincidence the next shared-identity
  agent breaks, handing a tool shell a capability its pane was denied. So `agentId` + `canvasControl`
  live INSIDE the 6-tuple HMAC record and the prelude reads them; the grant is exported only when the
  record grants it and left UNSET otherwise (absent, never `0`). The **pane echoes its own label** on
  `/codex-thread/{start,bind}` (a tmux session outlives the app), but the **grant is never echoed** —
  the route re-derives it with `canControlCanvas`, so there is ONE decider and a forged id cannot
  manufacture a grant. The three preimage generations are **selected by the record's shape, never
  tried in turn**, and a pre-agent record's implied `codex` + grant is keyed on the LINE being
  absent, never the value empty. The env vars were never a security boundary (anyone who can run the
  shim can `export` them); the per-node token is (`docs/shared-codex-node-identity.md`).
- **A permission flag on the launch line means plain codex, and the DEFAULT mode emits one.** Codex
  refuses approval/sandbox overrides on `--remote … resume`, so the launcher preflight falls back
  (`permission-policy-requires-local`) whenever the line states `--ask-for-approval`/`-a`,
  `--sandbox`/`-s`, a bypass flag or `--approve-for-me`. `withPermissionMode` emits a codex flag for
  every mode but Plan and Accept edits (Auto = `--ask-for-approval on-request`), so with untouched
  settings a Codex node is NOT shared. Two lists must agree on what counts as a codex permission
  flag: the preflight's `case` and `approval-mode.ts`'s `CODEX_*_FLAGS` (the funnel's suppressors).
  A flag in one and not the other either appends a pair codex refuses or skips the fallback. Full
  write-up: `docs/codex-shared-identity.md` §3.
- **A shell that forwards this identity cannot be type-checked into correctness.** A handler that
  destructures the request without `agent`, and a record write that omits its optional trailing
  argument, are BOTH well-typed — so the whole dimension can be plumbed through core, the route, the
  launcher and the prelude, pass `npm run typecheck` and every unit test, and ship INERT.
  `main/codex-identity-record-wiring.test.ts` pins it at source level (the same remedy
  `hook-verified-parity.test.ts` uses for the same class of hole).
