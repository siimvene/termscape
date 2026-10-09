---
paths:
  - "src/main/remote/**"
  - "src/main/pairing-*.ts"
  - "src/renderer/components/PhonePairPopover.tsx"
  - "src/renderer/lib/relayHostShare.ts"
  - "src/renderer/session/**"
  - "src/renderer/remote/**"
  - "docs/fused-host-mode.md"
  - "src/core/phone-approval*.ts"
---
# Remote access (phone relay): free, not Pro

> Moved verbatim from the root `CLAUDE.md` on 2026-09-01 (see its "How this documentation is
> organized" section). Loads automatically when a file matching the `paths` above is read;
> when the root routing table points here, read this file before touching the subsystem.
<!-- moved-verbatim-from: CLAUDE.md -->

## Remote access (phone relay) — free, not Pro

- **A Team Access invite that shares ONE project is a boundary, not a label**
  (`core/relay/scoped-guest-policy.ts`, wired by `main/remote/relay-host.ts` as the core relay
  host's hooks). The invite is consent to run commands IN that project, and nothing else: inbound is
  an allowlist (`SCOPED`) where a node id must belong only to the shared project (or be one the
  guest just created over `canvas:mut` that no project holds yet — the host saves on a debounce, so
  a new terminal's first `pty:create` precedes its node on disk), paths realpath inside the project
  root and outside userData (symlinks and dangling links refused), `pty:create` loses `sshRemote`
  and defaults its cwd to the root, `workspace:save` is refused; outbound reuses the viewer policy's
  per-project event/terminal-frame attribution. An unknown channel is refused, and the guard test
  forces a decision for every relay-tab channel. `connectRelayHost` THROWS for a scoped session
  given no scope deps rather than serve it unscoped. **What it does not claim**: the guest's own
  terminal is a shell as the host's user and can `cd` anywhere or attach another tmux session; the
  policy closes the app's RPC doors, not the OS. Secret-bearing RPCs are host-only for EVERY relay
  peer (`shared/host-control.ts`, now also enforced in core `relay-host.ts` `serve`, so the Server
  Edition's hosted peers meet it): `settings:*` (a peer that saved `modelGateway.baseUrl` and then
  called `agent:discover-models` would have the keychain-held gateway key sent to its URL),
  gateway credentials, `license:*`, `claude-accounts:*`/`codex-accounts:*`, `usage:*`, and the
  pairing/relay trust plane. An UNSCOPED invite (Team Access seats) stays full access, and its copy
  now says so. Known degrades of the scoped tab: the host-path picker starts at `/` and is refused
  (navigate from the project instead), and an SSH project's terminals do not open over the relay.

- Phone relay remote access ("Reach this Mac from anywhere") is a **Core (free) feature** as of
  2026-08-01 — the iOS app is itself paid, so a desktop Pro gate double-charged the same feature.
  The former Pro gate AND the free-tier monthly quota (`core/relay-quota.ts`, `RelayQuotaBanner`,
  the ProCompare meter, the `relayQuota` IPC/preload/bridge surface, docs/relay-quota.md) were all
  **removed**. The toggle (`settings.phoneAccessEnabled`, Settings → Phone + quick-pair popover)
  shows for everyone; the standing host reconciles on `enabled && relayAllowed()` alone, with no
  quota metering at `onPeerReady`. **Entitlement passthrough remains**: a stored Pro entitlement is
  sent on mints, else the `{deviceId,…}` body (host-token `{deviceId, hostPublicKeyB64}`, plus
  `popChallenge`/`popProof` when the backend supports it; device mint `{deviceId, hostDeviceId,
  hostPublicKeyB64, label}`). **The backend is the real gate now**:
  `POST /v1/relay/host-token` / `/v1/relay/device` must admit deviceId (no-entitlement) mints, and
  the relay server may rate-limit free hosts independently — a client-side gate must NOT be
  reintroduced to work around a backend refusal (fix the backend policy instead).
- **The phone's Chat screen verbs** (`chat.page` / `chat.status` / `chat.send` / `agent.answer`,
  `host-service.ts` `handleChat` → `main/remote/host-chat.ts`, spec + exact error strings in
  `docs/mobile-chat-view.md` §3.2). Four rules a refactor must not undo: (1) **the phone sends only a
  node id**; cwd/account/agent/session are resolved from THIS machine's records
  (`WorkspaceStore.getNodeResolved` + the mirror). The session id is asked of the RENDERER's
  agent-status store first (what ⌘M reads; after a restart a hook-fed id lives only there), the
  mirror / minted id only as a fallback; the cwd rides only for a REMOTE node with a known id, so a
  local known-but-dead id — or no id at all — reads NOTHING rather than claude's cwd-newest fallback
  (a stranger's session). An SSH-project node is read REMOTE-ONLY (`remoteOnly`): over its live
  pty's master, else its PROJECT's (`remoteTargetForNode` — an idle tab or any node after a restart
  has no pty, and resolving through the pty alone sent it to THIS machine's disk), and a remote read
  that cannot happen is `unreadable` ⇒ "Could not read the transcript.", never `found:false`. Only
  chat-capable agents are served (`canChat(capabilityAgentId(agent))`); (2) **the send gate is the host mirror's, then the renderer's** — refused
  first when the mirror says working/waiting/blocked or holds a question/approval ticket (renderer
  state is transient after a reload), then an IPC round-trip (`host:chat-query` /
  `host:chat-reply`, sender-checked to the main window) answered from the agent-status store and the
  ⌘M composer's `chatSendRefusal` at send time plus "no held request". A renderer that does not
  answer FAILS CLOSED: status is an error; `'refused'` (with a `reason`) means nothing was typed
  (no window, a gate, past `startBy`, or `busy` — one send per node in flight until it SETTLES),
  while a send whose outcome the desktop cannot confirm (no answer in time, or a `sendText` that
  rejected after starting — it may or may not have been typed) is `'unconfirmed'`, never `'refused'`,
  which would invite the phone to resend and type the prompt twice. `ChatStatus` carries the mirror's
  view too (`hostRefuses`/`refusal`, `version: 1`): after a restart the window's `state` is null while
  the mirror may still hold a live dialog, and the phone must see the lock the send applies; (3) **text is capped raw (64000) then stripped of ESC + C0/C1** (`\n`/`\t` kept) and
  rides `pty.sendText` (stdin into tmux, never argv); `'sent'` only for `sendText === true`;
  (4) **`agent.answer` is the desktop answer path** — `answerHeldPermission` over the SAME
  `heldPermissionIoFor` (local fs or the SSH ControlMaster) and the in-process structured-ticket
  gate, and the `pendingId` must be THIS node's (a mirror approval ticket for it, or the renderer's
  `held.pendingId`), else `false` with no I/O and no answered event on the wrong node. The `chat`
  dependency is OPTIONAL at every hop, so a dropped hop compiles and ships the verbs
  inert ("not served"); `host-chat-wiring.test.ts` pins the chain at source level. Served only to an
  approved phone; Team-access relay guests never reach them (`relay-host.ts` serves no phone
  dialect). Server Edition: N/A (no phone relay; the bridge subscription is inert).
- **One relay pin store per ROLE, and only the phone store admits anyone** (`main/remote/approved-devices.ts`).
  `phonePins` (`remote-approved-phones.json`) is what the standing host auto-approves from, silently,
  with the full phone vocabulary; `guestPins` (Team Access desktops we host) and `joinedHostPins`
  (hosts we joined) are records that nothing reads to admit. They used to be ONE file, so a host you
  once joined, or a guest whose seat you revoked, was auto-admitted as a phone. The pre-split
  `remote-approved-devices.json` is deleted at boot and NOTHING in it is carried over: nothing on
  this machine can tell its roles apart (the phone's relay box key is never sent at pairing, so
  agent.json cannot vouch for one), so every phone re-approves by SAS once. **Every revoke goes
  through `main/remote/peer-revoke.ts`**: unpin from the named role stores, then run every
  registered host killer (standing host pool incl. pending consent, the interactive `initRemoteHost`
  session, the Team Access `live` set). A revoke that knows only one host leaves the others serving.
  Phone "Remove" (`pairing-service.revokeDevice`) revokes ALL phone pins and cuts ALL phone relay
  sessions, before the SSH key and the device entry go — all-phones because no box key maps to a
  device; a failure reports `local:false` and keeps the device listed to retry.
- **Phone pairing is platform-neutral, and revoke still speaks the iOS-era stamp.** New keys are
  stamped `nodeterm-mobile-<deviceId>` (`pairing-core.deviceCommentFor`); `filterAuthorizedKeys`
  matches BOTH that and the legacy `nodeterm-ios-<deviceId>` (`deviceCommentsFor`), because every
  iPhone paired before Android existed carries the old stamp — drop the legacy leg and "Remove"
  reports a phone removed while its SSH key stays live. The device name is what the phone sends
  (Android sends one), sanitized to one ≤64-code-point line; with none it is `'Phone'`, EXCEPT the
  iOS app — which has never sent a name — is recognised by its fixed key comment `nodeterm-ios` and
  keeps `'iPhone'`. Store links go through `renderer/lib/links.ts` `mobileStoreLinks()`; the Play
  link is hidden by the single `ANDROID_APP_PUBLISHED` flag until the listing exists, and
  `mobileStore.guard.test.ts` refuses a direct store URL anywhere else in the renderer. `LicenseSource` includes
  `'google'` (a Play purchase bridged from the phone, `google:<orderId>`), with its own
  `licenseCopy` sentence. `settings.mobileLiveActivities` keeps its key; the UI says "Live updates
  on phone".

- **A Windows desktop pairs relay-only — no SSH key; don't "fix" that by writing one.** The phone's
  direct-SSH path is POSIX sh + tmux end to end, but Windows OpenSSH hands out `cmd.exe` and
  sessions live in the session host, which nothing on the phone can SSH-attach to. So on win32
  `createPairingService` installs no key, the QR carries `"ssh":false` and is gated on the RELAY
  not sshd (`shared/pairing-gate.ts`), and a failed relay mint pairs NOTHING (502 to the phone,
  `reason:'relay-failed'` to the UI) instead of the SSH platforms' LAN-only degrade. A key sshd
  accepts is worse, not better: the phone tries SSH before the relay, so a working key pins it to a
  path that cannot work while a rejected one falls through. Issue #758's
  `administrators_authorized_keys` rule is detected (`main/windows-ssh-keys.ts`) only to explain the
  missing key; revoke sweeps that file IN PLACE (a temp+rename would swap its Administrators+SYSTEM
  ACL for the directory's and sshd would then refuse every admin key in it). Relay attach on Windows
  needs the session host packaged (#575, shipped by #579), else `pty.attach` spawns a new plain
  shell instead of joining the node's session while `sessionExists` still answers "warm".

## Standing phone consent lifetime (#819)

A browse socket can close before the human clicks the SAS dialog. `core/phone-approval.ts` retains
only the handshake-bound id/key for 120 seconds, at most 64 requests, one per key. Socket closure
releases presence and transport but does not discard that bounded consent; replacement, rejection,
expiry and host stop clear the exact dialog id. Approval requires BOTH id and displayed key (no
key-only match or mismatched-key fallback), consumes once, then persists before granting access.
`remote:phone:approve` is raw, owner-window Electron IPC, never a relay RPC. Its response separates
stale/persistence failure from approved/saved-disconnected; renderer rejection/timeout is explicitly
unconfirmed. SAS derivation and mutual trust verification are unchanged. Legacy interactive offers
remain session-only, and Server Edition rejects standing phone approval as unsupported.

Pin/revoke mutations use `updateApprovedDevices` to queue the entire read/modify/write in process;
unique-temp atomic rename alone cannot prevent lost updates. Non-ENOENT reads and malformed JSON
reject rather than overwrite unknown trust state. The queue is not a cross-process lock. A click
accepted before host stop may finish its disk save, but must never open the now-closed session.
