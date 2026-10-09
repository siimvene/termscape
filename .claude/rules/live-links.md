---
paths:
  - "src/core/watch-link/**"
  - "src/shared/watch-link/**"
  - "src/shared/watch-link-*.ts"
  - "src/main/watch-link-*.ts"
  - "src/renderer/state/watchLinks*.ts"
  - "src/renderer/lib/liveLink*.ts"
  - "src/renderer/lib/live-link.guard.test.ts"
  - "src/renderer/canvas/live-link-wiring.test.ts"
  - "src/renderer/components/LiveLink*.tsx"
  - "src/renderer/components/settings/sections/LiveLinksSection*.tsx"
  - "src/shared/host-control*.ts"
  - "docs/live-links.md"
---
# Live links: a Pro browser link to one terminal (watch, chat, or type)

> Folded from upstream's single `CLAUDE.md` at the v0.4.2 merge (2026-10-09), text verbatim (see the
> root's "How this documentation is organized" section). Loads automatically when a file matching the
> `paths` above is read; when the root routing table points here, read this file before touching the
> subsystem.
<!-- moved-verbatim-from: CLAUDE.md (upstream v0.4.2) -->

## Live links (Pro browser link to one terminal: watch, chat, or type)

A live link shows ONE node in a plain browser — read-only, or typeable on a Control link by a viewer
who also has its password — until it expires (≤ 24 h, or never for Unlimited) or is stopped; creating
one is Pro and the backend is the gate. Reference: **`docs/live-links.md`**. Invariants:
- `watchLink:*` (owner IPC) is host-only: no relay peer, hosted editors included, may create, list (a
  view carries the secret URL), stop, kick, chat, or change a link's control (typing, password, lock).
  The viewer protocol is `watch:*` and must never start with `watchLink:` — relay-host refuses
  host-only channels before any policy, so it could never arrive (`src/shared/host-control.test.ts`,
  `src/core/relay/scoped-guest-policy.test.ts`).
- A watcher never goes through `decideAccess` (it would get the VIEW table): `watcher-policy.ts` refuses
  every request and every cast but `watch:chat` (Commenter and Control links) and, on a Control link
  only, the three controller casts `watch:unlock` / `watch:input` / `watch:release`; it passes out only
  `watch:*`, its own pty frames and `pty:size`, and takes no `interceptReq` (`watcher-policy.test.ts`,
  `chat-cast.guard.test.ts`). The policy knows only the ROLE: "controlling" is the link host's state
  per CONNECTION (a right password; a reconnect unlocks again, a session restart keeps it). Input from
  a viewer that is not controlling is a breach, except within 5 s of losing control (dropped silently);
  every loss of control goes through `loseControl`, and every chunk is re-checked (control period,
  the record read live, the same session) before it goes.
- A controller's input reaches the node's PANE, never a tmux CLIENT: keys as `send-keys -H` lines read
  by `tmux source-file -` from stdin, after a mode cancel, on the exact `=nt-<id>:`; pastes as
  `load-buffer -` + `paste-buffer -d -p -r`, so tmux frames them by the pane's real state. A byte
  written into a client is its keyboard, and the prefix is the security boundary (`C-b s` = every
  session on the socket, `C-b :` = tmux's command prompt). Keys never ride a paste buffer (tmux 3.7
  vis-encodes control bytes there), and no payload ever rides argv, local or SSH. The viewer frames
  every paste itself and sends each emulator answer as its own cast, which the host drops whole
  (`isTerminalReport`); the contract is in `protocol.ts`. Zellij is refused (`watcherInputRoute` →
  `none`, `nodeControlSupport` → `unsupported`). Routing: `pty-manager.control-input.test.ts`; meaning
  on a real tmux: `pane-input.realtmux.test.ts`.
- The Control password is a scrypt hash only (no plaintext kept or logged anywhere; every scrypt run in
  one FIFO gate of 2; `timingSafeEqual`). Host throttles: 1 attempt per 2 s per viewer, 3 wrong end the
  connection, 10 wrong across the link lock it (lock AND count persisted in the record, so a restart
  resets neither; only Allow control again clears the lock; it and a new password reset the count).
  Owner changes go by direction: narrowing (typing off, a new password) applies at once and is NEVER
  undone by a failed or hung write — the brake must not fail open; the owner is told `'unsaved'` (holds
  until a restart unless a later write lands; Stop ends it for good) — widening (typing on, allow again)
  only after the write. A chunk handed to `PtyManager.controlInput` carries `isCurrent`, asked right
  before it spawns, so it never lands after control ended; a batch holds at most 64 chunks.
- Unlimited = `ttlSeconds: 0` → `expiresAt: null`: no expiry timer, never pruned for time. The backend
  grants it only with no TTL cap and asks the license's liveness at host-token at most once per 24 h per
  license (dead → 402 → the host stops minting, the view reads `refused`; keygen unreachable fails
  open).
  A build older than this one drops Control and unlimited records on load and its next write removes
  them (their server rows live on with no host until they expire or Stop all).
- Watchers are QUIET (no broadcast, not in `clientIds()`) and SELF-PACED (never paused, dropped or
  resynced by the registry); the reaper reads `quietClientIds()` too, or it releases a session only a
  viewer holds (`ui-sink-registry.watcher.test.ts`, `pty-reap.test.ts`).
- The stream filter sees every byte, has NO length cap (a cap leaked a measured clipboard), and every
  join resets it `midStream`, never to text mode and never on a keyframe. `captureVisible` never returns
  history (exact `=nt-<id>:`, no `-S`; session host, plain shell and a Zellij node get no keyframe). A
  viewer sizes nothing: `joinOnly` + `sizeVote: false`; its own tmux client is `-E -f ignore-size,read-only`,
  and a Zellij node never gets one (refused, never a Zellij attach — that client could type).
- Node gone is tri-state (only ABSENT ends a link; a lost or corrupt index is never a complete read —
  `knownNodeIdsStrict()`, which only live links call; the agent-status mirror keeps `knownNodeIds()`,
  which ignores that flag, because a whole-process pause of its pruning was R54's mistake).
  Link state is never canvas content, no canvas-control verb touches links, the chip is not hideable
  (`src/renderer/lib/live-link.guard.test.ts`); both shells wire one core service, the Server Edition as
  `unsupported` until it has a license layer (`src/main/watch-link-wiring.test.ts`).
- `src/shared/watch-link/` is vendored byte for byte into nodeterm-web: siblings and `tweetnacl` only,
  no Node API, type imports spelled `import type` (`isomorphism.guard.test.ts`); a change there owes the
  web repo a re-vendor. Chat text is stripped of controls AND bidi controls there, capped by code point.
- Never silent about what a viewer gets. Where local terminals are not tmux (Windows' session host, tmux
  off or missing, Zellij) a viewer can watch only a terminal the app has OPEN (there is no read-only
  client to spawn): the create dialog says so, and a refused join turns the chip amber `LIVE · 1
  waiting` ("Viewers are waiting — open this terminal in nodeterm…"). The stream is the owner's tmux
  CLIENT's output, so its session chooser or a session switch reaches viewers; the warning names it.
  A controller's input that does not reach the pane is reported (`watch:control {controlling,
  dropped}`, cause-neutral: the rate limit or a failed delivery, e.g. an SSH host without tmux).
- The Live chat drawer has ONE `nodeterm:live-chat` listener (Canvas); no OS notification per chat
  message (`control-taken` is the only link notice that raises one); a message counts as read only
  while the window is visible and focused.
- Stop all is the only control that reaches other machines' links: it is offered to a Pro owner even
  with no link listed here, awaits the server and reports what it reached (`RevokeAllOutcome`) — a
  failed or skipped server call must never look like a stop.
