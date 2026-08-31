# nodeterm mobile (self-host) — iOS client specification

**Status:** v0 build spec · **Date:** 2026-08-25 (rev. 2026-08-30: phone-side session spawning,
§7.11) · **Target server:** nodeterm Server Edition (`src/server`), branch `feat/ungated-selfhost`
(commit 58e5ea13, "Ungate Pro features for self-hosting"), **plus the two node-registration channels
added to `WorkspaceStore.registerIpc` after that commit** — see §12 item 10 for the degrade against a
server that predates them.

This document is the **standalone, normative** specification for a native iOS client that talks
to a self-hosted nodeterm Server Edition. A Swift developer MUST be able to build v0 from this
document alone, without access to the nodeterm repository. Citations in the form
`[src: path:line]` point into the nodeterm repo and are **normative references** — where this
document and the cited source ever disagree, the source wins.

Requirement keywords **MUST / MUST NOT / SHOULD / SHOULD NOT / MAY** are used per RFC 2119.

---

## 1. Purpose & scope

The app is a native iOS companion to a **self-hosted** nodeterm Server Edition: it lists the
user's servers, projects, and live tmux-backed terminal sessions; attaches to sessions as a
**co-attach viewer** (never an owner); shows live agent status (RUNNING / NEEDS YOU / idle);
answers held permission prompts; and offers voice-to-text input.

It deliberately mirrors the shape of the official nodeterm iOS app (v1.0.5) **minus everything
relay- or subscription-shaped**. The self-host build is **fully unlocked**. This is a hard
requirement:

> The app MUST NOT contain: a subscription banner, a connection quota, any "Unlock" UI, the
> "Pair Desktop" relay flow, or "Restore Purchase". There is no entitlement system in this app.

### 1.1 Scope table

| Feature | v0 | v1 | Out of scope |
|---|---|---|---|
| Add server (URL + password), multiple servers | ✅ | | |
| QR pairing for server add | | ✅ | |
| Login / session cookie / re-auth | ✅ | | |
| Home: stat tiles, sessions list, servers list | ✅ | | |
| Terminal view (SwiftTerm, co-attach viewer) | ✅ | | |
| Keyboard accessory toolbar (Esc/Tab/Ctrl/arrows/paste/mic) | ✅ | | |
| Agent status badges + unread dots (`agent:status`) | ✅ | | |
| Answer permission prompts (allow/deny) | ✅ | | |
| Ack finished sessions (`agent:ack-done`) | ✅ | | |
| Context meter per session (`context:update`) | ✅ | | |
| Usage dashboard (subscription + rate-limit, per account) | ✅ | | |
| Transcript read (chat view of a Claude session) | ✅ | | |
| Dictation: Apple on-device (default) | ✅ | | |
| Dictation: server-side whisper (`speech:transcribe`) | ✅ (optional alternative) | | |
| Local notifications while foregrounded / bg-refresh window | ✅ | | |
| Scrollback replay on cold start (`pty:read-scrollback`) | ✅ | | |
| File download via ticket (`files:download-ticket` + HTTP GET) | | ✅ | |
| Kanban board mirror | | ✅ | |
| Presence (cursors, team view) | | ✅ | |
| Spawn a new session as a node (`pty:create` + `workspace:register-node`) | ✅ | | |
| Whisper model management UI (download/delete) | | ✅ | |
| Live Activities / real APNs push | | | ❌ v2 — needs a server-side push component (§9.6) |
| Relay / api.nodeterm.dev / pairing / entitlements | | | ❌ never (self-host) |
| Canvas control (`agent:control`, `/control/*`) | | | ❌ server refuses by name [src: src/server/control-unsupported.ts:19,54-60] |
| SSH-project management from the phone | | | ❌ server has no SSH manager [src: src/renderer/bridge/stubs.ts:133-158] |
| Editing workspace/settings from the phone | | | ❌ `workspace:save` / `settings:save` stay forbidden — node registration (§7.11) is a scoped append, not a workspace write |
| AI naming (`pty:generate-name`) | | | ❌ no server handler → `E_NO_HANDLER` [src: src/server/index.ts:262-264] |

### 1.2 What the phone is, in one paragraph

One tmux session (`nt-<nodeId>`) is painted by exactly one tmux client and one OS pty inside the
server process. Every connected client that views it is a **subscriber in a ledger**, not a new
tmux client [src: src/core/pty-manager.ts:552-556]. The pty runs at the **smallest viewing
subscriber's grid** [src: src/core/pty-manager.ts:559-563]. The phone's whole job is: join the
ledger with its own `viewerId`, report a size (or **park** with `null,null` when backgrounded),
render what the server says the grid is, and detach **only itself** on close. The phone is a
co-attach viewer, never an owner (§7) — with one bounded exception: a session it SPAWNS itself,
which has no other viewers to disturb and which it may also register as a node and end (§7.11).

---

## 2. Server & networking assumptions

### 2.1 The server speaks plain HTTP; TLS is the proxy's job

The Server Edition binds `http.createServer` — **no in-process TLS**
[src: src/server/index.ts:685]. Default bind is `127.0.0.1:8443`; binding a non-loopback host
without `--insecure-http` throws at boot [src: src/server/config.ts:89-90,102-109]. The intended
deployment is: server on loopback, TLS-terminating reverse proxy in front (`tailscale serve`,
Caddy, nginx, Cloudflare Tunnel) [src: src/server/config.ts:73-78].

Consequences for the client:

- The user-entered base URL is normally **`https://<magicdns-or-domain>[:port]`**. The client
  MUST default to and prefer `https`. Plain `http://` MAY be accepted only for
  `localhost`/`127.0.0.1` development targets, gated behind an explicit "insecure" toggle in the
  add-server form; iOS ATS will otherwise block it.
- The WebSocket URL is derived: `wss://` for `https` bases, `ws://` for `http` bases, path
  **`/ws`** [src: src/renderer/bridge/ws-bridge.ts:851-854; src/server/ws.ts:151-152].
- The client MUST rely on the OS trust store for certificate validation. It MUST NOT ship a
  "skip certificate validation" switch in v0. Tailscale serve and Let's Encrypt both produce
  publicly-trusted certs; self-signed support is deliberately deferred (§12).

**Headless mode** (`NODETERM_HEADLESS=1`) binds no listener at all
[src: src/server/config.ts:17-24; src/server/index.ts:659-660]. A headless instance is
unreachable over HTTP/WS; the client cannot and MUST NOT try to support it.

### 2.2 Cookie contract (summary; full auth in §3)

| Property | Value | Source |
|---|---|---|
| Cookie name | `nt_session` | [src: src/server/http.ts:15] |
| Value | 64 hex chars (`randomBytes(32).hex`) | [src: src/server/auth.ts:136] |
| Attributes | `HttpOnly; SameSite=Strict; Path=/` (+ `Secure` only when request carried `X-Forwarded-Proto: https`) | [src: src/server/http.ts:76-84] |
| Server-side TTL | 30 days, **absolute** from creation, not sliding | [src: src/server/auth.ts:11,142-155] |
| Cookie `Max-Age` | none — a browser session cookie; the native client persists the value itself | [src: src/server/http.ts:76-84] |
| Revocation | `/auth/logout` clears only the client's cookie; token stays valid server-side until TTL. No logout-everywhere route (`revokeAll` exists, unrouted) | [src: src/server/auth.ts:157-160; src/server/http.ts:479-483] |

Note (doc vs code): docs/SERVER.md claims `Secure` is also set for direct TLS requests; the code
checks only `x-forwarded-proto === 'https'`. Code wins [src: src/server/http.ts:76-84]. This is
irrelevant to a native client managing its own cookie jar, but the client MUST NOT depend on the
`Secure` attribute being present.

### 2.3 Reverse-proxy header trust (SSO) — informational

The server can be configured to trust a proxy-injected identity header from trusted nets
(default loopback only); header **content is not validated** — the network boundary is the trust
[src: src/server/proxy-trust.ts:1-10,24-25,147-155]. A self-hosted phone client normally uses the
cookie path; the app does not need to implement anything for proxy trust, and it never blocks —
non-qualifying requests fall through to the cookie path [src: src/server/http.ts:44-53].

### 2.4 HTTP limits

- POST bodies to `/auth/*` are capped at **10 KB** [src: src/server/http.ts:17,111-135].
- Login is rate-limited (§3.3); nothing else on the HTTP surface is.
- Any authenticated GET not matching a route serves the built browser renderer (static files);
  the phone never needs these [src: src/server/http.ts:290-371,498].

---

## 3. Auth flows

### 3.1 First-run setup (rarely done from the phone)

On first boot the server prints `Setup: http://<host>:<port>/setup?token=<32-hex>` to stdout
[src: src/server/index.ts:174-178]. The token is 32 hex chars, in-memory only, single-use,
checked constant-time [src: src/server/auth.ts:92-113].

`POST /auth/setup`, body `application/x-www-form-urlencoded`, fields `token` and `password`
[src: src/server/http.ts:427-452]:

| Outcome | Response |
|---|---|
| Already configured | 403 JSON `{"error":"already_configured"}` |
| Body >10 KB / unreadable | 400 JSON `{"error":"bad_request"}` |
| `password.length < 8` OR bad token | 403 JSON `{"error":"invalid_setup"}` |
| Success | session created, `Set-Cookie: nt_session=…`, **303 → /** |

The client MAY offer setup in the add-server flow when it detects an unconfigured server
(`GET /login` responds **302 → /setup** when not configured [src: src/server/http.ts:418-425]),
prompting for the token from the server console. This is optional for v0; the ordinary path is
that the operator sets up once from a browser.

### 3.2 Login

`POST /auth/login`, body `application/x-www-form-urlencoded`, single field `password`
[src: src/server/http.ts:454-477].

| Outcome | Response | Client behavior |
|---|---|---|
| Rate-limited | **429** JSON `{"error":"too_many_attempts"}` | Show "too many attempts, wait a minute" (lockout is 60 s, §3.3) |
| Body too large / unreadable | **400** JSON `{"error":"bad_request"}` | Treat as client bug |
| Correct password | **303 → /** with `Set-Cookie: nt_session=<64-hex>; HttpOnly; SameSite=Strict; Path=/` | Capture the cookie; store in Keychain |
| Wrong password | **303 → /login?error=1**, NO Set-Cookie | Show "wrong password" |

**Normative:** a wrong password is a **303 redirect, not a 401** [src: src/server/http.ts:474-475].
The client MUST NOT follow the redirect to decide success; it MUST:

1. Send the POST with redirect-following **disabled** (URLSession delegate returns `nil` from
   `willPerformHTTPRedirection`).
2. Treat the login as successful **iff** the 303 response carries a `Set-Cookie` for
   `nt_session`; parse and persist that value.
3. Treat a 303 whose `Location` is `/login?error=1` (equivalently: no `nt_session` Set-Cookie) as
   wrong-password.

`HttpOnly` is a browser-JS restriction only; a native client reads the raw `Set-Cookie` header
freely (RFC 6265 — `HttpOnly` binds browser JS only). `SameSite=Strict` is irrelevant to a native cookie jar.

### 3.3 Rate limiting / lockout

After **5** consecutive failures the server locks login for **60 000 ms**; the counter is a
single **global** in-memory counter (not per-IP) and resets when the lock arms
[src: src/server/auth.ts:12-13,37-38,168-174]. Password verification is scrypt +
`timingSafeEqual` [src: src/server/auth.ts:76-88]. The client SHOULD surface the 429 with a
countdown hint and MUST NOT auto-retry inside the lockout window.

### 3.4 Logout

`POST /auth/logout` → clears the cookie (`Set-Cookie: nt_session=; Max-Age=0`), **303 → /login**;
requires nothing [src: src/server/http.ts:86-88,479-483]. The token remains valid server-side
until its 30-day TTL — there is no revocation endpoint. Client behavior on user "log out of
server X": call the route (best-effort), then **delete the cookie and (if stored) the password
from the Keychain**. The client MUST NOT present logout as "invalidates the session everywhere".

### 3.5 Session expiry & re-auth UX

- Expiry is **absolute**: 30 days after login, whatever the activity
  [src: src/server/auth.ts:142-155].
- Detection: (a) the WS upgrade fails with a raw `HTTP/1.1 401 Unauthorized` and the socket is
  destroyed [src: src/server/ws.ts:154-161]; (b) an authenticated HTTP GET without `text/html` in
  `Accept` returns **401 JSON `{"error":"unauthorized"}`** [src: src/server/http.ts:487-492].
  The client SHOULD send `Accept: application/json` on its HTTP probes so it gets the clean 401,
  never an HTML redirect.
- Re-auth flow:
  1. If the user opted into **auto-relogin** (password stored in Keychain, §10), silently re-run
     §3.2; on success, resume the reconnect loop. On a wrong-password result (password changed
     server-side), drop to the login sheet and delete the stored password.
  2. Otherwise present a login sheet for that server; other servers stay untouched.
- The reference browser client treats **3 consecutive failed WS reconnects** as auth-expired
  [src: src/renderer/bridge/ws-bridge.ts:914-926]. The phone MUST distinguish where it can: an
  upgrade that fails with 401 is auth-expiry (re-auth immediately); a TCP/timeout failure is
  connectivity (keep backing off, badge the server offline). Only when the failure mode is
  indistinguishable SHOULD it fall back to the 3-strikes heuristic.

### 3.6 Add-server flow (v0)

Form fields: **Name** (display), **Base URL** (https), **Password**, toggle **Remember password
(auto-relogin)** (default OFF). On save: perform §3.2 login; on success persist
`{name, baseURL}` in app storage and `{cookie[, password]}` in Keychain, then connect the WS.
QR pairing is v1.

---

## 4. Transport — WS-RPC (normative, byte-level)

The protocol module is isomorphic (`src/shared/rpc.ts`); the Swift client reimplements exactly
what it does. One WebSocket per server carries everything.

### 4.1 Endpoint & upgrade

- URL: `<ws|wss>://<host[:port]>/ws` — `wss` iff the base is `https`
  [src: src/renderer/bridge/ws-bridge.ts:851-854]. Only `pathname === '/ws'` is upgraded
  [src: src/server/ws.ts:151-152].
- Request headers: `Cookie: nt_session=<token>`. The client **MUST NOT send an `Origin`
  header**. The server's Origin check only runs when Origin is present (then `origin.host` must
  equal the `Host` header; malformed Origin → reject); absent Origin passes
  [src: src/server/ws.ts:80-100, header comment ws.ts:4-7].
- Gate: valid `nt_session` cookie OR proxy trust [src: src/server/ws.ts:85-88]. Failure → raw
  `HTTP/1.1 401 Unauthorized\r\n\r\n`, socket destroyed — no WS, no RPC error frame
  [src: src/server/ws.ts:154-161].

### 4.2 Frame kinds

- **Text frames** = JSON RPC messages.
- **Binary frames** = pty output ONLY, **server→client only**. A binary client→server frame is
  **ignored** [src: src/server/ws.ts:187] — the client MUST send pty input as JSON casts, never
  binary.
- Set the socket to deliver binary as raw bytes (`binaryType='arraybuffer'` equivalent)
  [src: src/renderer/bridge/frame-transport.ts:37].

### 4.3 JSON message shapes [src: src/shared/rpc.ts:6-11]

```
req  : { "t":"req",  "id":<number>, "method":<string>, "args":[…], "undef":[<int>…]? }
cast : { "t":"cast",               "method":<string>, "args":[…], "undef":[<int>…]? }
res+ : { "t":"res",  "id":<number>, "ok":true,  "result":<any> }
res- : { "t":"res",  "id":<number>, "ok":false, "error":{ "code":<string>, "message":<string> } }
ev   : { "t":"ev",   "channel":<string>, "args":[…], "undef":[<int>…]? }
```

Direction on the Server Edition: client sends `req`/`cast` only; server sends `res`/`ev` only.
`res`/`ev` sent by a client are ignored [src: src/server/ws.ts:196-201]. The server never sends
`req`/`cast` to the client.

**Parse rules the client MUST mirror** [src: src/shared/rpc.ts:79-115]: non-JSON / non-object →
drop the frame (do NOT close the socket); `res` valid iff `id` is a number and either `ok===true`
or `ok===false` with a non-null object `error`; `ev` valid iff `channel` is a string and `args`
is an array; anything else → drop. One bad frame MUST never crash the connection.

`id` is a client-chosen monotonically increasing **number**, starting at 1
[src: src/renderer/bridge/ws-bridge.ts:75,165]. A `res` whose `id` matches no in-flight request
is dropped [src: ws-bridge.ts:143-147].

### 4.4 The `undef` encoding — MANDATORY

JSON has no `undefined`; `JSON.stringify([a, undefined])` yields `[a, null]`, and server-side JS
default parameters do **not** fire on `null`. Meanwhile several methods **mean** `null`
(`pty:resize(sid, null, null)` is the park signal). The sender therefore attaches `undef`: an
array of the **top-level argument indexes** that were logically omitted/undefined
[src: src/shared/rpc.ts:20-50].

Encoder the client MUST implement on every `req` and `cast` [src: src/shared/rpc.ts:56-65]:

```
encodeArgs(args):
  undef = []
  out = for each (i, arg): if arg is OMITTED → append i to undef, emit null
                           else emit arg (a meaningful null stays null, unlisted)
  emit "undef" field only when undef is non-empty
```

Swift mapping: model each optional trailing slot as a three-state (present value / meaningful
null / omitted). **Omitted** → JSON `null` + index in `undef`. **Meaningful null** (park signal,
clears) → JSON `null`, NOT listed. Only top-level slots are ever marked; `null` nested inside an
object/array is plain data [src: src/shared/rpc.ts:48-49].

Decoder (for inbound `ev`): for each integer `i` in `undef` with `0 <= i < args.count`, treat
`args[i]` as absent. Junk/out-of-range indexes mark nothing and can never lengthen the array
[src: src/shared/rpc.ts:68-77]. Implement it for correctness even though most event args are
plain values.

### 4.5 Binary pty frame layout [src: src/shared/rpc.ts:117-141]

```
byte 0          : 0x01                      (PTY_DATA_FRAME — the only binary kind)
bytes 1..2      : sessionId UTF-8 byte length, big-endian uint16
bytes 3..3+L-1  : sessionId, UTF-8
bytes 3+L..end  : data payload, UTF-8
```

Decode rules: reject (drop, return nothing) if `length < 3`, or `buf[0] != 0x01`, or
`3 + sidLen > length` [src: src/shared/rpc.ts:133-141]. A decoded frame is semantically an event
on channel `pty:data:<sessionId>` with `args = [dataString]`
[src: src/renderer/bridge/ws-bridge.ts:133-137].

### 4.6 Error codes

| Code | On the wire from the self-host server? | Meaning for the client |
|---|---|---|
| `E_NO_HANDLER` | **Yes** — `res.ok=false` when the method has no handler | method not served on this edition [src: src/server/platform-server.ts:110-115] |
| `E_HANDLER` | **Yes** — handler threw; `message` = error string | server-side failure of a served method [src: src/server/platform-server.ts:117-124] |
| `E_DISCONNECTED` | Never — **client-synthesized only** | the client MUST reject every in-flight request with this when the socket closes [src: src/shared/rpc.ts:16-18; ws-bridge.ts:106-114] |
| `E_UNSUPPORTED` | No (browser-local stub reject only) | do not expect it [src: src/renderer/bridge/stubs.ts:25,31] |
| `E_UNAUTHORIZED` | No (relay path only, not self-host) | auth failure on self-host is the 401 at upgrade, §4.1 [src: src/main/remote/relay-host.ts:281] |

A `cast` to an unknown method is a **silent no-op** [src: src/server/platform-server.ts:128-130].
A successful `res.result` may be `null` (server coerces `undefined`→`null`)
[src: src/server/platform-server.ts:118].

### 4.7 Heartbeat / liveness

The **server pings every 30 s** (`WS_HEARTBEAT_MS`) and terminates any socket that produced no
frame/pong since the previous round — a dead peer is reaped in 30–60 s
[src: src/server/ws.ts:26-33,134-143,169-186]. The client's WS stack MUST answer protocol PING
with PONG automatically (do not disable it). No application-level keepalive exists; the client
does not need to send pings, though a periodic one helps it detect a dead link. (iOS caveat:
§12 item 1.)

### 4.8 Reconnect

Reference policy [src: src/renderer/bridge/ws-bridge.ts:879-928], adapted for a native client
(there is no page to reload):

1. On close/error: **first** fail every pending request with an `E_DISCONNECTED` error — clear
   the pending map *before* rejecting so a handler that immediately re-requests cannot collide
   with stale ids [src: ws-bridge.ts:106-114]. A promise/continuation that never settles is the
   worst outcome.
2. Retry with exponential backoff: `delay = min(1000 · 2^attempt, 10 000)` ms — 1 s, 2 s, 4 s,
   8 s, 10 s cap [src: ws-bridge.ts:922].
3. On reopen: re-subscribe all channels, then **re-issue `pty:create`** (same `persistKey`, same
   `viewerId`) for every visible terminal → tmux warm reattach. **Reset the emulator BEFORE
   painting**: unlike a fresh view, the native emulator still holds the pre-drop content, and
   painting `result.screen` below it reproduces the stacking corruption §7.8 warns about. Treat
   the create-result `screen` as a RESYNC capture — clear buffer + scrollback, then run the §7.2
   seed-paint logic (the repaintResync recipe,
   [src: src/renderer/terminal/terminal-config.ts:518-560]). The reference browser client
   sidesteps this only by reloading the whole page on reconnect [src: ws-bridge.ts:880-910] — a
   native client has no page to reload.
4. 401 at upgrade → re-auth (§3.5). Repeated indistinguishable failures (3+) MAY also be treated
   as auth-expired.
5. Initial-connect failure is treated identically to a mid-life drop
   [src: ws-bridge.ts:939-951].

### 4.9 Early events, ordering

The server can push an `ev` in the same instant the socket opens, before the app has wired its
listeners (e.g. `presence:sync` is sent immediately on join
[src: src/server/ws.ts:180-182; src/core/presence/hub.ts:146]). The client MUST buffer events for
channels with no current subscriber — bounded at **4096**, drop-oldest — and replay them to the
first subscriber of that channel [src: src/renderer/bridge/ws-bridge.ts:78-81,152-161,187-194].

### 4.10 Backpressure & size limits

Server-side, per (client, session) [src: src/core/ui-sink-registry.ts:24-38,195-221; wired
src/server/index.ts:239-260]:

| Watermark | Value | Effect |
|---|---|---|
| `WS_HIGH_WATER` | 1 MB buffered | server pauses the tmux pty client for that session |
| `WS_LOW_WATER` | 256 KB | resume |
| `WS_DROP_WATER` | 8 MB | server stops sending that session to that client, marks it desynced; on drain it sends a **full-screen redraw** via `pty:resync:<id>` instead of the missed backlog |
| `WS_MAX_PAYLOAD` | 8 MiB per **inbound** frame | larger → WS close code **1009** [src: src/server/ws.ts:38-54,106] |

Client obligations: consume inbound frames promptly (never block the socket read); handle
`pty:resync` (§7.8); keep every outbound frame under 8 MiB; do not assume byte-contiguous pty
output across a flood — a gap followed by a redraw is expected recovery, not corruption. There is
no client→server backpressure to implement.

---

## 5. RPC method catalog (v0)

Exact wire method strings. Kind: **REQ** = expects a `res`; **CAST** = fire-and-forget. Args are
positional; omitted trailing optionals follow §4.4. Full payload types in §11.

### 5.1 pty — terminal sessions [src: src/core/pty-manager.ts:1587-1704; src/shared/ipc.ts:4-29]

| Method | Kind | Args | Returns | Notes |
|---|---|---|---|---|
| `pty:create` | REQ | `[PtyCreateOptions]` | `PtyCreateResult` | join/spawn; refusals come back **in-band** (`closed`/`unavailable`), not as errors [src: pty-manager.ts:1588-1592] |
| `pty:write` | CAST | `[sessionId, data]` | — | raw keystrokes; dropped unless this connection subscribed the session via `pty:create` [src: pty-manager.ts:1597-1600] |
| `pty:resize` | CAST | `[sessionId, cols\|null, rows\|null, viewerId?]` | — | `null,null` = **PARK** (real nulls, NOT in `undef`); `viewerId` trailing, omit via `undef` [src: pty-manager.ts:1604-1620] |
| `pty:flow` | CAST | `[sessionId, resume:Bool, viewerId?]` | — | do NOT use in v0 (§7.9) [src: pty-manager.ts:1623-1633] |
| `pty:kill` | CAST | `[sessionId, viewerId?]` | — | detaches ONE view; the normal close-my-view call [src: pty-manager.ts:1635-1646] |
| `pty:destroy` | REQ (preferred) or CAST | `[persistKey, everySocket?]` | — | **PERMANENT** `tmux kill-session`. Only ever for a node the phone itself created and registered (§7.11.4) — never one it merely views; never set `everySocket` [src: pty-manager.ts:1651-1677] |
| `pty:recycle` | REQ/CAST | `[persistKey]` | — | worktree move; not needed v0 [src: pty-manager.ts:1679-1690] |
| `pty:read-scrollback` | REQ | `[persistKey]` | `String` | persisted snapshot (≤256 KB) for `fresh:true` cold replay; `''` if none [src: pty-manager.ts:1692-1694] |
| `pty:send-text` | REQ | `[persistKey, text, enter?:Bool]` | `Bool` (false = unavailable) | framed multi-line-safe delivery via tmux `paste-buffer -p`; `enter` defaults **true** [src: pty-manager.ts:1695-1697,3828-3856] |
| `pty:capture` | REQ | `[persistKey, full?:Bool]` | `String` | visible buffer (`full=true` → whole scrollback) [src: src/server/index.ts:267-269] |
| `pty:pane-command` | REQ | `[persistKey]` | `String?` | pane foreground command (`'claude'`, `'zsh'`…); `null` = unknown [src: pty-manager.ts:1699] |
| `pty:tmux-status` | REQ | `[]` | `TmuxStatus` | "tmux not found" banner data [src: pty-manager.ts:1698] |
| `pty:terminate-foreground` | REQ | `[persistKey, expectedAgentId?]` | `Bool` | model-switch helper; not needed v0 [src: pty-manager.ts:1700-1702] |

**NOT served** (a `req` gets `E_NO_HANDLER`): `pty:read-session-name`, `pty:generate-name`,
`pty:generate-group-name` [src: src/server/index.ts:262-264,366; ws-bridge.ts:236-237,255-263].
**Session names are NOT available over the WS at all on this branch**: the `sessionTitle`
field on `agent:status` is declared but never emitted by any normalizer
[src: src/core/workspace-store.ts:1093; src/shared/agents/normalize.ts:45]. v0 rows MUST show
the persisted node `title` from `workspace:load`. Live session names require a server-side
change (broadcast from the session-name sweep, src/server/index.ts:359-379) — a v1 prerequisite.

### 5.2 workspace & settings [src: src/core/workspace-store.ts:170-199; src/core/settings-store.ts:113-116]

| Method | Kind | Args | Returns | v0 use |
|---|---|---|---|---|
| `workspace:load` | REQ | `[]` | `Workspace` (v2 shape: `{version:2, activeProjectId, projects:[Project]}`) | the project + node list; call on connect and on demand |
| `workspace:save` | REQ | `[Workspace]` | null | **MUST NOT be called in v0** (read-only client) |
| `workspace:probe-folder` | REQ | `[folder:String]` | — | not needed v0 |
| `workspace:project-file-state` | REQ | `[cwd:String]` | `'present'\|'absent'\|'unreadable'` | not needed v0 |
| `settings:load` | REQ | `[]` | `Settings` | read a handful of fields (§11.7) |
| `settings:save` | REQ | `[Settings]` | null | **MUST NOT be called in v0** |
| `workspace:register-node` | REQ | `[projectId, {id, title?, agentId?, accountId?}]` | `Bool` | make a session the phone STARTED into a node on that project's canvas (§7.11) |
| `workspace:remove-node` | REQ | `[nodeId]` | `Bool` | take a node off its canvas — the second half of "End session", AFTER the kill (§7.11.4) |

The two node channels are registered in CORE (`WorkspaceStore.registerIpc`), so both shells serve
them [src: src/core/workspace-store.ts:183-202]. `workspace:register-node` IS the same store method
the desktop relay exposes to the official iOS app as `projects.registerNode` (both call
`WorkspaceStore.appendRemoteNode` [src: src/main/remote/host-service.ts:438-471]), reachable here
because that relay host service does not exist on the Server Edition. **Removal is NOT that same
one-to-one equivalence.** The relay's `pty.destroy` derives its target from the ATTACHED stream's
`persistKey` (never a client-sent id), caps it at `REF_MAX_LEN`, KILLS the tmux session, and only
THEN forgets the node [src: src/main/remote/host-service.ts:487-525]. `workspace:remove-node` is
just that final node-forget half: it takes a client-sent id directly, does no kill, and holds no
attached stream. On this WS surface the kill is a SEPARATE `pty:destroy` call the client issues
FIRST (§7.11.4); calling `workspace:remove-node` on its own forgets the node while leaving its tmux
session running. `workspace:save` remains forbidden: it rewrites the whole workspace from a client
that holds no canvas.

There is **no live workspace watcher on the server**: `workspace:external-change` IS broadcast by
these two writes [src: src/core/workspace-store.ts:1322-1323,1378-1379], but by nothing else, and no
v0 client subscribes to it. These headless node writes do NOT emit `canvas:mut` (that channel
reflects live canvas-UI edits from desktop/browser peers, not node registration, §6.4). The phone
already knows about its own register/remove (it minted the id); to pick up a peer's canvas changes it
MAY re-`workspace:load` on foreground.

### 5.3 agent status & approvals [src: src/server/index.ts:416-457]

| Method | Kind | Args | Returns | Notes |
|---|---|---|---|---|
| `agent:answer-permission` | REQ | `[{nodeId, pendingId, decision:'allow'\|'deny'}]` | `Bool` | answers a held permission hook; invalid `pendingId`/decision → `false`; on success the server broadcasts a synthetic `agent:status` so the NEEDS-YOU badge clears [src: src/server/index.ts:419-440] |
| `agent:ack-done` | REQ (result ignored) | `[nodeId]` | — | call when the user READS a finished (`done`) session; resolves the done inbox event [src: src/server/index.ts:445-447] |

`context:ensure` (CAST) is **desktop-only** — on the server it is a silent no-op; the phone still
receives `context:update` events driven by live hook activity [src: src/main/index.ts:2280;
platform-server.ts:128-130]. `agent:control` is not wired on the server.

### 5.4 transcript read [src: src/core/transcript-ipc.ts:62-98; src/server/index.ts:413]

| Method | Kind | Args | Returns |
|---|---|---|---|
| `chat:read-transcript` | REQ | `[sessionId?, cwd?, accountId?, nodeId?]` | `ChatTranscriptResult {messages:[ChatMessage], found:Bool}` |
| `claude:read-transcript` | REQ | same | `[TranscriptLine]` (flat, for search) |

`found:false` = transcript unresolvable (other machine / cleaned up); `found:true` + empty
`messages` = a real empty session. The client MUST render these differently
[src: src/shared/types.ts:2219-2231]. On the server, `nodeId` is ignored (no SSH leg; it runs on
the host that owns the transcripts) [src: transcript-ipc.ts:64-66]. Pass `sessionId` from
`agent:status`, `cwd` from the node, `accountId` from the node's `accountId` — omit absent slots
via `undef`.

### 5.5 speech (server-side whisper, optional) [src: src/core/speech/register-ipc.ts:23-48; src/shared/ipc.ts:527-535]

| Method | Kind | Args | Returns |
|---|---|---|---|
| `speech:transcribe` | REQ | `[{pcm:String(base64), language?:String}]` | `{text:String}` |
| `speech:models` | REQ | `[]` | `[SpeechModelInfo]` |
| `speech:model-download` | REQ | `[{id:String}]` | — (progress on `speech:progress` events) |
| `speech:model-delete` | REQ | `[{id:String}]` | — |
| `speech:mic-consent` | REQ | `[]` | `true` (server stub; the phone uses its own OS mic permission) |

**PCM wire encoding for a JSON WS client:** `pcm` MUST be a **base64 string of little-endian
Int16 samples, 16 kHz, mono** [src: src/core/speech/pcm.ts:22,48-58]. (The raw-Float32
ArrayBuffer form is Electron-only.) The reply carries text only — no audio, and there is no
`speech:synthesize` / `speech:cancel`. Engine choice (local whisper vs cloud) is a server-side
setting [src: register-ipc.ts:26-34]. On this self-host branch Pro model gating is removed, but
see §12 item 3.

**Bound the recording (MUST):** base64 Int16 @ 16 kHz is ≈ 42.7 KB/s, and the server's inbound
frame cap is 8 MiB (§4.10) — an oversized frame closes the WHOLE socket with code 1009
[src: src/server/ws.ts:36-54], dropping every open terminal on that server AND the dictation.
Cap recordings at ~2 minutes, or split longer audio into separate `speech:transcribe` requests.

### 5.6 usage — subscription & rate-limit dashboard [src: src/core/usage/usage-service.ts:301-460; src/server/handlers/index.ts:116-122]

The Server Edition boots the SAME core usage service the desktop runs, pointed at THIS host's own
Claude and Codex accounts (`startUsageService({localAccounts, codexAccounts})`), so every channel
below answers the host's real numbers. `usage:remote` is the one structural exception: no SSH
ControlMaster is injected server-side, so it is `[]` here. Read is on demand; nothing here is
required for a terminal to work.

| Method | Kind | Args | Returns | Notes |
|---|---|---|---|---|
| `usage:fetch` | REQ | `[accountId?]` | `ClaudeUsage` | Claude subscription windows for ONE account. Omit `accountId` = the system `~/.claude`; pass a managed account's id for its own. Cached ~5 min; a repeat inside that window is served from cache [src: usage-service.ts:301-306] |
| `usage:refresh` | REQ | `[accountId?]` | `ClaudeUsage` | Same, bypassing the cache — the pull-to-refresh path [src: usage-service.ts:307] |
| `usage:providers` | REQ | `[force?:Bool]` | `[ProviderUsage]` | Non-Claude agents' limits (codex/gemini/grok/…), each row keyed by `provider` and, for an account-scoped provider (codex), `accountId`. This is the popover's **Codex** section [src: usage-service.ts:405] |
| `usage:remote` | REQ | `[{hostKey?, force?}]` | `[RemoteAccountUsage]` | Structurally `[]` on the Server Edition (no SSH). Safe to call; build no UI expecting rows [src: usage-service.ts:440] |

**Enumerating the rows — there is no "list usage" call.** Read `settings:load` → `claudeAccounts`
(§11.7) and mirror the desktop UI's own loop: `usage:fetch()` for the system row, then
`usage:fetch(a.id)` for each account with `pending:false` and **no `host`** (a host-pinned account's
config dir lives on another machine and never resolves here), plus one `usage:providers` call for the
Codex/other rows [src: src/renderer/components/UsageIndicator.tsx:247-249,370-379]. A `status` of
`unavailable` means that identity has no OAuth subscription to show (API-key billing / logged out) —
render nothing for it, never an error.

**Push:** `usage:update` (CAST, §6) carries a fresh `ClaudeUsage` for the **system account only**,
whenever its cache repopulates [src: usage-service.ts:271-274]. Managed-account rows are not pushed;
re-fetch them on foreground and pull-to-refresh.

### 5.7 Served but not needed for v0 (do not stub-fail if used later)

fs (`fs:list/read/read-binary/write/mkdir/exists`), all `git:*`, `commit:generate`,
`files:quick-open` / `files:download-ticket` / `files:save-upload`, `session-memory:read` / `:host`,
board-log, logs, `project-settings:*`, `project-setup:*`, `claude-cli:caps`,
`codex-identity:caps` (degraded), `agent:discover-models`, github issues/control, presence,
`canvas:mut` [src: src/server/index.ts + src/server/handlers/ registrations]. File downloads do **not** stream over the WS: mint a
ticket via `files:download-ticket` → `{url, name}`, then HTTP `GET /download?t=<token>` with the
same `nt_session` cookie; tickets are one-shot, TTL 30 s
[src: src/server/download.ts:45-104; src/server/download-tickets.ts:26-67].

**Never served on self-host** (expect `E_NO_HANDLER` / structural absence): `env:snapshot`
(deliberately withheld — env-leak class) [src: ws-bridge.ts:376-378], `ssh.*`/`sshProject.*`/
`sshFs.*`, `media.*`, `updates.*`/announcements, `license.*`, `transcripts:search`,
`claudeAccounts.*`/`codexAccounts.*`, relay/pairing/remote-host, `handoff.build`,
`context-link:*` over WS, `shell.openExternal` [src: src/renderer/bridge/stubs.ts].

---

## 6. Event channels

All events arrive as JSON `ev` frames except `pty:data:<sid>` (binary, §4.5).

### 6.1 Channel inventory (v0-relevant)

| Channel | Payload (`args`) | Pushed by server? |
|---|---|---|
| `pty:data:<sid>` | `[data:String]` (from binary frame) | yes — the output stream |
| `pty:exit:<sid>` | `[exitCode:Number]` | yes [src: src/shared/ipc.ts:250] |
| `pty:size:<sid>` | `[{cols, rows}]` — authoritative co-attach grid | yes [src: ipc.ts:253] |
| `pty:closed:<sid>` | `[{by: Number\|null}]` — permanently destroyed elsewhere; do NOT respawn | yes [src: ipc.ts:256] |
| `pty:recycled:<sid>` | `[{ready:Bool}]` — `true`: re-create to co-attach; `false`: do NOT respawn | yes [src: ipc.ts:266] |
| `pty:resync:<sid>` | `[captureText:String]` — full-screen replacement; ignore empty | yes [src: ipc.ts:273] |
| `agent:status` | `[NormalizedAgentEvent]` (enriched) | yes [src: src/server/agent-status.ts:223] |
| `agent:subagent-activity` | `[{toolUseId, chunk}]` | yes (Claude only) [src: agent-status.ts:78] |
| `agent:unread-clear` | `[nodeId:String]` — another surface read it; drop unread WITHOUT re-acking | yes [src: src/server/index.ts:450-457] |
| `context:update` | `[ContextWindowUsage]` | yes [src: agent-status.ts:149] |
| `canvas:mut` | `[projectId:String, CanvasMutation]` — node upsert/remove deltas | yes [src: src/server/index.ts:86; ipc.ts:166] |
| `presence:sync` / `presence:peer` | `[PeerState[]]` / `[PeerDiff]` | yes (arrives unasked on connect — buffer it, §4.9) |
| `speech:progress` | `[{id, pct}]` | yes (model downloads) |
| `workspace:migrated` / `workspace:corrupt-recovered` | migration note / filename | yes |
| `workspace:external-change` | `[Project]` (the updated project) | **YES**, pushed by `workspace:register-node` / `workspace:remove-node` [src: src/core/workspace-store.ts:1322-1323,1378-1379]; no other server code emits it and no v0 client subscribes (the phone re-`workspace:load`s instead, §5.2) |
| `usage:update` | `[ClaudeUsage]` — the SYSTEM account's fresh snapshot (managed rows are not pushed, §5.6) | yes [src: src/core/usage/usage-service.ts:271-274] |
| `git:clone-progress`, `log:batch`, `board-log:changed:<pid>`, `project-setup:*`, `github-issues:changed:<pid>` | various | yes — not needed v0 |

### 6.2 `NormalizedAgentEvent` — the payload that drives everything

See §11.4 for the full field table. Key semantics [src: src/shared/agents/normalize.ts:3-85;
src/server/agent-status.ts:214-223]:

- `kind`: `'state' | 'subagent-start' | 'subagent-end' | 'recurring' | 'session' | 'background-task'`.
- `state` (on `kind:'state'`): `'working' | 'waiting' | 'blocked' | 'done'`.
- The server **enriches before broadcast**: a needs-you *question* has its `pendingId` stripped
  and `askKind:'question'` set (approve/deny on a question is wrong UX); a genuine *approval*
  keeps `pendingId` and gets `askKind:'approval'`. Approve/deny buttons key off the presence of
  `pendingId` [src: normalize.ts:32-43; agent-status.ts:214-223].
- `sessionTitle` is a TRAP: declared on the event type but never emitted by any producer
  [src: workspace-store.ts:1093; normalize.ts:45]. Do NOT build the session-name feature on it —
  the node `title` from `workspace:load` is the v0 name (§5.1). `sessionPhase`
  (`kind:'session'`, `start|end`) IS emitted.
- `verified` / `clientRevision` are **labels, never permissions** — no consumer may reject on
  them [src: normalize.ts:56-79].

### 6.3 Badge state machine (normative)

Per node, the client reduces the `agent:status` stream into `(state, unread)`. Initial state:
**unknown** (live state is transient server-side and is NOT persisted; after a server restart a
node is unknown until its next hook fires [src: src/renderer/state/agentStatus.ts — live `state` is excluded from the persisted subset]).

Transition rules (all MUST):

1. `kind:'state'` with `state` → adopt that state, with exceptions 2–5.
2. `idle:true` (done-only rescue) may only move a node that is currently **working** → done. It
   MUST NOT clear `waiting`/`blocked` (a pending approval is also "idle at the prompt")
   [src: normalize.ts:16-19].
3. `awaitingInput:true` (waiting) latches: hold **waiting** through the subsequent turn-end
   `done` [src: normalize.ts:20-25].
4. `interrupted:true` on a `done`: adopt done but **suppress** the completion alert and do NOT
   set unread [src: normalize.ts:12-14].
5. **Done-holdoff:** a `kind:'state'` `working` WITHOUT `newTurn` arriving < 3000 ms after the
   node entered `done` is IGNORED (state and clock untouched) — Claude runs hooks in parallel
   and POSTs land out of order, so an in-flight tool event can trail an interrupt's `done`
   [src: src/core/agent-status-mirror.ts:29-32,423-431;
   src/renderer/state/agentStatus.ts:328-337]. Without this the badge flips back to RUNNING
   forever. Hygiene (SHOULD): decay a `working` node that has emitted nothing for several
   minutes back to unknown (the desktop's sweepStaleWorking, agentStatus.ts:421-431).
6. `kind:'session'`, `sessionPhase:'start'` → reset to idle/unknown; `'end'` → reset and clear
   any recurring/fan-out UI.
7. `newTurn:true` is the only thing that clears per-turn fan-out (subagent cards)
   [src: normalize.ts:26-27].
8. **Unread** is set on a working→(done|waiting|blocked) edge while the session is not on
   screen; it is **independent of state**. It clears when the user views the session (then send
   `agent:ack-done` for a `done` node) or when `agent:unread-clear` arrives for the node (clear
   WITHOUT re-acking).

Badge mapping (list rows):

| Reduced state | Badge |
|---|---|
| `working` | **RUNNING** (pulsing) |
| `waiting` or `blocked` | **NEEDS YOU** |
| `done` | idle (no badge; unread dot if unread) |
| unknown | no badge |

Grouping (sessions list sections, matching the desktop model): **Waiting for your response** =
done ∪ waiting ∪ blocked · **Running** = working · **Unknown** = no live state. Rows sort
newest-first by last transition time; missing clocks sort last with no invented timestamp.

### 6.4 Keeping the node list live

`canvas:mut` carries `{op:'upsert', node:CanvasNodeState}` / `{op:'remove', id}` (plus
server-stamped `seq` on the team path; never trust a client-set `seq`)
[src: src/shared/types.ts:519-531]. v0 policy: apply upserts/removes to the in-memory node list
of the matching project; on any doubt, re-run `workspace:load`. Render-only kinds
(`subagent`/`loop`) never appear in persisted workspaces or mutations
[src: src/shared/types.ts:259-260].

---

## 7. Session semantics — the co-attach viewer contract

**The phone is a viewer, never an owner.** Everything below exists so a second view never
disturbs the desktop/browser viewers already attached.

### 7.1 Joining: `pty:create` with the existing node id + your own `viewerId`

- Call `pty:create` with `persistKey = <nodeId>` (the SAME id the desktop uses), required
  `cols`/`rows`, and a **unique `viewerId`** (unique within your own connection; e.g. a UUID per
  attach) [src: src/shared/types.ts:111-118; src/core/pty-manager.ts:483-503]. Omitting
  `viewerId` claims your connection's PRIMARY view slot — the ledger keys on
  `(clientId, viewerId)` and `clientId` is per WS connection [src: pty-manager.ts:497-509], so
  this can never collide with the desktop/browser canvas (a different client); it collides
  between the phone's OWN views of one session (e.g. list preview + full terminal).
- A join of a live session returns `fresh:false` [src: pty-manager.ts:1915-1928,2018-2021].
- Recommended `PtyCreateOptions` from the phone: `{cols, rows, persistKey, viewerId}` PLUS the
  node's `cwd`, `shell`, `agentId`, `accountId` and its project's id as `ownerProjectId` — all
  read from `workspace:load` — mirroring the reference co-attach viewer
  [src: src/renderer/components/kanban/ModalTerminal.tsx:255-270]. These are inert on a warm
  join, but `pty:create` SPAWNS when no live session exists (`fresh:true`, e.g. phone-first
  open after a host reboot), and a spawn without them lands in the server's `$HOME` with the
  settings-default shell [src: src/core/pty-manager.ts:2504] — and since `tmux -A` later
  attaches that same wrong session on the desktop, the damage is permanent for the node.
  For a node with `sshRemoteTmux:true` (or in a project with `ssh` set) pass
  `requireRemote:true` so the server REFUSES instead of spawning a phantom local shell under
  the remote node's id [src: src/shared/types.ts:124-138] — the Server Edition has no SSH
  manager, so such sessions can never be live there (§11.2). Never set `sshRemote` or anything
  `everySocket`-shaped.

### 7.2 Seed paint — nobody redraws you for free

tmux repaints only on SIGWINCH [src: pty-manager.ts:1958-1972]. Handle the create result in this
order (reference: ModalTerminal.tsx:255-351):

1. `result.closed` → show "closed by <peer>", do not respawn. `result.unavailable` → show "not
   available", wait. (`sessionId` is `''` in both.)
2. `fresh:true` (cold start — tmux server died, e.g. host reboot): call `pty:read-scrollback`,
   run the text through the LF→CRLF transform (below), write it, show a "session restored / cold
   start" separator. **DO NOT auto-resume the agent CLI** — resume is an owner/canvas concern; a
   viewer that fires `claude --resume` spawns a duplicate CLI
   [src: ModalTerminal.tsx:310-328].
3. `fresh:false` with `screen` present: your grid ≥ the pty grid, so no redraw is coming — paint
   `screen` FIRST, before consuming the live stream [src: src/shared/types.ts:159-179].
   - `screen` is `capture-pane` output: plain text, **LF-separated, no CR**. The emulator MUST
     be in a no-EOL-conversion mode and the client MUST convert `\n` → `\r\n` itself, after
     stripping exactly ONE trailing newline (else the paint staircases / the top row doubles)
     [src: src/renderer/terminal/terminal-config.ts:585-615; pty-manager.ts:3671-3687].
   - If `cursor {x,y,visible}` (0-based) is present, then after painting emit
     `ESC [ {y+1} ; {x+1} H` followed by `ESC [ ?25h` (visible) or `ESC [ ?25l` (hidden)
     [src: terminal-config.ts:577-581; types.ts:143-148].
4. `fresh:false` with `screen` absent: your grid was smaller — the pty resized to you and tmux
   IS redrawing over the live stream. Paint nothing.
5. If `coAttachMouse:true`: write **`\x1b[?1000h\x1b[?1002h\x1b[?1006h`**
   (`CO_ATTACH_MOUSE_SEQ`) into the emulator AFTER the seed paint, so wheel/touch scrolling
   drives tmux copy-mode history. Idempotent [src: terminal-config.ts:507-514;
   types.ts:198-214].
6. Subscribe `pty:data/exit/size/closed/recycled/resync` for the sessionId, wire keyboard input
   to `pty:write`, then report your real size via `pty:resize`, then focus.

### 7.3 The size ledger & the PARK signal

- The pty runs at `min(cols) × min(rows)` over all **viewing** subscribers
  [src: pty-manager.ts:559-563].
- `pty:resize (sessionId, cols, rows, viewerId)` is a **report, not a command**; the
  authoritative grid comes back on `pty:size:<sid>` — on receipt, resize the emulator to exactly
  that grid and letterbox the slack. Driving your own fit result instead makes viewers diverge.
  Note: the server only sends `pty:size` to a subscriber whose grid differs from the effective
  size — a solo viewer never gets one, so do your initial local fit too
  [src: pty-manager.ts:3275-3284].
- **PARK**: when the terminal view goes to background / off screen, send
  `pty:resize(sessionId, null, null, viewerId)` with **literal JSON nulls, NOT listed in
  `undef`**. This deletes your entry from the size ledger — you keep receiving output but stop
  clamping the desktop's grid [src: pty-manager.ts:3508-3520]. Never send `0` (clamped up to 1 —
  a 1-cell terminal for everyone); never just omit. When the view returns, report a real size
  again.
- The client MUST park on: app → background, terminal screen dismissed but session kept warm,
  and device rotation transitions longer than a debounce. It MUST un-park (real resize) on
  return.

### 7.4 Closing: kill only your own viewer

- On view close: `pty:kill(sessionId, viewerId)` — detaches only your composite
  `(clientId, viewerId)` subscription; the tmux session and every other viewer are untouched
  [src: pty-manager.ts:1637-1641,3543-3582]. **`pty:kill`'s `viewerId` MUST match the one used at create** — viewer keys are scoped per
  connection [src: pty-manager.ts:497-509], so a mismatched or omitted `viewerId` cannot touch
  the desktop's views; it targets the phone's own PRIMARY slot (usually a silent no-op that
  LEAKS your real subscription).
- The phone MUST NOT call `pty:destroy` or `pty:recycle` on a node it is merely VIEWING — those
  are node-owner actions (permanent kill / worktree move) [src: pty-manager.ts:1637-1641]. Ending a
  session the phone itself created is the one exception, and it has its own ordering rule (§7.11.4);
  `pty:recycle` has no phone use at all.
- If the connection drops uncleanly the server sweeps your views [src: pty-manager.ts:3595+],
  but send `pty:kill` on graceful close anyway (deterministic snapshot + flow-resume).

### 7.5 Passive close events

- `pty:closed:<sid>` `{by}`: node permanently destroyed elsewhere → show "closed", do NOT
  respawn.
- `pty:recycled:<sid>` `{ready}`: `true` → re-`pty:create` to co-attach the replacement;
  `false` → do NOT respawn.

### 7.6 Input: `pty:write` vs `pty:send-text`

| Path | Use for | Semantics |
|---|---|---|
| `pty:write(sessionId, data)` CAST | every live keystroke | raw bytes to the pty; NO framing — a multi-line blob becomes one submit per `\n` |
| `pty:send-text(persistKey, text, enter?)` REQ | **any paste / composed block / dictated text** | server delivers via tmux `load-buffer -` (stdin) + copy-mode exit + `paste-buffer -p -r`: bracketed-paste framing applied IFF the pane app requested DECSET 2004; `-r` keeps `\n` as `\n` [src: src/core/tmux-naming.ts:64-176; pty-manager.ts:3828-3856] |

Rules:

- **Multi-line paste MUST use `pty:send-text`**, never a raw `pty:write` of the blob.
- `enter` defaults **true** (appends a submit in the same tmux invocation);
  `enter:false` = insert without submitting. `send-text('', enter:true)` = "submit whatever is
  composed" (a lone Enter) [src: tmux-naming.ts:44-58,173-176].
- Dictation: **Send** = `send-text(text, enter:true)`; **Insert** = `enter:false`. Nothing may
  auto-submit — the user always decides.
- **Shift+Enter** (hardware keyboard / toolbar) MUST be sent as `\x1b\r` (ESC+CR) via
  `pty:write`, so agent CLIs insert a newline instead of submitting
  [src: terminal-config.ts:761-767].

### 7.7 OSC 52 — clipboard, write-only

tmux emits OSC 52 into the ordinary output stream on copy (drag-select in copy-mode; also apps
like vim `"+y`). Register an OSC 52 handler:

- Parse `<selection>;<base64>`; base64-decode to UTF-8; write the **device clipboard**; swallow
  the sequence [src: src/renderer/terminal/osc52.ts:6-19].
- **WRITE-ONLY**: a `?` payload is a clipboard READ query from the remote program — MUST be
  ignored (return nothing). Also ignore empty, malformed, or >1 MB-base64 payloads
  [src: osc52.ts:1-10]. Never expose the phone's clipboard to the remote side.
- SHOULD show a transient "Copied" pill on a successful OSC 52 write, EXCEPT for agents that
  print their own copy confirmation (claude) — one gesture, one message.

### 7.8 `pty:resync` — mandatory

When the server dropped your backlog (§4.10) it sends `pty:resync:<sid>` with the CURRENT screen
text. On receipt: **reset the emulator and write the capture** (it REPLACES the buffer, never
stacks), after the LF→CRLF transform. **Ignore an empty payload** — a wrongly-reset screen is
unrecoverable [src: terminal-config.ts:518-549; pty-manager.ts:3668-3687].

### 7.9 Flow control — leave it alone

`pty:flow` pauses/resumes the shared source. The reference co-attach viewer deliberately never
calls it — a pause you own and never resume freezes the terminal for EVERY viewer
[src: ModalTerminal.tsx:306-308]. v0 MUST NOT call `pty:flow`; the primary viewer paces the
session, and the server's own watermarks (§4.10) protect a slow phone via resync.

### 7.10 `persistent:false` — plain-shell sessions

`PtyCreateResult.persistent:false` means no tmux underneath: killing the pty client kills the
shell and everything under it (possibly an agent mid-turn). Treat such sessions as
non-droppable: the phone SHOULD avoid `pty:kill` churn on them beyond explicit user close, and
absent/`undefined` means unknown → assume persistent, never protect on a guess
[src: src/shared/types.ts:215-231].

### 7.11 Spawning a NEW session — the one place the phone is the first client

§7 opens with "the phone is a viewer, never an owner", and this is the bounded exception to it: a
session that does not exist yet has no other viewers to disturb. Everything the phone touches here
is its OWN node. It still MUST NOT `pty:destroy` / `pty:recycle` / `workspace:remove-node` a node
somebody else created.

**That last rule is part client-contract, part server-enforced, and the split matters.** The server
DOES refuse to remove a node that is not a **terminal** kind: a sticky, a group frame, an editor or a
diff node is left untouched and the call answers `false` [src: src/core/project-node-append.ts:232-252].
That guard exists because deleting a group frame out from under its children would leave them
pointing at a parent that no longer exists. It is the guard, not the transport, that makes the
terminal-only rule true: the relay's `pty.attach` also takes a client-chosen node id and will
CREATE a tmux session for it, so having an attached stream proves a session exists, never that the
id names a terminal node on anyone's canvas [src: src/main/remote/host-service.ts:270-285]. What the server does NOT enforce is
*whose* terminal: every authenticated connection is an operator of this host, so
`workspace:remove-node` will forget any TERMINAL node id it is given, including a session another
surface created. Nothing stops a client that removes a terminal it did not create, which is why "a
node somebody else created" stays a MUST NOT rather than left implicit.

Four steps, in this order. Steps 2 and 4 are separate on purpose: the session is live after step 2
whether or not step 4 succeeds, and a refusal there leaves a running-but-unregistered session, not a
broken one.

#### 7.11.1 Mint the node id yourself

The id must match **`^term-[a-z0-9]+-[a-z0-9]{1,16}$`** AND be **at most 128 characters** long. The
desktop shape is `term-<base36 ms>-<random hex>` [src: src/core/project-node-append.ts:31-39], and the
128 cap is the shared `NODE_ID_MAX` the pty layer already enforces on a `persistKey`, applied at
registration too so the append can never accept an id that `pty:create` would then reject as too long
(the regex's middle segment is itself unbounded, so the cap is a separate check)
[src: src/core/project-node-append.ts:108; src/shared/safe-id.ts:13,31-35]. The id becomes a **tmux
session name**, which is why the alphabet is not negotiable. Mint it ONCE and use the same string as
`persistKey` in every later call. WHICH step refuses a violation depends on which rule it breaks,
and neither refusal is the one to design around: an id over 128 characters (or outside
`[A-Za-z0-9._-]`) is refused by **`pty:create` at step 2**, before any session exists, because that
is the choke point every session spawn passes through
[src: src/core/pty-manager.ts:1949-1960]. An id that satisfies that predicate but not the stricter
`term-…` shape spawns happily and is refused at **step 4**, by which point the session is already
running under an id nothing will ever register.

#### 7.11.2 Spawn: `pty:create` with an id no live session holds

Identical to a join (§7.1) except that it takes the spawn branch and answers `fresh:true`.

- `cwd` is **required in practice**: pass the project's own absolute `cwd` from `workspace:load`.
  Without it the session lands in the server's `$HOME` with the settings-default shell, and because
  `tmux new-session -A` reattaches that same session forever after, the mistake is permanent for
  that node (§7.1) [src: src/core/pty-manager.ts:2504].
- Pass `agentId` (drives the hook env injected at spawn), `accountId` when launching under a managed
  Claude account, and `ownerProjectId` (the project's machine-local id — it is what proves to the
  pane-ownership ledger which project spawned the pane).
- Do NOT spawn into an SSH project or against a node shape carrying `sshRemoteTmux`: the Server
  Edition has no SSH manager, so such a session can never be the right one (§11.2). There is nothing
  to pass `requireRemote` on here, because the phone is choosing the project.
- Seed paint is the §7.2 `fresh:true` branch, minus the scrollback read: a session created one
  moment ago has no snapshot to replay.

#### 7.11.3 Deliver the launch line: `pty:send-text`

**The phone assembles the command.** This is deliberate parity with the relay leg the official iOS
app already uses (the desktop publishes the inputs, not the rendered line), not an oversight.

Inputs, all readable over the WS:

| Input | Where from |
|---|---|
| the CLI to run (`claude`, `codex`, `gemini`, …) | fixed per agent; custom agents come from `settings:load` → `customAgents` [src: src/shared/agents/config.ts] |
| starting permission mode | `settings:load` → `claudePermissionMode`, overridden per project by the `Project.defaultPermissionMode` from `workspace:load` [src: src/renderer/state/permissionMode.ts] |
| whether `--permission-mode auto` may be emitted | `claude-cli:caps` → `autoPermissionMode`. **CLAUDE only** — an old claude CLI exits 1 on the value, and generalizing this flag to another agent silently downgrades that agent's sessions [src: src/core/claude-cli.ts:30-43] |
| whether `--session-id <uuid>` may be minted | `claude-cli:caps` → `sessionIdFlag` (feature-detected from `--help`, never a version floor: an unknown flag makes the CLI exit) |
| which managed Claude account to run as | `settings:load` → `claudeAccounts` (skip any `pending` one, and any with a `host` — those live on an SSH host), defaulted per project by `Project.defaultAccountId` from `workspace:load`. Whatever is chosen goes into BOTH `pty:create` and the registration (§7.11.4) |

The normative flag grammar is `assembleLaunchCommand` + `approvalFlags`
[src: src/shared/agents/launch.ts:134-189; src/shared/agents/approval-mode.ts]. Two rules from it a
reimplementation gets wrong:

- A mode the CLI cannot express emits **no flag**, never a substituted nearest match.
- Flag placement follows the agent's `argvPromptSeparator`: where one exists (grok's `--`) the flag
  goes BEFORE it, because `--` is end-of-options and a flag after it becomes a positional.

**Timing — do not write blind.** A fresh shell's init (rc files, ZLE setup) resets the tty with a
flush that eats part of a queued line, and a half-eaten agent launch line sits at the prompt with an
unbalanced quote instead of running. Subscribe `pty:data:<sid>` FIRST, then send after **200 ms of
quiet following the first output**, with a **1.5 s** cap on total silence (write anyway), which is
exactly what the desktop does [src: src/renderer/nodes/TerminalNode.tsx:2970-3004]. Use
`pty:send-text(persistKey, cmd, true)`, never a raw `pty:write` (§7.6).

#### 7.11.4 Register it: `workspace:register-node`

`workspace:register-node(projectId, {id, title?, agentId?, accountId?})` → `Bool`.

- Those four fields are **all** the caller may choose. Position, size, color, `titleAuto`, and the
  node's `cwd` are derived host-side, and a `ssh` block is copied only from a genuine remote-tmux
  sibling [src: src/core/project-node-append.ts].
- `accountId` MUST be sent when the session was launched under a managed account. Registering
  without it makes the node the SYSTEM account, after which every account-scoped reader (transcript,
  context meter, find-bar index) resolves against the wrong root and a cold restore resumes the
  conversation under the wrong identity.
- **Encode the three optionals as a JSON string or leave them out.** `null` is accepted and read as
  "omitted", because that is what a Swift encoder writes for an absent optional (`encode` rather than
  `encodeIfPresent`) and no field-level equivalent of the wire protocol's `undef` marker exists to
  tell the two apart. **Any other type refuses the whole registration** — a number, an object, an
  array, a boolean. The server will not drop a field it cannot read and register the node anyway:
  that is exactly how a session launched under a managed account would come back as the system one
  [src: src/core/project-node-append.ts:54-94].
- `false` is the only failure signal, and it **cannot tell "refused forever" from "could not do it
  right now"**: the boolean carries no reason. Two disjoint sets return it. Permanent refusals a
  retry can never fix: a payload that is not an object, a non-string `id`, or any of `title` /
  `agentId` / `accountId` present as something other than a string (all refused before the server
  touches disk [src: src/core/project-node-append.ts:54-94]); an `id` that is unsafe, empty, or
  longer than the 128-char `NODE_ID_MAX` `pty:create` also enforces on a `persistKey`
  [src: src/core/project-node-append.ts:108; src/shared/safe-id.ts:13,31-35], an unsafe `accountId`
  [src: src/core/project-node-append.ts:114-119], a duplicate `id` already on the canvas
  [src: src/core/project-node-append.ts:139], a `projectId` the server has no local entry for or a
  cwd-less (inline) project [src: src/core/workspace-store.ts:1299-1301], or a `project.json` that will
  not parse or is not version 1, or holds a node entry that is not an object
  [src: src/core/project-node-append.ts:120-137]. Transient local-I/O
  failures where a retry MIGHT succeed: the server could not read the project file
  [src: src/core/workspace-store.ts:1303-1307] (an SSH project whose file is not on this machine
  fails here too, and no retry fixes that one), or the atomic write failed
  [src: src/core/workspace-store.ts:1311-1315] (the write is atomic, so nothing landed and a re-call
  is safe). Because the wire result cannot separate the two, the client MUST, on `false`, **retry the
  register call a bounded number of times** (a few attempts, short backoff). A retry is always safe:
  every `false` path wrote nothing, and if a write actually landed but its response was lost, the
  retry meets the duplicate-`id` refusal [src: src/core/project-node-append.ts:139]: the SERVER is
  now in the "already registered" state, but the wire still answers a bare `false`, byte-identical to
  a genuine refusal, so **the retry loop by itself can never conclude success**. When the retries are
  exhausted and the answer is still `false`, the client MUST establish the truth with a
  `workspace:load` read-back: find the project by `projectId` and look for the minted node `id` among
  its `nodes`. **Check `unavailable` FIRST — an absent node is only evidence when the project could
  actually be read.** A ref whose `project.json` the server cannot read is not omitted from the
  reply: it comes back as a labelled placeholder with `unavailable: true` and an EMPTY `nodes` array
  [src: src/core/workspace-store.ts:1608-1617], which is the same shape as a project that genuinely
  does not hold your node — and the read failure that produced it is the very same one that made the
  register answer `false`, so the two co-occur exactly when you are trying to tell them apart. So:
  **project missing, or `unavailable === true` ⇒ the outcome is UNKNOWN** (say so, offer a manual
  retry later; do not report "not saved"). Only on a readable project does the node decide it:
  **present ⇒ registered** (a landed-but-lost write; show the session card, done), **absent ⇒
  genuinely unsaved** (surface "started, not saved to the canvas"). The session is running
  throughout, and you **never respawn** it on any `false`; the read-back decides only whether the
  node was recorded on the canvas, never whether the session is alive.
- Omit `title` and the host derives the starting title from the agent's own label, but **only for
  BUILTIN agents** (`claude`, `codex`, `gemini`, …): the label is looked up in the builtin config,
  which returns nothing for a custom id, so a custom agent falls back to the literal **"Mobile
  session"** [src: src/core/project-node-append.ts:165,174; src/shared/agents/config.ts:328]. A
  desktop-minted node does NOT fall back that way (it resolves the custom agent's own label
  [src: src/renderer/state/workspace.ts:496-502]), and `titleAuto` only replaces the placeholder once
  the agent emits a session name, which a custom agent without a title-read-capable base never does,
  so the "Mobile session" placeholder would stick permanently. Since §7.11.3 lets the client launch
  custom agents, **send an explicit `title` for a custom agent** (the client already has its label
  from `settings:load` → `customAgents`, §7.11.3).

**Ending a session the phone created** is the mirror image and the order matters:
`pty:destroy(persistKey)` (permanent `tmux kill-session`) and THEN
`workspace:remove-node(nodeId)`, so the file only ever loses a node whose session is already gone.
Never pass anything `everySocket`-shaped.

`false` from the remove is as overloaded as the register's, and here the ambiguity outlives the
call. Four things return it: the node was in no local project file (an unregistered session, or one
already removed, which is an answer, not an error); the node is present but is **not a terminal
kind**, so the server refuses it outright (a PERMANENT refusal no retry resolves, though the phone
only ever removes a terminal session it created and so never reaches this unless it breaks the §7.11
rule) [src: src/core/project-node-append.ts:232-252]; the file holding it could not be read
[src: src/core/workspace-store.ts:1365]; or the rewrite failed
[src: src/core/workspace-store.ts:1372]. Since `pty:destroy` has already run by then, the two I/O
failures leave a node on the canvas whose session is gone. Retry the remove a bounded number of
times on `false` (it writes nothing when it fails), but do NOT wait for a `true` that may never come:
a remove that already LANDED answers `false` on every retry (the node is gone, so it now reads as "in
no file", byte-identical to a genuine read/write failure). So when the retries are still `false`,
establish the truth the way the register does, with a `workspace:load` read-back keyed on the node
`id` — and with the SAME precondition, which bites harder here: a project that came back
`unavailable: true` carries an empty `nodes` array, so reading "absent" from it as **removed** would
report a removal that never happened, on exactly the read failure that returned the `false`
[src: src/core/workspace-store.ts:1608-1617]. **Project missing or `unavailable === true` ⇒ UNKNOWN**,
leave the session listed as ending and retry later. On a readable project: **absent ⇒ removed**
(done), **present ⇒ the write never landed** (for a terminal the phone created, the only node it
removes, the session is already dead, so this is a stale node the user closes from the desktop).
Either way the node is not lost: it cold-restores as a dead session the user can close from the
desktop.

#### 7.11.5 Known v0 limits

- **A desktop or browser canvas already open does NOT show the new node until it reloads.** The
  append broadcasts `workspace:external-change`, but nothing subscribes to that channel today, and
  the append does not emit a `canvas:mut` (the reflector stamps a total order for CLIENT casts and
  holds no canvas state) [src: src/core/canvas-sync.ts]. The phone itself sees its node on the next
  `workspace:load`. Emitting a server-originated `canvas:mut` upsert is the follow-up that makes
  this live.
- **No placement control.** The node lands below the lowest existing node, aligned to its x. There
  is no grouping, no worktree binding, and no kanban assignment from the phone.
- **Local projects only.** An SSH project's `project.json` lives on another machine, and this
  edition cannot reach it.

---

## 8. App architecture

Stack: **SwiftUI** app, **SwiftTerm** for the terminal emulator, Swift Concurrency
(actors/async-await), iOS 17+.

### 8.1 Modules

```
ServerProfileStore      // [{id, name, baseURL}] in app storage; secrets in Keychain (§10)
AuthClient              // §3: login/logout/setup POSTs; redirect-disabled EPHEMERAL URLSession
                        // with the cookie jar OFF (§10.1a); manual Set-Cookie capture
RpcClient  (actor)      // ONE per server: socket, id counter, pending map, undef codec,
                        // binary decode, channel fan-out + early-event buffer, reconnect (§4)
WorkspaceStore          // per server: Workspace snapshot + canvas:mut application (§6.4)
AgentStatusStore        // per server: nodeId → (state, unread, sessionId,
                        // pendingId/askKind, contextUsage) reduced per §6.3
TerminalSessionVM       // per open terminal: viewerId, seed-paint, size/park, input routing (§7)
SpeechService           // Apple SFSpeechRecognizer (default) | server whisper via speech:transcribe
NotificationService     // local notifications (§9.6)
KeychainService         // cookies + opt-in passwords
```

### 8.2 RpcClient contract (per server)

- `request(method, args) async throws -> JSONValue` — assigns `id`, encodes `undef`, awaits the
  matching `res`; rejects with typed errors mapping `E_NO_HANDLER` / `E_HANDLER`; all pending
  continuations fail with `E_DISCONNECTED` on close (§4.8 step 1).
- `cast(method, args)` — fire-and-forget.
- `subscribe(channel) -> AsyncStream<[JSONValue]>` — with the 4096-entry early buffer (§4.9).
- Argument model: `enum RpcArg { case value(JSONValue); case null; case omitted }` — `omitted`
  emits `null` + `undef` index; `null` emits bare `null` (§4.4).
- Binary frames decode per §4.5 and fan out as `pty:data:<sid>`.
- Reconnect coordinator per §4.8; publishes `connectionState: connected | reconnecting |
  authRequired | offline` for the UI.

### 8.3 SwiftTerm configuration

- Feed `pty:data` bytes to the terminal verbatim (they are a live VT stream).
- Seed paints (`screen`, scrollback snapshot, resync captures) are **capture text**: strip one
  trailing `\n`, convert `\n`→`\r\n`, then feed (§7.2/§7.8). Never enable an automatic
  LF-conversion mode for the live stream.
- Resize the terminal to the `pty:size` grid, not the local fit (§7.3); letterbox slack.
- Install the OSC 52 handler (§7.7). Default font size **13 pt**; font/theme per §9.4.
- Do not implement local scrollback UI expectations beyond what tmux provides: the wheel/scroll
  gesture drives tmux copy-mode (mouse reporting is on after `CO_ATTACH_MOUSE_SEQ`).

### 8.4 Multi-server

One `RpcClient` (+ stores) per configured server, connected lazily (on app foreground for all
servers marked "auto-connect", else on demand). The HOME screen aggregates across servers; each
list row carries its server identity. Failures are isolated per server.

---

## 9. Screens & UX

### 9.1 HOME

- **Header:** "nodeterm" logo · inbox icon (unread/NEEDS-YOU feed) · settings gear.
- **"Welcome back"** greeting.
- **3 stat tiles:**
  - *Active sessions* — count of terminal-kind nodes (`kind:'terminal'`) in non-`closed`
    projects across currently **connected** servers.
  - *Servers* — configured servers, with online count.
  - *Projects* — non-`closed` projects across connected servers.
- **SESSIONS list** — live sessions across all connected servers. Row: title (session title or
  node title), project name, server name (when >1 server), agent badge per §6.3
  (RUNNING / NEEDS YOU / idle), unread dot, optional context-meter %. Tap → terminal view.
  NEEDS-YOU rows with `askKind:'approval'` show inline **Allow / Deny** (calls
  `agent:answer-permission`); `askKind:'question'` rows deep-link into the terminal instead
  (no approve/deny — the `pendingId` was stripped, §6.2).
- **SERVERS list** — each configured server: name, host, online/offline (WS state), tap →
  server detail (projects) or re-auth sheet when `authRequired`.
- **Quick actions:** **Add Server** (§3.6 form). QR pairing = v1.
- **DISCOVER carousel:** three static education cards — *tmux Sessions* (sessions survive the
  app), *Scrollback* (history restored after reboots), *Voice → Terminal* (dictation).
- **USAGE panel (bottom)** — the subscription and rate-limit dashboard, mirroring the desktop
  popover (§5.6). One block per identity, in this order: the **system** account first, then each
  managed Claude account (`settings.claudeAccounts`, `pending:false` and no `host`), then the
  **Codex** and any other rows from `usage:providers`. Each block is the account's label/email as a
  heading and one **bar per limit** — Session, Weekly, and any per-model scoped cap (`scopeLabel`,
  e.g. **Fable**) — each showing **percent LEFT** and its reset time. The bar INVERTS the wire
  convention: `UsageLimit.usedPercent` is the portion USED, the bar fills to `100 - usedPercent`
  (the `resetsAt` is Unix ms, shown relative — "Resets in 5h 1m"). Pull-to-refresh calls
  `usage:refresh` for every visible account and `usage:providers` with `force`. An identity whose
  `status` is `unavailable` is OMITTED, not shown empty; `error` shows a one-line "couldn't read".
  This is v0 and needs no new server work — every channel is already served (§5.6). N/A when no
  server is connected (nothing to read).

- **Hard requirement (repeat of §1):** no subscription banner, no quota, no "Unlock", no Pair
  Desktop, no Restore Purchase.

### 9.2 Server detail / project list

Projects from `workspace:load` (hide `closed:true`; grey out `unavailable:true`
[src: src/shared/types.ts:674-685]). Per project: name, color dot, session rows (terminal nodes,
with badges). Non-terminal node kinds (`sticky`, `editor`, `web`, …) MAY be listed read-only or
omitted in v0.

### 9.3 TERMINAL VIEW

- SwiftTerm surface per §8.3; full co-attach lifecycle per §7 (join on appear, park on
  background, kill-own-viewer on close).
- **Keyboard accessory toolbar:** `Esc` · `Tab` · `Ctrl` (latching modifier) · arrow keys ·
  `⌘V` paste (→ `pty:send-text`, `enter:false`) · dictate mic. Toolbar contents user-configurable
  (Settings → Input).
- Header: session title, agent badge, context-meter pill (model + %, from `context:update`),
  close.
- Viewing a `done` session clears unread and fires `agent:ack-done` (§5.3).
- Cold start (`fresh:true`): replay scrollback + "cold start — agent resume happens on the
  desktop" note; never auto-resume (§7.2).
- Haptic feedback on toolbar keys when "Haptic Keys" is on.

### 9.4 SETTINGS

| Group | Items |
|---|---|
| **Terminal** | Theme (dark default + a small preset list) · Fonts & Size (default 13 pt) · Advanced (bell, cursor style) |
| **Input** | Toolbar config (choose/order accessory keys) · Speech: **Apple on-device dictation (default)** or **Server whisper** per server (`speech:transcribe`, §5.5) · Haptic Keys toggle |
| **Notifications** | local-notification toggles per §9.6 (completion, needs-you), honest scope copy |
| **Integrations** | none in v0 (empty state) |
| **About** | version, OSS licenses, link to nodeterm |

Server-side `Settings` is read-only for the phone; the few fields it may read are listed in
§11.7. The phone MUST NOT write `settings:save` / `workspace:save` in v0 (§5.2).

### 9.5 Dictation

- Default: `SFSpeechRecognizer` with on-device recognition where available; standard mic + speech
  permission prompts.
- Alternative (per server, opt-in): record 16 kHz mono PCM, Int16 LE, base64 → `speech:transcribe`
  (§5.5). Show which engine transcribed.
- Result lands in a review field with **Send** / **Insert** (§7.6). Never auto-submits.
- Server-whisper recordings are length-bounded (§5.5: the 8 MiB frame cap ⇒ ~2 min per request).

### 9.6 Push notifications & Live Activities — honest scope

**The self-hosted server has NO push relay.** There is no APNs token registration, no push
endpoint, and nothing in the Server Edition that could deliver a background notification.

**v0 behavior (the whole truth):**

- While the app is **foregrounded**, status is live via the WS (`agent:status`): in-app banners
  and the inbox update in real time.
- The app MAY schedule **local notifications** for working→needs-you/done edges observed while
  it is running (including the short background grace period after backgrounding, and during
  `BGAppRefreshTask` windows, where it may briefly connect, drain `agent:status`, notify
  locally, and disconnect). iOS grants refresh windows opportunistically — this is best-effort
  and MUST be described to the user as such ("Notifications work while nodeterm is open; iOS
  may occasionally check in the background.").
- The client MUST NOT implement silent workarounds that will not pass App Store review: no
  audio-session keep-alive, no location keep-alive, no VoIP push abuse, no infinite background
  socket.

**v2 (out of scope, one paragraph):** real push requires a server-side component: the Server
Edition (or a sidecar) would hold APNs credentials (an APNs auth key for the app's bundle id),
persist device tokens per authenticated session, subscribe to the same agent-status stream the
WS broadcasts, and POST alerts/Live-Activity updates to APNs on needs-you/done edges — plus
token lifecycle (rotation, pruning on 410) and per-server opt-in UI. Since self-hosters cannot
hold the app's APNs key themselves, the practical design is a thin, privacy-preserving push
relay operated by the app vendor OR self-signed JWT relaying via a vendor proxy; both are
explicitly a v2 design decision, not something v0 fakes.

---

## 10. Security requirements

1. **Keychain:** the `nt_session` cookie value per server MUST live in the iOS Keychain
   (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` or stricter). The password is stored ONLY
   if the user opts into auto-relogin, also Keychain-only. **Never** UserDefaults, never iCloud
   backup for secrets (`ThisDeviceOnly`), never plist/files.
1a. **Bypass the system cookie jar entirely (MUST):** all HTTP and WS traffic uses an ephemeral
   `URLSessionConfiguration` with `httpCookieAcceptPolicy = .never` and
   `httpShouldSetCookies = false`. A default configuration persists `nt_session` into the shared
   `HTTPCookieStorage` (`Cookies.binarycookies` — a plain file outside the Keychain, violating
   rule 1) and auto-attaches it by HOSTNAME; RFC 6265 cookies are not port-scoped, so two
   configured servers on one Tailscale hostname at different ports would silently receive each
   other's sessions. The ONLY cookie transport is a manually attached
   `Cookie: nt_session=<Keychain value>` header keyed by server PROFILE id, never by hostname.
2. **No secrets in logs or URLs:** the cookie, passwords, download-ticket tokens, and setup
   tokens MUST NOT appear in log statements, analytics, crash reports, or URL query strings
   (login is a POST body; the only tokened URL is the server-minted `/download?t=…`, which is
   one-shot + 30 s TTL and MUST NOT be logged). Redact `Cookie`/`Set-Cookie` headers in any
   network debug output.
3. **TLS:** system trust store; no pinning in v0 (Tailscale/LE certs rotate); NO
   skip-validation option. Plain `http` only for explicit localhost dev (§2.1); ATS exceptions
   scoped accordingly.
4. **Origin header omitted** on the WS upgrade (§4.1) — the origin check exists to stop browser
   CSWSH; a native client authenticates purely by cookie.
5. **OSC 52 is write-only** (§7.7): never answer a clipboard read query.
6. **Treat all server-pushed strings as data**, not markup/commands: session titles, agent
   `lastMessage`, transcript text are rendered as plain text (no attributed-string/HTML
   interpretation, no URL auto-execution).
7. **Frame hygiene:** drop malformed frames without closing (§4.3); cap in-memory buffers
   (early-event 4096; per-terminal output ring bounded); every outbound frame < 8 MiB (§4.10).
8. **No entitlement/licensing code paths** — nothing phones home; the only network peers are the
   user's configured servers.
9. Logout deletes local secrets even though the server token survives to TTL (§3.4) — say so in
   the UI copy.

---

## 11. Type appendix (wire JSON)

Golden rule: the wire has **no `undefined`**. Inside objects, an absent field is simply missing;
"key absent" and "value null" are distinct where noted (`TmuxStatus.platform`,
`ContextWindowUsage.model`) [src: src/shared/types.ts]. Types below are the shared TS shapes in
`src/shared/`.

### 11.1 `Workspace` [src: src/shared/types.ts:692-696]

`{ version: 2, activeProjectId: String ('' = welcome), projects: [Project] }`

### 11.2 `Project` (fields a phone reads) [src: types.ts:611-690]

| field | type | opt | phone use |
|---|---|---|---|
| `id` | String | no | project id |
| `name` | String | no | label |
| `color` | String | no | accent |
| `cwd` | String | yes | default cwd (display / transcript reads) |
| `ssh` | `{server, remoteCwd}` | yes | present ⇒ SSH project — its nodes' sessions live on ANOTHER host the Server Edition cannot reach (no SSH manager [src: src/renderer/bridge/stubs.ts:133-158]). Show read-only / not-openable in v0; any create for such a node MUST carry `requireRemote:true` (§7.1) |
| `nodes` | `[CanvasNodeState]` | no | the session/node list |
| `defaultPermissionMode` | String | yes | display only |
| `kanban` | object | yes | v1 |
| `closed` | Bool | yes | hide from lists |
| `unavailable` | Bool | yes | grey out, read-only |
| `viewport`, `breadcrumbs`, `capabilityAck`, `bridges`, `ropes`, `dinoHighScore`, `remote`, … | — | yes | **IGNORE** (canvas/machine-local) |

### 11.3 `CanvasNodeState` (phone-relevant subset) [src: types.ts:295-388]

| field | type | opt | note |
|---|---|---|---|
| `id` | String | no | node id = tmux persist key (`nt-<id>`) |
| `kind` | String | no | `terminal \| sticky \| group \| editor \| diff \| video \| web \| browser \| dino` on the wire; `subagent`/`loop` never persisted [src: types.ts:259-260] |
| `title` | String | no | display name |
| `color` | String | no | dot color |
| `cwd` | String | yes | terminal working dir |
| `agentId` | String | yes | `claude \| codex \| gemini \| opencode \| grok \| copilot \|` custom — an "agent node" is a terminal with this set |
| `accountId` | String | yes | managed Claude account (pass to transcript reads) |
| `agentSessionId` | String | yes | minted session id for resume (owner concern) |
| `tags` | [String] | yes | labels |
| `parentId` | String | yes | group frame |
| `position`,`size`,`collapsed`,`premaxRect`,… | — | yes | **IGNORE** (canvas geometry) |

### 11.4 `NormalizedAgentEvent` [src: src/shared/agents/normalize.ts:7-85]

| field | type | opt | meaning |
|---|---|---|---|
| `nodeId` | String | no | subject node |
| `agentId` | String | no | CLI |
| `kind` | String | no | `state \| subagent-start \| subagent-end \| recurring \| session \| background-task` |
| `state` | String | yes | `working \| waiting \| blocked \| done` (kind:'state') |
| `interrupted` | Bool | yes | done-only: suppress alert/unread |
| `idle` | Bool | yes | done-only rescue: only moves a still-`working` node |
| `awaitingInput` | Bool | yes | waiting-only: hold through turn-end done |
| `newTurn` | Bool | yes | clears per-turn fan-out |
| `sessionId` | String | yes | agent session id |
| `lastMessage` | String | yes | last assistant text |
| `pendingId` | String | yes | approval ticket (present ⇒ show Allow/Deny) |
| `askKind` | String | yes | `question \| approval` |
| `sessionTitle` / `sessionPhase` | String | yes | `sessionTitle` is declared but NEVER emitted (§6.2 trap) / `start \| end` |
| `toolUseId`,`subagentType`,`taskLabel`,`durationMs`,`tokens`,`toolUses`,`result` | — | yes | subagent card data |
| `verified`,`clientRevision` | — | yes | labels only — never reject on them |
| `recurringKind`,`recurringEnd`,`task`,`schedule` | — | yes | loop/schedule/cron card |

### 11.5 pty types

`PtyCreateOptions` [src: types.ts:81-140]: `{shell?, shellArgs?, cwd?, cols!, rows!, persistKey?,
ownerProjectId?, agentId?, agentModel?, accountId?, viewerId?, sshRemote?, requireRemote?}` —
phone sends `{cols, rows, persistKey, viewerId}`.

`PtyCreateResult` [src: types.ts:153-234]: `{sessionId!, fresh!, accountFallback?, screen?,
cursor? {x,y,visible}, coAttachMouse?, persistent?, closed? {by:Number|null},
unavailable? ('ssh'|'codex-account')}`. `sessionId:''` ⇔ refused (`closed`/`unavailable` set).

`TmuxStatus` [src: types.ts:715-728]: `{available:Bool, installCommand:String|null,
installLabel:String|null, platform:String|null}` — `platform:null` = read failed; do NOT
substitute the phone's platform.

`RecycledInfo` = `{ready:Bool}` [src: types.ts:237-241].

### 11.6 `ContextWindowUsage` [src: types.ts:2152-2163]

`{sessionId:String, usedTokens:Number, windowTokens:Number, usedPercent:Number(0-100),
model:String|null, updatedAt:Number(ms)}`. Per-agent token math differs server-side; the phone
just renders `usedPercent` + `model`.

### 11.7 Transcript & settings & speech

- `ChatTranscriptResult` = `{messages:[ChatMessage], found:Bool}` [src: types.ts:2227-2231].
  `ChatMessage` = `{role:'user'|'assistant', parts:[ChatPart]}`;
  `ChatPart` = `{kind:'text',text}` | `{kind:'thinking',text}` |
  `{kind:'tool',name,arg,result?,summary?{filePath?,added?,removed?}}`
  [src: types.ts:2199-2215].
- `TranscriptLine` = `{role:'user'|'assistant'|'tool', text}` [src: types.ts:2194-2197].
- `Settings` fields a phone MAY read: `claudePermissionMode` (default `'auto'`), `defaultShell`,
  `tmuxScrollback` (default 50000), and `claudeAccounts`
  (`[{id, label, email?, host?, pending?, createdAt}]`) — the last to enumerate the usage
  dashboard's per-account rows (§5.6) [src: types.ts:1079-1089]. Everything else is desktop render
  config — ignore, never write back [src: types.ts:1111-1495].
- `SpeechModelInfo` = `{id, file, approxMB, pro, downloaded, sizeMB?}`
  [src: types.ts:1537-1541].

### 11.8 Presence (v1) [src: src/shared/presence.ts:11-115]

`PeerState` = `{clientId:Number, name, color, cursor:{x,y}|null, focus:String|null,
chat:String|null, typing:{nodeId,at}|null, projectId:String|null, dino:…|null,
kind:'browser'|'phone'|'desktop'}`. `PeerDiff` = `{op:'join',peer}` |
`{op:'update',clientId,patch}` | `{op:'leave',clientId}`. Caps: name 32, chat 200, ref 128.
v0 may ignore presence entirely (but MUST tolerate the unsolicited `presence:sync` push, §4.9).
Side effect of ignoring it: every authenticated WS joins the presence hub as an anonymous
`browser` peer, shown as "Someone" on desktop/browser facepiles while the phone is connected
[src: src/server/ws.ts:182]. The phone SHOULD send one `presence:hello` cast with the device
name on connect even if it consumes nothing (arg shape unpinned — §12 item 6).

### 11.9 `CanvasMutation` [src: types.ts:519-531]

`{op:'upsert', node:CanvasNodeState, src?, seq?}` | `{op:'remove', id:String, src?, seq?}` —
`seq` is server-authoritative; never trust a client-set value.


### 11.10 Usage types [src: src/shared/types.ts:1921-1998,2082-2115]

- `ClaudeUsage` = `{limits:[UsageLimit], session:ClaudeUsageWindow|null,
  weekly:ClaudeUsageWindow|null, email:String|null, updatedAt:Number(ms),
  status:'unavailable'|'fetching'|'ok'|'error'}`. Prefer `limits[]`; `session`/`weekly` are
  back-compat conveniences [src: types.ts:2082-2099].
- `UsageLimit` = `{kind:String, group:String|null, usedPercent:Number(0-100, USED),
  severity:String|null, resetsAt:Number(ms)|null, windowMinutes:Number|null, scopeLabel:String|null,
  isActive:Bool}`. `kind` is `'session'|'weekly_all'|'weekly_scoped'|`future; `group` coarsens it to
  `'session'|'weekly'`; `scopeLabel` carries the model name of a scoped cap (`'Fable'`), so a new
  model needs no new field [src: types.ts:1937-1962].
- `ClaudeUsageWindow` = `{leftPercent:Number(0-100, LEFT), resetsAt:Number(ms)|null}` — already
  inverted to "left" for the bar [src: types.ts:1921-1926].
- `ProviderUsage` = `{provider:String, limits:[UsageLimit], account:String|null, accountId?:String,
  updatedAt:Number, status:(as ClaudeUsage)}`. `accountId` present ⇒ an account-scoped row (codex);
  rows keyed by it never merge into another account's [src: types.ts:1968-1987].
- `RemoteAccountUsage` = `{hostKey:String, accountId:String|null, label:String, usage:ClaudeUsage}` —
  `[]`-only on the Server Edition [src: types.ts:2107-2115].
---

## 12. Open questions / unverified items

Items the source extraction flagged as undetermined or unexercised. None of these are papered
over elsewhere in this spec; each needs a decision or an on-device measurement before/while
building v0.

1. **iOS auto-pong under backgrounding.** The server assumes the client stack answers protocol
   PING within its 30 s heartbeat window [src: src/server/ws.ts:169-186]. Whether
   `URLSessionWebSocketTask` does so in every app state (suspended, background grace) is
   unverified — a suspended app that misses one round is reaped in 30–60 s. Must be measured
   on-device; likely conclusion: expect the socket to die in background and reconnect on
   foreground (the app design already assumes this). (flagged during transport extraction)
2. **Native `URLSession` login round-trip.** The server side (form field `password`, cookie
   `nt_session`, 303-not-401 semantics) is verified from source; an actual iOS
   redirect-disabled POST + Set-Cookie capture has not been exercised. (flagged during method-catalog extraction)
3. **Speech Pro-model gating at runtime.** This branch ungates Pro features, but the gating
   lives in `src/core/speech` behind `isPremium()`; verify against a running self-host server
   that base/small/large-v3-turbo models are actually servable. (flagged during events extraction)
4. **`undef` codec edge cases.** The encode/decode of `RpcArgs` was read at interface level, not
   fully traced (flagged during session-semantics extraction). The client implementation MUST be tested against a live
   server for: park signal (`null,null` un-listed), omitted trailing `viewerId`, and omitted
   `enter` on `send-text`.
5. **Declaring `kind:'phone'` in presence.** The hub joins every WS connection as kind
   `'browser'` [src: src/server/ws.ts:180-182]; `PeerState.kind` includes `'phone'` but the
   mechanism by which a client changes its kind (a `presence:hello` field? server-inferred?) was
   not pinned. v0 ignores presence; resolve before v1.
6. **`presence:hello` request/response exact arg shape** (identity fields, return
   `{clientId, peers}`) was noted but not fully extracted (flagged during events extraction). v1 item.
7. **`pty:exit` payload shape.** One extractor recorded `args=[exitCode:Number]`
   [src: types.ts:833], another only "exit info". Verify the exact payload against a live
   server before rendering exit codes.
8. **`workspace:migrated` payload** is described only as "migration note"; exact shape
   unpinned. v0 can ignore the event's payload safely.
9. **Self-signed certificate support.** Deliberately out of v0 (§2.1/§10). If real demand
   exists (LAN-only servers without Tailscale), design a per-server certificate-fingerprint
   pinning flow — never a blanket skip-validation switch.
10. **Protocol versioning.** There is no version negotiation on the WS surface; this spec is
    pinned to branch `feat/ungated-selfhost` (58e5ea13), **plus the two node-registration channels
    added to `WorkspaceStore.registerIpc` after it** (§5.2, §7.11). Behavior against older/newer
    servers is undefined; the client SHOULD treat `E_NO_HANDLER` on a v0-required method as "server
    too old/new" and surface it. Concretely for spawning: `E_NO_HANDLER` on
    `workspace:register-node` means the server predates the feature — the session the client just
    started is running and MUST be reported as "started, not saved to the canvas", never retried and
    never worked around with `workspace:save`.
11. **Stat-tile definitions** ("Active sessions") are this spec's definition (§9.1), derived from
    the UX brief, not from server semantics — there is no server-side "active session count" API.
    Confirm the product definition matches the official app's intent.
12. **APNs v2 architecture** (§9.6): whether the vendor operates a push relay for self-hosters
    or ships a self-host push sidecar is an open product decision; nothing in v0 depends on it.

---

*End of specification.*
