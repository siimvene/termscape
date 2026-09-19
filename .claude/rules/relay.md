---
paths:
  - "src/main/remote/**"
  - "src/main/pairing-*.ts"
  - "src/renderer/components/PhonePairPopover.tsx"
  - "src/renderer/lib/relayHostShare.ts"
  - "src/renderer/session/**"
  - "src/renderer/remote/**"
  - "docs/fused-host-mode.md"
---
# Remote access (phone relay): free, not Pro

> Moved verbatim from the root `CLAUDE.md` on 2026-09-01 (see its "How this documentation is
> organized" section). Loads automatically when a file matching the `paths` above is read;
> when the root routing table points here, read this file before touching the subsystem.
<!-- moved-verbatim-from: CLAUDE.md -->

## Remote access (phone relay) — free, not Pro

- Phone relay remote access ("Reach this Mac from anywhere") is a **Core (free) feature** as of
  2026-08-01 — the iOS app is itself paid, so a desktop Pro gate double-charged the same feature.
  The former Pro gate AND the free-tier monthly quota (`core/relay-quota.ts`, `RelayQuotaBanner`,
  the ProCompare meter, the `relayQuota` IPC/preload/bridge surface, docs/relay-quota.md) were all
  **removed**. The toggle (`settings.phoneAccessEnabled`, Settings → Phone + quick-pair popover)
  shows for everyone; the standing host reconciles on `enabled && relayAllowed()` alone, with no
  quota metering at `onPeerReady`. **Entitlement passthrough remains**: a stored Pro entitlement is
  sent on mints, else the `{deviceId,…}` body (host-token `{deviceId, hostPublicKeyB64}`, device
  mint `{deviceId, hostDeviceId, hostPublicKeyB64, label}`). **The backend is the real gate now**:
  `POST /v1/relay/host-token` / `/v1/relay/device` must admit deviceId (no-entitlement) mints, and
  the relay server may rate-limit free hosts independently — a client-side gate must NOT be
  reintroduced to work around a backend refusal (fix the backend policy instead).

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
