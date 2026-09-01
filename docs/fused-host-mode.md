# Fused host mode + QR device pairing — desktop spec

Status: design, not yet implemented. Host names, tailnet and machine names in the examples below are
placeholders (`my-mac.tailnet-name.ts.net`), not the measuring machine's. Written against `~/git/termscape` at
`34aeef26` (branch `feat/ungated-selfhost`) and `~/git/nodeterm-mobile`.
Every code claim below was read in the tree; the Tailscale claims were re-run on this Mac
on 2026-09-01 and the captured output is quoted inline. Where the four survey passes
disagreed, or left something genuinely undecided, this document says so instead of picking
a side quietly — see §11.

---

## 0. What this changes, in one paragraph

Today the iOS app reaches this Mac's tmux sessions through a **second Electron-free process**
(`node out/server/main.cjs`, supervised by `~/Library/LaunchAgents/com.siimvene.nodeterm-server.plist`,
published on the tailnet by `tailscale serve`). That process boots its *own* `CorePlatform`, its own
`PtyManager`, its own `SettingsStore`, its own hook server, its own session reaper and its own data
dir (`~/.nodeterm-server`). Two cores, one tmux server. This spec (A) moves the Server Edition's
**http + ws listener** into the Electron main process so it serves the desktop's already-running
core, and (B) replaces "type a URL and a password" on the phone with a QR that carries a
**one-time enrollment code** — never a password — which the phone exchanges for a **per-device
token** it stores in the same Keychain slot the session cookie occupies today.

The listener layer is the only reusable part. §2 explains why anything above it is a hard boot
crash, not a preference.

---

## 1. Scope

### In scope
- Extracting the listen half of `startServer` so both shells share it (`src/server/attach.ts`).
- A fused host module in `src/main/` with the same `{setEnabled, syncFromSettings, stop}` shape
  the standing relay host already uses.
- Data-dir / hook-server / reaper / settings collision decisions, and the migration off
  `~/.nodeterm-server`.
- A one-time enrollment-code store, a public `POST /pair/claim` route, an authenticated
  `POST /pair/revoke-self` route, per-device session rows, and real revocation (including live
  sockets).
- Tailscale address discovery as a pure, fixture-tested parser.
- A Settings surface, and the Desktop / Server Edition / iOS consequences of each piece.

### Explicitly NOT in scope
- **The relay path is untouched and is not the mechanism here.** `src/main/remote/standing-host.ts`
  and `src/main/remote/pairing.ts` dial out to a broker; Siim rejects third-party rendezvous for
  this feature. They keep working, unchanged, behind `settings.phoneAccessEnabled`. The fused host
  is a sibling, not a replacement — and §3.4 records the double-push hazard when both are on.
- **The SSH QR pairing flow** (`src/main/pairing-service.ts`, `src/main/pairing-core.ts`,
  `~/.ssh/authorized_keys`, `~/.nodeterm/agent.json`) is untouched. It is a different transport
  with different revocation mechanics. §6.3 states how the two QR payloads are made mutually
  unreadable on purpose.
- **Headless-while-the-desktop-is-quit.** Fusing deletes it. See §3.7 — this is a real regression
  and the user must be told once, not discover it.
- **Renaming anything.** `package.json` `name` stays `node-terminal`, the tmux socket stays
  `node-terminal`, `.nodeterm/` files, `NODETERM_*` env, `nt_session` cookie name — all unchanged.
  Nothing in this spec touches the ~3,600 `nodeterm` occurrences.
- **A LAN / bare-IP fallback for the phone.** §5.2 argues this is blocked by iOS ATS, not by taste.
- **Windows.** The fused host is platform-neutral by construction (node `http` + `ws`), but nothing
  here is verified on Windows and `tailscale serve` is not part of that story.
- **Universal Links / an `apple-app-site-association` file.** iOS-side follow-up at most.
- **Adopting `registerCoreHandlers` on the desktop.** §2.1.

---

## 2. Part A — the fused host

### 2.1 The seam: what is reusable, and the hard blocker above it

`startServer` (`src/server/index.ts:153-772`) does three separable things.

**(a) Platform bootstrap — must not run fused.** Lines 156-163 `mkdirSync` the data dir,
construct `ServerPlatform` and call `initPlatform(platform)`. `initPlatform` is a module singleton
(`src/core/platform.ts:44-48`) and the desktop already called it at `src/main/index.ts:310`. A
second call silently re-points every core service at a platform whose `sendTo` cannot reach the
desktop window.

**(b) Core service construction + registration — must not run fused, and this is a crash, not a
degradation.** Lines 184-682 build `SettingsStore`, `PtyManager`, `WorkspaceStore`, the hook server,
the reaper, usage, speech, context-link, github, and register every core IPC channel. On the
desktop, `electronPlatform().handle` calls `ipcMain.handle` (`src/main/platform-electron.ts:86-89`),
and **a second `ipcMain.handle` on the same channel throws**. The repo already states this in
`src/main/claude-accounts.ts:12-13`. The desktop performs essentially all of the same registration
itself (`registerFsHandlers` at `src/main/index.ts:1517`, `gitService.registerIpc`,
`ptyManager.registerIpc`, `workspaceStore.registerIpc`, `registerClaudeCliIpc`,
`registerCodexIdentityIpc`, `IPC.commitGenerate`, `IPC.appUserDataDir`, …). Calling
`registerCoreHandlers` fused is a boot crash on the first duplicated channel.

Consequence for the open question the survey raised: **do not adopt `core/claude-accounts-service.ts`
on the desktop as part of this change.** The desktop keeps `src/main/claude-accounts.ts`; the fused
host simply never calls the core registrar. That follow-up (`src/main/claude-accounts.ts:11`) is
orthogonal and carries its own risk.

**(c) Listen — the whole reusable surface.** Lines 714-772:

```ts
const server = http.createServer(createHttpHandler({ auth, rendererDir, trustProxy, downloadTickets }))
const wsServer = attachWsServer(server, { platform, auth, onClientGone, trustProxy })
await listen(port, host)
// close(): terminate every ws client, close the WebSocketServer, close the http server
```

Everything it needs is already parameterised. `createHttpHandler` takes
`{auth, rendererDir, trustProxy, downloadTickets}` (`src/server/http.ts:44-57`) and nothing else.

### 2.2 Refactor shape

Three edits, two of them additive.

**NEW `src/server/attach.ts`** — `attachHttp(opts)`, lifted verbatim from `src/server/index.ts:714-772`:

```ts
export interface AttachHttpOpts {
  host: string
  port: number
  auth: Auth
  rendererDir: string
  wsHost: WsHost                       // see below
  trustProxy?: TrustProxyConfig
  downloadTickets?: DownloadTickets
  onClientGone?: (uiId: number) => void
  heartbeatMs?: number                 // tests only
}
export async function attachHttp(o: AttachHttpOpts): Promise<{ port: number; close(): Promise<void> }>
```

`close()` does **only** the three listener steps: `for (const c of wss.clients) c.terminate()`,
`await wss.close()`, `await server.close()`. It must not grow legs for `ptyManager.killAll`,
`speechService.shutdown` or `hookServer.stop` — the desktop already owns all three
(`src/main/index.ts:3741`, `:3748`, `:3726`) and duplicating `startServer`'s `close()` would
double-run them. The `terminate()` call is not optional and the reason is already written down at
`src/server/index.ts:763-765`: an upgraded WebSocket is not an ordinary HTTP connection, so
`server.close()` waits for it forever. `startServer` then calls `attachHttp` and keeps its extra
service legs in its own `close()`; that path must stay behaviour-identical.

**EDIT `src/server/ws.ts`** — one type widening. `WsServerOpts.platform` is declared
`ServerPlatform` (`ws.ts:57`) but the file uses exactly five members: `attach` (`:174`), `detach`
(via `teardown`, `:119`), `setSinkGoneHandler` (`:124`), `dispatch` (`:197`), `cast` (`:199`).
Replace the field's type with a structural interface:

```ts
export interface WsHost {
  attach(sink: UiSink): number
  detach(id: number): void
  setSinkGoneHandler(fn: (id: number) => void): void
  dispatch(clientId: number, req: RpcRequest): Promise<RpcOk | RpcErr>
  cast(clientId: number, method: string, args: unknown[]): void
}
```

`ServerPlatform` satisfies it unchanged. The import at `ws.ts:18` is already `import type`, so
nothing new is dragged in at runtime.

**One correction to the survey's shape.** `attachWsServer` calls
`platform.setSinkGoneHandler(teardown)` **unconditionally** at `ws.ts:124`, and on the desktop the
sink-gone slot is already occupied at module scope: `src/main/peer-registry.ts:34` sets it to
`unregisterPeerSink`, and `UiSinkRegistry` holds exactly one (`src/core/ui-sink-registry.ts:155-157`,
`this.onSinkGone = fn`). A naive fuse silently breaks relay-peer dead-sink teardown — ghost peers in
the facepile, leaked pty subscribers, and the frozen-shared-terminal failure
`peer-registry.ts:59-70` warns about at length. Therefore `setSinkGoneHandler` on the fused adapter
is **a deliberate no-op**, and the adapter's `detach` routes through `unregisterPeerSink`, which
already runs the correct three-step teardown (`presenceHub.leave` → `onPeerGone` →
`registry.unregister`). Write that as a comment at the no-op, because it reads like a bug.

**NEW `src/main/fused-host.ts`** — the adapter plus the lifecycle:

```ts
export function initFusedHost(deps: {
  getSettings: () => Settings
  auth: Auth
  rendererDir: string
  downloadTickets: DownloadTickets
  platform: ElectronPlatform            // the ONE live instance — see below
}): { setEnabled(v: boolean): void; syncFromSettings(): void; stop(): Promise<void> }
```

**`initFusedHost` takes no `onClientGone`, and it passes none to `attachHttp`.** `ws.ts`'s single
`teardown(uiId)` runs three steps in order — `presenceHub.leave(uiId)` → `onClientGone?.(uiId)` →
`platform.detach(uiId)` (`ws.ts:113-121`). On the fused adapter `detach` **is**
`unregisterPeerSink`, which itself runs `presenceHub.leave(id)` → `onPeerGone(id)` →
`registry.unregister(id)` (`peer-registry.ts:59-70`), and `onPeerGone` is already wired to
`ptyManager.dropClient` + `dropGitHubRelayClient` at `src/main/index.ts:422-428`. Passing an
`onClientGone` as well would run `presenceHub.leave` twice and `dropClient` twice per disconnect —
benign only for as long as both stay idempotent, which is not a property to lean on. The
peer-registry path already owns the teardown; the fused value is therefore **`onClientGone:
undefined`**, and the dep does not exist on the signature so nobody can pass one by reflex.
`attachHttp` keeps the optional parameter because `startServer` still supplies it.

The `WsHost` adapter, ~30 lines:

| member | fused implementation |
| --- | --- |
| `attach(sink)` | `const id = allocateRelayClientId(); registerPeerSink(id, sink); return id` (`src/core/presence/hub.ts:100`, `src/main/peer-registry.ts:42`) |
| `detach(id)` | `unregisterPeerSink(id)` — NOT `registry.unregister`, see above |
| `setSinkGoneHandler(fn)` | no-op; the module-scope handler at `peer-registry.ts:34` owns it |
| `dispatch(id, req)` | `deps.platform.dispatch(id, req)` — the boot singleton, **never** `electronPlatform()` |
| `cast(id, m, a)` | `deps.platform.cast(id, m, a)` |

**`electronPlatform()` is a factory, not an accessor, and calling it here is the whole feature dead
on arrival.** `src/main/platform-electron.ts:45` opens the function and `:58-59` allocate
`const handlers = new Map<string, Handler>()` / `const listeners = new Map<string, Set<Listener>>()`
**inside the body**; there is no module-level cache. So `electronPlatform().dispatch(id, req)`
answers from a freshly-constructed empty table and every RPC a fused phone or browser sends returns
`E_NO_HANDLER`; `cast` is silently dropped with no reply channel to notice it on. The one live
instance is the one created at boot — `src/main/index.ts:307-310`, which says exactly why it exists
("a relay peer's inbound RPC is answered from THIS instance's handler table") — and it is also the
memoized `platform()` singleton (`src/core/platform.ts:44-51`: a module-level `current`, set by
`initPlatform`). Either pass it in as a dep (the shape above, and the pattern the existing relay
already uses — `relay-host.ts:55` takes `platform: ElectronPlatform` and uses it at `:303`/`:321`)
or read it back through `platform()`. A dep is preferred because it is checkable at the call site;
`platform()` returns the `CorePlatform` type, which does not carry `dispatch`/`cast`.

Because `detach` and the module-scope sink-gone handler both funnel into `unregisterPeerSink`, and
that function is idempotent by construction (`presenceHub.leave` on an unknown id, a guarded
`onPeerGone`, `registry.unregister` of an absent id), the close/eviction race is already handled —
same property `ws.ts:111` claims for its own `teardown`.

The desktop needs no new backpressure/resync plumbing: `wirePeerRegistry` is already called once at
`src/main/index.ts:422-428` and wires `setFlowController`, `setResyncProvider` and `onPeerGone` to
the same three `PtyManager` methods `src/server/index.ts:256-262` wires.

**One edit inside the merge-hostile file that is unavoidable if browser Explorer downloads should
work fused.** `registerFsHandlers` at `src/main/index.ts:1517-1519` passes no `issueDownloadTicket`
(the desktop uses a native save dialog), so a browser tab or a phone hitting the Explorer download
path answers `null`. Threading a `DownloadTickets` through means constructing one in
`src/main/index.ts` and passing it both to `registerFsHandlers` and to `initFusedHost`. This is
optional for v1 — decide it explicitly rather than discovering a dead button.

**Boundary check.** `src/main` may import `src/server` today: `src/server/no-electron.test.ts` and
`src/core/no-electron.test.ts` scan only *inside* their own directories for `electron` imports and
`../main/` reach-backs. Nothing scans `src/main`. The five reusable server files are node-only:
`http.ts`, `auth.ts`, `proxy-trust.ts`, `download.ts`, `ws.ts`. `ws` is a runtime dependency
(`package.json:160`, `"ws": "^8.21.3"`), is externalized for the main bundle by
`externalizeDepsPlugin`, and is **already imported in Electron main today** —
`src/main/codex-relay-daemon.ts:61` imports `{ WebSocket, WebSocketServer } from 'ws'`. A
`WebSocketServer` inside main is proven, shipped capability in this app.

**`rendererDir`.** `join(__dirname, '../renderer')` — the same directory `src/main/index.ts:1116`
hands to `win.loadFile`. The CSP marker `serveStatic` rewrites (`default-src 'self';`,
`src/server/http.ts:336-346`) IS present verbatim in `src/renderer/index.html:8`, so the
`connect-src 'self' ws: wss:` rewrite applies and a browser will not block the socket. **That is
only the CSP half of serving the UI over the tailnet name; the Origin/Host half is unverified and is
the one that actually gates the socket** — `ws.ts:89-100` compares the Origin's host against
`req.headers['host']`, the Host the BACKEND receives, and nobody has captured what `tailscale serve`
presents there. See §7 Phase 2's DoD and §11 item 13; the phone path is unaffected either way,
because it sends no Origin. **Unverified
and owed a device check:** whether `fs.promises.stat` / `readFile` inside `app.asar` behave for
`serveStatic` in a packaged build. Run `npm run dist`, then from the packaged main process read
`join(__dirname,'../renderer/index.html')`. If asar promises reads misbehave, `rendererDir` must
point at an `asarUnpack`'d copy. Note that the phone does not need `rendererDir` at all (it speaks
only `/auth/*`, `/pair/claim` and `/ws`) — this only gates the *browser* Server Edition UI served by
the fused host.

### 2.3 Lifecycle

Copy the standing-host template exactly. `src/main/index.ts:3406-3409` is three lines:

```ts
const standingHost = initStandingHost(win, ptyManager, () => settingsStore.get(), listProjectsOutput, hostBridge)
ipcMain.on(IPC.remoteStandingHostSet, (_e, enabled: boolean) => standingHost.setEnabled(!!enabled))
standingHost.syncFromSettings()
```

and the module (`src/main/remote/standing-host.ts:394, :426-436`) is a private `reconcile()` behind
`{setEnabled, syncFromSettings, stop}`, with `syncFromSettings` reading
`!!getSettings().phoneAccessEnabled`. Mirror it so the fused host's footprint in `index.ts` is three
lines plus one quit leg. `index.ts` is 3,750 lines and the most merge-hostile file in the repo;
every line kept out of it is merge cost not paid.

- **Setting:** a new boolean `fusedHostEnabled`, default **false**, beside `phoneAccessEnabled`
  (`src/shared/types.ts:1419`, default `:1583`). Default-off matters: this opens a tailnet-reachable
  listener in front of the user's live terminals, and an upgrade must not do that silently.
- **Boot position:** inside `app.whenReady()`, **late** — near `:3406`, after every core
  registration. This is not cosmetic. `startServer` gets the ordering for free by calling `listen()`
  last; a fused listener placed early accepts a connection before its handlers exist and every RPC
  answers `E_NO_HANDLER` (`src/main/platform-electron.ts:113-117`).
- **Teardown:** one leg on the SECOND `before-quit` pass — the `quitFlushed` branch,
  `src/main/index.ts:3710-3736` — beside `hookServer.stop()` at `:3726`. Second pass, not first,
  because the flush window at `:3741` is still writing and a phone attached during it should keep
  receiving until the masters drop.
- **Toggle-off with phones attached:** `stop()` runs the same `attachHttp().close()`. Each
  connection's teardown still runs `presenceHub.leave` + `PtyManager.dropClient`, because the
  adapter's `detach` is `unregisterPeerSink`.

### 2.4 Collision decisions

Both data dirs exist on disk right now, and the launchd job was running when the surveys were taken
(PID 84771). Fusing removes most of the duplication by construction — one process, one
`platform()` singleton, one set of module singletons — and those need no decision:

| Duplicate today | After fusing |
| --- | --- |
| data dir (`~/.nodeterm-server` vs `~/Library/Application Support/node-terminal`) | one: `app.getPath('userData')` |
| two `SettingsStore` / `settings.json` (path is `platform().userDataDir`, `src/core/settings-store.ts:91`) | one |
| two hook servers — both shells start the module singleton (`src/main/index.ts:1671`, `src/server/index.ts:549`), two `hook-endpoint.env`, two `node-tokens` dirs | one |
| two session reapers over the SAME socket list `[TMUX_SOCKET, RMT_TMUX_SOCKET]` (`src/core/session-budget.ts:482`), racing on one tmux server (`src/main/index.ts:2470`, `src/server/index.ts:611`) | one |
| two `tmux.conf`, both `source-file`d into the shared tmux server (`src/core/pty-manager.ts:1607`) — last writer wins | one |
| two `workspace.json` — which is exactly why the phone sees a different canvas set than the desktop | one |
| two `agent-status.json` mirrors (`src/core/agent-status-mirror.ts:1174`) | one |
| **two node-identity secrets** — the desktop seals `node-auth-key.json` via `safeStorage`, the server writes raw `node-auth-key.bin` (`src/core/agents/node-auth-secret.ts:14-16,40-41`), so tokens minted by one read as `legacy` to the other | one, and fusing GAINS sealing (`sealSecret`/`unsealSecret` exist only on the Electron platform, `src/main/platform-electron.ts:199-200`) |
| `resourcesPath` absent server-side ⇒ `bundledTmuxPath` unreachable | fusing GAINS it (`platform-electron.ts:81-83`) |

Four things need a **decision**, not just a merge:

1. **Auth store location.** `userData` has no `auth.json` today; `~/.nodeterm-server` has
   `auth.json` + `sessions.json` holding the phone's live 30-day cookie. The fused `Auth` is
   `new Auth(app.getPath('userData'))`, which invalidates that cookie. **Accept it** — QR pairing
   re-enrols the phone anyway, and the enrolment is the point of the change. Do not import the old
   `sessions.json`: it contains one raw long-lived token whose provenance nobody can now establish.

2. **Abandoned server state.** `~/.nodeterm-server/workspace.json` (its own canvas set) and its
   `terminal-scrollback/` become orphans. **Discard.** The phone's canvas list changes as a result,
   which will read as data loss unless the release note says so first. Importing is possible
   (`WorkspaceStore` reads the v3 index) but merges two project sets with colliding node ids =
   colliding tmux session names, which is worse than a one-time explanation.

3. **Stale endpoint files, and this one bites silently.** `$HOME/.nodeterm-server/hook-endpoint.env`
   is **candidate #1** in the generated sh endpoint-failover walk — ahead of both desktop `userData`
   paths (`src/core/agents/hook-endpoint-failover-sh.ts`, the `nt_candidates()` list, ordering
   rationale in the comment block above it), and `$HOME/.nodeterm-server/node-tokens` is likewise a
   candidate in `nt_read_node_token` (`src/core/agents/node-token-sh.ts`). Killing the launchd job
   without deleting those leaves every hook failover burning a dead connect — up to
   `--max-time 1.5 s` each, `nt_fallback_max=3` — before it reaches the live desktop endpoint.
   `hookServer.stop()` unlinks the endpoint file, but only on a **graceful** stop. **Decision:** the
   migration step (§2.7) removes `~/.nodeterm-server` entirely, and the fused host warns at boot if
   it still exists.

4. **Capability policy for a fused client.** See §2.6.

### 2.5 Binding, TLS, and what "delete the second moving part" actually deletes

**Decision: bind `127.0.0.1` only, keep `tailscale serve`.** The fused host never binds a
non-loopback address, so `resolveConfig`'s refusal (`src/server/config.ts:102-109`) is not bypassed
— it is simply not in the path, because the fused host builds its own config and its own rule is
"loopback, always".

The deciding constraint is iOS, not preference. `src/main/pairing-service.ts:537-539` records it as
measured fact from this project's own history: *"The phone reads /pair responses off a raw TCP
socket (ATS blocks URLSession for bare-IP HTTP)."* The iOS RPC transport is
`URLSessionWebSocketTask` (`Sources/NodetermKit/Rpc/WebSocketFrameTransport.swift:74`), ATS-governed
the same way, with no raw-socket escape hatch short of rewriting the transport. There are no ATS
exception keys in the iOS project (`project.yml` carries only the two `INFOPLIST_KEY_*` mic/speech
strings). And `AddServerView.swift:105-111` independently rejects a plain-`http` base unless the
host is literally `localhost` or `127.0.0.1`.

Measured on this Mac, 2026-09-01, `tailscale serve status --json`:

```json
{"TCP":{"443":{"HTTPS":true}},
 "Web":{"my-mac.tailnet-name.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8443"}}}}}
```

and the survey's header probe (a throwaway listener on a disjoint `--https=8444` entry, removed
afterwards, the live `:443` handler untouched) showed `serve` injecting
`x-forwarded-proto: https`, `x-forwarded-for: <caller's tailnet IP>`,
`x-forwarded-host`, `tailscale-user-login`, `tailscale-user-name` — **overwriting** any client-set
value of those — with the TCP peer being `127.0.0.1`. Two consequences that cost zero code:

- `cookieAttributes` (`src/server/http.ts:76-80`) adds `Secure` when
  `x-forwarded-proto === 'https'`, and it consults `trustProxy` not at all. So the browser session
  cookie is `Secure` behind serve with no configuration.
- `DEFAULT_TRUSTED_NETS_SPEC = '127.0.0.0/8, ::1/128'` (`src/server/proxy-trust.ts:25`) already
  matches the loopback peer.

**But the fused host must pass `trustProxy: undefined`, unconditionally, and must not expose the
knob.** The same probe found that `serve` sanitises only *its own* header families: a forged
`Cf-Access-Authenticated-User-Email` arrived verbatim. `proxyAuthAllowed` does not validate header
*content* (`src/server/proxy-trust.ts:147-155`), so configuring the fused host with any
non-Tailscale header name while behind `serve` is a complete unauthenticated bypass for every
tailnet peer. With `trustProxy` undefined, `proxyAuthAllowed` is never called and that whole class
is structurally unreachable. Note `docs/SERVER.md:274-276` currently claims Tailscale strips such
headers; that is true only of the families `serve` owns, and the doc should be narrowed in this
change.

**Port: fixed at 8443**, matching the existing `serve` mapping so the tailnet publication keeps
working with no reconfiguration. On `EADDRINUSE`, fail loudly and name the likely cause ("another
nodeterm-server is listening on 8443 — the launchd job is probably still loaded"), never fall back
to an ephemeral port: an ephemeral port silently orphans the `serve` mapping and the QR would
advertise a URL that 502s.

**Honest accounting of what is deleted.** The launchd job goes. The second core, second data dir,
second password store, second hook endpoint, second reaper, second workspace index all go. What
does **not** go is `tailscale serve` — but that is a declarative one-line mapping held by a daemon
the user already runs for the tailnet itself, not a supervised copy of this application. The survey
pass on address/security and the pass on the host seam framed this differently ("fusing does NOT
remove `tailscale serve`"); both statements are true and the disagreement is only about what counts
as a moving part. Recorded, not resolved: if Siim's definition includes the serve mapping, the only
way to drop it is a direct tailnet bind, which iOS ATS refuses. See §11.

Should the fused host *configure* serve itself (shelling out
`tailscale serve --bg --https=443 http://127.0.0.1:8443`)? **No, for v1.** It mutates machine-wide
state the user may share with other services and can clobber an existing `:443` handler. Detect and
instruct instead (§5).

### 2.6 Capability policy for a fused client

Two behaviour changes fall out of routing a remote client through `electronPlatform` instead of
`ServerPlatform`, and both need a stated policy rather than an accident.

**Host-only channels.** `electronPlatform.dispatch` and `.cast` refuse `HOST_ONLY_CHANNELS`
(`src/main/platform-electron.ts:106-111, :134-141` → `src/shared/host-control.ts:32-46`:
`githubControl:*`, `project-setup:run|cancel|consent-submit|request-trust`). `ServerPlatform.dispatch`
has no such gate, so a Server Edition browser tab may call all of them today. A fused phone is
therefore **more** restricted than the phone is today via the standalone server.

**Decision: keep the refusal.** The reasoning in `host-control.ts:11-27` is about the host's own
control plane, and a phone on a tailnet is exactly the guest that reasoning describes — most
sharply the `run` + `consent-submit` self-approval loop. The cost is that the phone loses GitHub
token management and project-setup control, which it plausibly never used. Surface it: when a fused
client is refused, the existing throttled warn at `platform-electron.ts:138` is the only signal —
add the fused case to the Settings copy so it is documented rather than mysterious.

**Also add `pair:mint` / `pair:list` / `pair:revoke` to `HOST_ONLY_CHANNELS`** — a *backstop*, not
the primary gate. §3.4 registers them on raw `ipcMain`, which already makes them unreachable from
`dispatch`; the list entry is what keeps them unreachable if a future change moves them onto the
platform seam without re-reading §3.4. Free on the Server Edition: only `platform-electron`
consults `isHostOnlyChannel` (`:106`, `:134`) — `ServerPlatform.dispatch` has no such gate — so
adding them does not close the Server Edition's own pairing panel (§9.2 gates that a different way,
because there every client is remote).

**`openExternal`.** `ServerPlatform.openExternal` rejects outright
(`src/server/platform-server.ts:95-97`); `electronPlatform.openExternal` is
`shell.openExternal(url)` (`platform-electron.ts:193`). Fusing does change behaviour here — but not
where an earlier draft of this spec said it did, and that draft's instruction ("add the channel to
`HOST_ONLY_CHANNELS`") was not implementable, because **`openExternal` is a `CorePlatform` METHOD
(`src/core/platform.ts:41`), not an IPC channel.** There is no channel to list. The two paths that
actually exist:

- **The renderer-facing `IPC.shellOpenExternal` is already safe and is not the exposure.** It is
  registered with **raw** `ipcMain.on` behind `isSafeExternalUrl` (`src/main/index.ts:1501-1503`),
  and a raw registration is invisible to `dispatch` (`platform-electron.ts:46-49`). A fused client
  can never reach it. Nothing is "silently upgraded" there.
- **The one genuinely peer-reachable path is `IPC.licenseUpgrade`.** Grepping every `openExternal`
  use shows exactly one core caller: `src/core/license.ts:325`, inside the handler registered at
  `:320` through `platform().handle`. That channel **is** peer-dispatchable and is **not** in
  `HOST_ONLY_CHANNELS`. Today `ServerPlatform.openExternal` rejects it (`platform-server.ts:95-96`);
  fused, a remote client calling `licenseUpgrade` opens a Stripe checkout page on the host's
  desktop.

**Decision: gate `IPC.licenseUpgrade`, not a nonexistent openExternal channel.** Add it to
`HOST_ONLY_CHANNELS` — it is precisely "acts on the USER's own machine", the category
`platform-electron.ts:50-52` names. The local renderer does not go through `dispatch`, so the
desktop Settings upgrade button is unaffected; the Server Edition keeps its existing behaviour
(the `openExternal` inside the handler rejects there, as it does today). If a future product
decision wants a remote client to be able to start a purchase, that is a deliberate re-open, not
an accident of fusing.

### 2.7 Migration off the launchd job

A scripted, reversible sequence, run once by the user (documented in `docs/`; not automated by the
app — unloading another process's launch agent is not something a GUI app should do silently):

```
launchctl bootout gui/$(id -u)/com.siimvene.nodeterm-server   # ← runs at the TOP of Phase 2, not here
rm -f  ~/Library/LaunchAgents/com.siimvene.nodeterm-server.plist
# and only after confirming nothing else reads it:
rm -rf ~/.nodeterm-server          # §2.4 item 3 — the stale hook endpoint + node-tokens
tailscale serve status             # confirm :443 → http://127.0.0.1:8443 still maps
tailscale funnel status            # confirm it still says "(tailnet only)" — §4, §6
```

**The first line runs early, and everything below it runs at Phase 6.** The `bootout` has to happen
before the fused host can bind 8443 at all (§7 Phase 2 explains why), and keeping it separate from
the deletions is what preserves the rollback: while the plist and `~/.nodeterm-server` are still on
disk, `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.siimvene.nodeterm-server.plist`
puts the old world back. Once the `rm`s run, it is gone.

The second launchd job the survey found — `com.siimvene.nodeterm-server-sync.plist`, dated Aug 25 —
was not in the brief and nobody read it. **Do not delete it blind.** Read it first; it may be
unrelated.

Boot-time guard in `initFusedHost`: if `~/.nodeterm-server/hook-endpoint.env` exists, log once and
raise a Settings warning naming the failover cost from §2.4. Cheap, and it catches the half-done
migration that is otherwise invisible until an agent's hook POSTs get slow.

---

## 3. Part B — pairing

### 3.1 The credential model today, measured

This is the single most useful fact in the design, and it collapses most of the iOS work:

- The phone's one credential is an opaque string in the Keychain under service
  `ee.vene.termscape.cookie`, account = profile id
  (`Sources/NodetermKit/Keychain/KeychainService.swift:20-42`).
- It is replayed as a **manual header** `Cookie: nt_session=<value>` on HTTP
  (`Auth/AuthClient.swift:106`) and on the WS upgrade
  (`Rpc/WebSocketFrameTransport.swift:70`), out of an ephemeral `URLSession` with the system cookie
  jar disabled (`:63-66`). It deliberately sends **no** Origin header (`:71`).
- Server-side that value is looked up in a flat map keyed by the raw token
  (`src/server/auth.ts:134-155`) at exactly two places: the HTTP session gate
  (`src/server/http.ts:487-492`) and the WS upgrade (`src/server/ws.ts:85-88`).

**So a per-device token needs no new transport, no new header, no new Keychain slot, and no change
to `WebSocketFrameTransport`.** It is architecturally a bearer token wearing a cookie's name. What
changes is only how the value is *minted* and *revoked*. Design to that.

### 3.2 Enrollment codes — a sibling of `DownloadTickets`, not `Auth.setupToken`

`Auth.setupToken()` cannot be reused, for four reasons all visible in `src/server/auth.ts`:

1. It is **singular** — one `setupTokenValue` per process (`:33, :92-97`); a second call returns the
   first value.
2. It has **no expiry**; it lives for the process lifetime.
3. Its call sites are gated on `!auth.isConfigured()` (`http.ts:401-405, :430-433`) — it is a
   bootstrap credential for a server with *no* password.
4. Its **scope is password-setting** (`http.ts:443-450`). Conflating "mint a device token" with
   "set the password" means one bug in pairing is a full takeover.

Build `src/core/enrollment-codes.ts` as a near-copy of `src/core/download-tickets.ts` — which is
already in `src/core`, already shell-agnostic, already has an injectable `now` for timer-free tests:

```ts
export const ENROLLMENT_TTL_MS = 120_000
const MAX_CODES = 16

export class EnrollmentCodes {
  issue(meta: { label?: string }): string        // randomBytes(24).toString('base64url'), 192 bits
  redeem(code: string): EnrollmentEntry | null   // delete FIRST, then check expiry
  revokeAll(): void                              // called when the QR panel closes
}
```

The **delete-before-expiry-check** ordering (`download-tickets.ts:60-65`) is what makes a captured
code unreplayable even in a race; copy it exactly. Keep the full 24 bytes — the code is machine-read,
so there is no argument for a short human-typeable one, and the route is reachable pre-auth.

In-memory only, not persisted, and that answers a failure branch for free: server restarted
mid-flow ⇒ code gone ⇒ `403 invalid_code` ⇒ the desktop shows a fresh QR. Nothing to reconcile.
`revokeAll()` on panel unmount mirrors how `usePhonePairing` stops the SSH listener on unmount
(`src/renderer/components/settings/usePhonePairing.ts:10-14) — a code that outlives the QR on screen
is a credential nobody is watching.

**TTL is contested.** 120 s is recommended here (unlock the phone, open the app, scan). The SSH flow
uses `PAIR_TIMEOUT_MS = 10 * 60 * 1000` (`src/main/pairing-service.ts:194`), and that ten minutes
was *deliberately widened* after a field report of users scanning expired QRs. Those are the same
ergonomics with opposite conclusions. Recommendation: 120 s **with a visible countdown and automatic
re-mint on expiry**, which is what makes the short window survivable. If the countdown is not built,
use 300 s.

### 3.3 QR payload

A **new bare-JSON payload**, one line, encoded directly into the QR:

```json
{"v":1,"kind":"host","url":"https://my-mac.tailnet-name.ts.net","code":"<32-char base64url>","name":"My Mac","exp":1756732800}
```

- `url` is the reachable base URL in exactly the shape `ServerProfile.baseURL` already takes
  (`Sources/NodetermKit/Models/ServerProfile.swift:12`; `webSocketURL` derives `wss` + `/ws` at
  `:78-88`), so the phone constructs the profile with no new parsing rules.
- `code` is the one-time enrollment code, **never a password**.
- `exp` is advisory — it lets the scanner say "this QR expired, press Refresh on the Mac" without a
  round trip. The server remains the authority.
- `name` seeds `ServerProfile.name` so the user never types one. **Trimmed and clamped to 64 chars
  at mint time**, matching what the client clamps to (iOS spec §1.1) so the two cannot disagree
  about how long a name may be.
- `code` is 32 chars of base64url (24 random bytes, §3.2), which is inside the client's stated
  `1–256` chars of `[A-Za-z0-9_-]`.

**Not `nodeterm://pair?code=…`.** That codec (`src/main/remote/pairing.ts:17-25`) is the **relay**
offer, and its validator requires `relayEndpoint` + `pairingToken` + `hostPublicKeyB64` and refuses
any endpoint that is not `wss:` or loopback `ws:` (`:72-99`). Reusing the scheme means either
shipping a payload its own decoder rejects, or loosening `isAllowedRelayEndpoint` — the function
that stops an attacker-crafted offer pointing a client at plaintext. Do not touch it.

**Not the SSH pairing JSON.** `buildPairingPayload` (`src/main/pairing-core.ts:47-60`) emits
`{v,host,port,user,token,pairPort,nodeterm:true,name[,hostKey][,relay]}`, which means "append my key
to authorized_keys and reach me on port 22". Overloading one QR shape with two incompatible meanings
is how a scan fails confusingly. **The mutual rejection is free and should be preserved
deliberately:** the host payload omits `nodeterm:true`, `pairPort`, `user` and `host`, so the SSH
scanner cannot mistake it; the SSH payload has no `kind:"host"` and no `url`, so the Termscape
scanner cannot mistake that. Say so in a comment at the builder — a future agent will want to
"unify" them.

**Not a plain URL QR** (`https://host/pair#c=…`): iOS Camera would offer to open it in Safari, which
lands on the login page (`http.ts:418-425`) — a dead end for a user with no password. A bare-JSON QR
is only actionable inside the app's own scanner, which is the behaviour we want. The SSH flow chose
bare JSON for the same reason.

Placement: a pure `buildHostPairPayload()` + `parseHostPairPayload()` in `src/shared/` (both shells
mint it; `src/core` may not import `src/main`, where the SSH codec lives), unit-tested the way
`pairing-core.ts` keeps its wire contract pure.

### 3.4 `POST /pair/claim`

One public route, registered in `src/server/http.ts` between the
`// ---- Public auth routes ----` comment at `:399` and the session gate at `:485-492`. It must sit
above the gate: the phone has no credential yet, by definition.

Request: `application/x-www-form-urlencoded`, read with the existing `readForm`
(`http.ts:110-135`, already capped at `MAX_BODY_BYTES` = 10 KB at `:17`). No new body parser, no new
DoS surface; and on iOS `AuthClient.formEncode` already exists and already percent-encodes
correctly, so the client method is a copy of the existing `post()` helper
(`AuthClient.swift:95-111`) with a different path.

| field | required | notes |
| --- | --- | --- |
| `code` | yes | the QR code |
| `deviceName` | no | trimmed host-side, blank ⇒ `'iPhone'`, then **truncated to 64 chars — never rejected** (see below) |
| `platform` | no | `ios` |
| `deviceId` | no | the phone's stable id, when it already has one. See the minting rule below. |

**`deviceId` — one rule, and it is normative for both specs.** The client sends its stored
`deviceId` if it has one and **omits the field entirely** if it does not (a first-ever pair). The
server keys the device row by the supplied id **when present and valid**, and **mints its own**
(`crypto.randomUUID()`) when absent. Valid means `^[A-Za-z0-9_-]{8,64}$`, re-validated at the
handler; anything else is `400 bad_request`, never a silent substitution — the id is a map key and
a hand-crafted one must not traverse or collide by construction. The 200 body **always** carries
the effective id, and **the client adopts whatever the body says**, overwriting its own. That is
what makes "re-pairing upserts one row instead of accreting one per scan" true end to end: the
client cannot hold an id the server does not key by, and the first pair has a defined answer. Row
replacement is `upsertDevice`'s rule (`pairing-core.ts:171-174`: filter out the same `id`, then
append), and the old row's token is deleted and its live sockets closed by §3.6's machinery — a
re-pair revokes the previous token for that device.

**`deviceName` is untrusted display text.** It is user-supplied on the phone and lands in a desktop
UI. `normalizeDeviceName` (`pairing-core.ts:153-159`) trims and defaults to `'iPhone'` but has
**no length clamp** today; when it moves to `src/shared/` (§3.5) it gains one: truncate to 64
UTF-16 code units. Truncate rather than reject, because a rejected pair at the phone is
unrecoverable from the phone. Render it escaped; never as markup.

Response 200: `{"ok":true,"deviceId":"…","token":"<64 hex>","name":"My Mac"}` with
`Content-Type: application/json`. Also emit `Set-Cookie` via the existing `setSessionCookie`
(`http.ts:82-84`) so a browser doing the same flow ends up logged in — harmless for the phone, which
reads the JSON body.

| status | body | when |
| --- | --- | --- |
| 400 | `{"error":"bad_request"}` | unparseable / oversized body, no `code`, or a `deviceId` that fails `^[A-Za-z0-9_-]{8,64}$` |
| 403 | `{"error":"invalid_code"}` | unknown **or** expired **or** already consumed — **one indistinguishable answer**, the same rule and reasoning as `src/server/download.ts:57-59` |
| 409 | `{"error":"not_configured"}` | no password set — see §3.8 |
| 429 | `{"error":"too_many_attempts"}` | the **pairing** limiter tripped (§3.7) |
| 405 | — | wrong method |

**No `GET /pair/hello` preflight.** It would be an unauthenticated fingerprint endpoint and buys
nothing: the phone's trust in `url` comes from the QR having been rendered on the user's own screen,
not from anything the far end says.

#### `POST /pair/revoke-self` — the one pairing verb a device may reach

One more route, registered **below** the session gate (`http.ts:485-492`) so it is authenticated by
construction: the presenting `nt_session` value *is* the credential being revoked, and no other
authorization is possible or needed.

- Body: empty. Method: POST; anything else is `405`.
- Behaviour: look up the row for the presenting token; if it is `kind: 'device'`, delete it, persist
  atomically, run `closeByTokenHash` for its hash (§3.6), and answer `200
  {"ok":true,"revoked":1}`. A `kind: 'password'` row is left alone and answers `200
  {"ok":true,"revoked":0}` — a browser hitting this by accident must not log itself out through a
  path that does not clear its cookie.
- An already-dead token never reaches the handler: the gate answers `401 {"error":"unauthorized"}`
  first. The client treats any non-2xx as "already gone" and deletes its local secrets regardless.
- A request that passed the gate via `proxyAuthed` rather than a cookie has no token to look up and
  answers `{"revoked":0}` — correct, and unreachable in fused mode anyway (§2.5 passes
  `trustProxy: undefined`). It is only stated so the Server Edition, where an operator may configure
  a trusted proxy, has a defined answer instead of a crash.
- **It revokes exactly the presenting row and nothing else.** It is deliberately *not* a device
  management API — a device cannot list, name, or revoke any other device. That is the control
  plane, and the control plane is not reachable from a device at all (next paragraph).

This exists because the alternative is a credential that never dies. `/auth/logout`
(`http.ts:478-482`) only calls `clearSessionCookie` and redirects — **it never touches the session
map** — so with §3.5's "no absolute expiry for device rows", removing the server on the phone would
otherwise leave an immortal, un-revoked token on the Mac until someone happened to open the Devices
list. The iOS spec's §1.5 asks for this route; it is granted here, and this section is the
normative definition of it.

#### Minting, listing and revoking: raw `ipcMain`, NOT the platform seam

Minting, listing and revoking are not HTTP routes either. They are `pair:mint`, `pair:list`,
`pair:revoke`, and **on the desktop they are registered with raw `ipcMain.handle` — never
`platform().handle`.** An earlier draft said the opposite and justified it with "authenticated by
the channel they arrive on"; on the fused desktop that sentence is exactly backwards, because one
channel table is shared by the trusted local renderer and every remote peer. The repo states the
rule verbatim, in the comment that opens the very function this would have registered through
(`src/main/platform-electron.ts:46-52`):

> THE INVARIANT (4c): a channel is REACHABLE BY A REMOTE PEER if, and only if, it is registered
> through platform().handle/on. […] acts on the USER's own machine or is host-security-sensitive
> (dialogs, shell, notifications, updater, **pairing/relay control plane**) → raw ipcMain, on
> purpose.

Registering the pairing control plane on the platform seam hands it to the very device it enrolls:
a single stolen or compromised device token becomes self-renewing (`pair:mint` a fresh enrollment
code, enroll a second device it also controls) and can `pair:revoke` the owner's other devices —
including the phone the owner would use to notice. `dispatch` refuses only
`isHostOnlyChannel(req.method)` (`platform-electron.ts:106-111`), so an unlisted `pair:revoke` is
answered for a peer. §2.6 adds the three to `HOST_ONLY_CHANNELS` as a backstop, but the primary
gate is the registration site.

The precedent is already in the tree and is the pattern to copy exactly: the **SSH** pairing
control plane is raw `ipcMain.handle` — `IPC.pairingListDevices` / `IPC.pairingRevokeDevice` at
`src/main/index.ts:1475-1476`, declared at `src/shared/ipc.ts:570-571` — and is therefore
peer-unreachable today.

Add the three constants beside that existing `pairing*` block, named `hostPair*` so they do not
read as the SSH flow. Cost of the change, stated rather than glossed: the fused desktop panel and
the Server Edition panel are no longer *literally* the same registration. They are still the same
renderer code — §9.2 says how the Server Edition registers and gates them, and the answer there is
different because there every client is remote.

### 3.5 Per-device tokens: widen `SessionEntry`, do not add a third store

Today `SessionEntry` is `{createdAt: number}` keyed by the raw token
(`src/server/auth.ts:23-27, :134-140`). That table is already "opaque bearer → row", already
persisted, already validated at both gates, already what the phone presents. Widen it:

```ts
interface SessionEntry {
  createdAt: number
  kind?: 'password' | 'device'          // absent ⇒ 'password' — every existing row
  device?: { id: string; name: string; platform?: string; enrolledFrom?: string; lastSeenAt?: number }
  expiresAt?: number                    // absent ⇒ the existing createdAt + SESSION_TTL_MS rule
}
```

Every new field is **optional**, which is what makes an upstream change to `auth.ts` merge instead
of fight.

- `validateSession` (`:142-155`) keeps ONE implementation; teach its sweep to honour `expiresAt`
  when present, or device rows get culled at 30 days by the existing
  `now - createdAt >= SESSION_TTL_MS` loop. It currently returns `boolean` and cannot report *which*
  row matched; add `lookupSession(token): SessionEntry | null` for the revocation and last-seen
  paths and express `validateSession` in terms of it.
- **Lifetime: no absolute expiry for `kind: 'device'` rows.** A password session is a cached
  password and 30 days is right for it. A device token *is* the credential; expiring it monthly
  sends the phone to a login sheet it has no password for — the exact friction the QR removes.
  Revocation is the only way out, and `lastSeenAt` lets the UI say "not seen in 6 months, remove?".
  (Contested — see §11.)
- **"Never expires" is encoded by the ROW KIND, never by a value in `expiresAt`.** This is the
  detail that silently kills the bullet above if it is left to the implementer's taste, so the
  sweep is specified literally:

  ```ts
  for (const [t, entry] of Object.entries(sessions)) {
    if (entry.kind === 'device') continue                 // no absolute expiry, by kind
    const deadline = typeof entry.expiresAt === 'number' && Number.isFinite(entry.expiresAt)
      ? entry.expiresAt
      : entry.createdAt + SESSION_TTL_MS
    if (now >= deadline) { delete sessions[t]; changed = true }
  }
  ```

  `expiresAt` is written **only when it is a finite timestamp** — it exists for a future
  bounded-lifetime row, not to express "never". The obvious encodings of "never" both fail, and one
  of them fails in the direction that logs every paired phone out at once: `sessions.json` goes
  through `JSON.stringify` (`auth.ts:126-131`), and `JSON.stringify({a: Infinity})` is
  `{"a":null}` — verified on this machine, 2026-09-01. A round-tripped `null` is **not**
  `undefined`, so a sweep written as `if (entry.expiresAt !== undefined && now >= entry.expiresAt)`
  culls immediately (`now >= null` is `now >= 0`), while `entry.expiresAt ?? createdAt +
  SESSION_TTL_MS` culls at 30 days — the exact outcome this section forbids and the thing the iOS
  spec's D-1 calls the single most important answer the desktop owes. The `Number.isFinite` guard
  and the `kind` skip are both load-bearing; the test corpus in §8 pins a hand-edited
  `"expiresAt": null` device row and a hand-edited `null` **password** row.
- `lastSeenAt` is written **at the WS upgrade only** (`ws.ts:88`), throttled to at most once an hour
  per device. `validateSession` runs on every authenticated HTTP request; writing there would
  rewrite `sessions.json` per request.
- `pair:list` returns device rows **with the token key stripped**, built **field by field**, never
  by spreading the entry — the discipline `toPublicDevices` already follows and documents
  (`pairing-core.ts:181-193`), so a future field cannot carry the secret out.

**Hash the map at rest, in one migration.** `sessions.json` stores raw tokens as map keys at mode
0600. Acceptable for a 30-day password cache; not for a credential with no expiry. Key the map by
`sha256hex(token)` for **all** rows: legacy raw-keyed rows then fail to match and everyone re-logs in
once — a login sheet for a browser, a re-scan for a device. **Do not** hash only device rows: two
lookup paths in `validateSession` is exactly the drift this repo warns about. (Contested — §11.)

**Make the writes atomic in the same change.** `auth.json` (`:73`) and `sessions.json` (`:128-132`)
are written with bare `fs.writeFileSync`. The guard test `src/core/fs-atomic.guard.test.ts` scans
only for `rename`/`renameSync` spellings (`:74-84, :119, :136-147`), so a bare `writeFileSync` is
not covered and never was. A torn write is caught by `loadSessions`, which returns `{}`
(`:117-126`) — i.e. **every paired device is silently logged out at once**. That is an annoyance for
a browser cookie and a re-pair-everything event for N phones. Route both through `writeFileAtomic`
(`src/core/fs-atomic.ts`).

**Why not the other two device stores.** `~/.nodeterm/agent.json` `devices[]`
(`pairing-core.ts:130-147`) are SSH pairings whose revoke means editing
`~/.ssh/authorized_keys` (`pairing-service.ts:430-452`), in a file a *separate process* also writes.
`<userData>/remote-approved-devices.json` (`src/main/remote/approved-devices-core.ts:10-14`) is a
list of pinned NaCl public keys for the relay's approve-once flow, explicitly "not credentials".
Different transports, different revocation mechanics — they stay where they are. Where they must be
reconciled is the **UI**: one "Devices" list in Settings merging `pair:list` rows with
`pairing.listDevices()` rows, each labelled by how it connects, so revoking "my iPhone" is not two
entries and a guess. And in **code**: `normalizeDeviceName` (`pairing-core.ts:153-159`) should move
to `src/shared/` and be re-exported from `pairing-core` (keeping the SSH path byte-identical) rather
than duplicated — `src/core` cannot import `src/main`.

### 3.6 Revocation, including live sockets

**`revoke` must close the socket, or it is a lie for the exact case you would use it in.**
`upgradeAllowed` runs once, at the upgrade (`ws.ts:85-102, :148-166`); nothing re-validates an
established connection, and the heartbeat only reaps *silent* peers (`:133-146`). So deleting the
row cuts future connects and leaves a currently-attached stolen phone fully operational,
indefinitely.

Required work, and it is real work, not a footnote:

1. `attachWsServer` records the token each socket authenticated with (it currently discards it after
   `upgradeAllowed`). Keep it as `sha256hex(token)` in a `WeakMap<WebSocket, string>` so the raw
   value is not held in memory for the life of the connection.
2. Expose `closeByTokenHash(hash: string): number` on the returned server object; `attachHttp`
   forwards it. It walks `wss.clients`, closes matching sockets with code 4001, and returns the
   count. The `'close'` handler already runs `teardown`, so presence/pty cleanup is free.
3. `pair:revoke(deviceId)` = delete every row whose `device.id` matches → persist atomically →
   `closeByTokenHash` for each deleted hash → return `{revoked, socketsClosed}`.

`Auth.revokeAll()` (`:157-160`) has **no non-test caller anywhere** in `src/`. A revocation feature
built on that neighbourhood inherits an effectively-untested path; write its tests as if it were new
code, because it is.

### 3.7 Rate limiting

`Auth.failures` / `Auth.lockedUntil` are plain instance fields (`:37-38`); five failures lock **all**
login for 60 s (`:12-13, :168-174`), with **no per-IP dimension**, gating the single call site at
`http.ts:455`. On a tailnet-reachable listener sitting in front of the user's live terminals, that is
a cheap permanent lockout by any peer that can reach the port.

Two changes, and they are independent:

- **`/pair/claim` gets its own counter**, not `Auth.loginAllowed()`. Sharing it is a two-way DoS: a
  pairing brute force locks Siim out of password login, and five bad passwords break the QR he is
  standing there holding. Recommended: 10 failures per 60 s, keyed the same way as below.
- **Key both counters by `x-forwarded-for`.** Measured: behind `tailscale serve` that header is
  proxy-**overwritten**, so a remote tailnet caller cannot choose its own value. But §2.5 says the
  fused host passes `trustProxy: undefined`, which means `proxyAuthAllowed` never runs and there is
  no "trusted proxy" notion in the path. **Resolve this explicitly:** introduce a narrow, separate
  `clientKeyHeader` option, hard-coded to `x-forwarded-for` and honoured **only when the TCP peer is
  loopback**, used for rate-limit keying and attribution **and for nothing else**. It never
  authenticates anything, so the `Cf-Access` forgery class cannot reach it. Reusing `TrustProxyConfig`
  for this would reintroduce the free-text header field that is the actual foot-gun.

**What "only when the TCP peer is loopback" can and cannot buy, since §2.5 binds loopback ONLY.**
The peer is *always* `127.0.0.1` — for serve-proxied traffic and for a request from any other
process on this Mac alike — and there is no marker that separates the two. So the loopback
condition is not a filter here; it is only a guarantee that the option stays inert if the bind
address ever changes. The consequence is asymmetric and worth stating in both directions rather
than collapsing to "the header is untrustworthy":

- **For the rate limiter it does not matter.** The attacker the limiter exists for is a tailnet
  peer brute-forcing `/pair/claim`, and serve overwrites that peer's `x-forwarded-for`, so it
  cannot rotate the key. A *local* process could rotate it freely — but a local process runs as
  the same uid, can read `sessions.json` at mode 0600 directly, and does not need to guess codes at
  all. The limiter is not weakened against anyone it was designed to stop.
- **For attribution it matters a lot.** Any local process can present an arbitrary
  `x-forwarded-for` and `tailscale-user-login`, so the identity shown beside a device row is a
  **claim recorded at enrolment, not evidence of who enrolled.** Record it and display it — it is
  genuinely useful, and for the remote case it is accurate — but the Settings copy must not
  present it as proof, and §11 item 5's preference for post-hoc attribution over a pre-redemption
  confirmation must not lean on it as though it were. Label the row "Enrolled from" (what the
  request said), never "Enrolled by".

The desktop should still **record and display** the redeeming peer: `x-forwarded-for` (tailnet IP)
and `tailscale-user-login` (the tailnet identity). Recorded attribution plus one-tap revocation
still beats a pre-redemption approval modal, which a user reflexively accepts two seconds after
deliberately displaying a QR — but it is a weaker argument than the earlier draft made, given the
paragraph above. (Contested — §11.)

### 3.8 Password: keep it, and make the fused host set one

Nothing here touches `/auth/login`, `/auth/setup`, `/auth/logout` or the session gate. A row with no
`kind` is a password session by definition, so every existing cookie keeps validating through the
same `validateSession`.

The password is **required**, not merely tolerated:

1. The browser UI is how you revoke a lost phone. If the only credential in the world is on the lost
   phone, there is no revocation surface.
2. `pair:mint` is authenticated. On a headless Server Edition the only way to reach it is an
   authenticated browser session.
3. The first-run bootstrap has no phone in it — and note that the fused host has **no console the
   user reads**: `src/server/index.ts:177-180` prints `Setup: …/setup?token=…` to stdout, which under
   launchd goes to `~/Library/Logs/nodeterm-server.out.log`. In an Electron app it goes nowhere.

**Decision:** enabling the fused host **generates** a strong random password, shows it once in the
Settings panel with a copy button, and offers to store it in the Mac's login keychain. Siim will
never type it, and a password he never chose is one he cannot reuse elsewhere. `pair:mint` refuses
when `!auth.isConfigured()`, so that failure surfaces at the Mac, where it can be fixed, rather than
at the phone.

**Generation lives in `initFusedHost`, not in the Settings panel.** The panel *displays* the value;
the fused host *mints* it, on the enable edge, when `!auth.isConfigured()`. That split matters for
sequencing: Phase 2 (§7) brings the listener up before any Settings UI exists, and a password that
only a Phase 5 component can produce would make Phase 2 unloggable-into. Phase 2 reads it off
**main's stdout under `npm run dev`**, which is the one context where a console *is* read — the
"no console the user reads" fact above is about a **packaged** build, and stays true. Log the
generated password once, at generation, and only when `!app.isPackaged`; a packaged build logs
nothing and routes the value to Settings alone.

Do **not** copy `/auth/setup`'s lazy-remint idiom (`auth.ts:92-97`, guarded by the `!isConfigured()`
check at `http.ts:428-433`) into `EnrollmentCodes`. A pairing code is dead after use, full stop.

---

## 4. Address discovery

A pure module, `src/main/fused-host/address.ts`, that parses captured JSON and never builds a URL by
guessing. Both commands' shapes were re-run on this Mac on 2026-09-01:

`tailscale status --self --json` →
```
CertDomains      ['my-mac.tailnet-name.ts.net']
Self.DNSName     'my-mac.tailnet-name.ts.net.'      ← TRAILING DOT
Self.TailscaleIPs['100.79.223.42', 'fd7a:115c:a1e0::d337:df2b']
Self.Online      True
MagicDNSSuffix   'tailnet-name.ts.net'
Self.HostName    'PLGs-MacBook-Pro'                            ← mixed case, never use
```

**Read `CertDomains[0]`, not `DNSName`.** `CertDomains` is by definition the name Tailscale holds a
TLS cert for and is already dot-stripped. A trailing-dot host is accepted by URL parsers but breaks
SNI/cert matching, so embedding `DNSName` raw produces a QR that yields a cert error on the phone.
Fall back to `Self.DNSName` with the trailing dot stripped only if `CertDomains` is empty (which is
what a tailnet with HTTPS certs disabled looks like — that is an admin setting, and the right answer
there is to refuse to mint and say so).

`tailscale serve status --json` → the block quoted in §2.5. **Prefer it over reconstructing the
URL**: it gives the exact published `host:port` *and* the proxy target, so
`Web["<host>:<port>"].Handlers["/"].Proxy === "http://127.0.0.1:<bound port>"` is a **checkable
precondition**, not an assumption. If it does not match the port the fused host actually bound, the
QR would advertise a stale mapping — refuse to mint and say which mapping is wrong.

Rules:
- Parsing is pure and fixture-driven; the shell-out lives in a thin wrapper. These JSON shapes are
  **not a Tailscale stability contract** — a version bump could move `CertDomains` or restructure
  `Web`. Parse defensively and **fail soft into "enter the URL manually", never into a wrong URL**.
- Binary absent / node logged out / `Self.Online` false / no `CertDomains` / no matching serve
  handler / **Funnel enabled for the published `host:port`** ⇒ do not mint. Each gets its own
  message naming the fix.
- **The Funnel precondition is the one that keeps §6's threat model true, and it was missing.**
  §6 asserts "reachability is tailnet-only … so `/pair/claim` is not reachable from the open
  internet", and every argument that follows — including 120 s being an acceptable QR window, and
  a public unauthenticated route being acceptable at all — rests on it. Nothing checked it. If
  Funnel is ever turned on for this node, the listener, `/pair/claim` and `/auth/login` are
  internet-reachable and none of those arguments hold, silently.
  Measured on this Mac, 2026-09-01: `tailscale funnel status` prints
  `https://my-mac.tailnet-name.ts.net (tailnet only)` and the `serve status --json` block
  quoted in §2.5 carries **no** funnel key at all. So the check that is measurable today is the
  `funnel status` one, and that is what v1 implements: refuse to mint unless the funnel state can
  be read **and** reads tailnet-only. **Fail closed** here, unlike the rest of §4's fail-soft rule:
  everywhere else a bad read costs a URL, here it costs the premise.
  **Unverified, and recorded in §11:** the ServeConfig JSON is the same document, and Tailscale's
  own `ServeConfig` carries an `AllowFunnel` map — a JSON key check would be far less brittle than
  parsing a human-readable line. Nobody here has a funnel-ON machine to capture the key's exact
  shape from, so the JSON path is not specified. When someone does, prefer it and keep
  `funnel status` as the fallback; treat an unrecognised shape as "cannot confirm" ⇒ refuse.
- **Do not embed multiple candidate URLs.** `ServerProfile` has a single `baseURL` and
  `webSocketURL` derives from it (`ServerProfile.swift:78-88`); multi-URL failover is a new concept
  in the model, the store and the reconnect path. Any `http` fallback is unreachable per §2.5, and
  an enrollment code travelling over plaintext LAN http is a credential on the wire. Also note
  `pickLanIPv4` (`pairing-core.ts:206-219`) is not a safe source for one: it returns the first
  non-internal, non-169.254 IPv4 in `os.networkInterfaces()` iteration order, which on a machine
  with Tailscale up and `utun` interfaces present can be a 100.x address or a Docker bridge.
- **Path prefixes are a landmine.** If `tailscale serve` ever publishes under a path
  (`tailscale serve /term`), the phone breaks in two verified places: `AuthClient`'s
  `appendingPathIfPresent` claims to preserve a base prefix (`AuthClient.swift:180-183`) but calls
  `URL(string: "/auth/login", relativeTo: base)`, and a leading-slash path is absolute — measured
  under `swift` on this machine, `https://h.ts.net/term/` + `/auth/login` →
  `https://h.ts.net/auth/login`, while the relative form `auth/login` correctly yields
  `https://h.ts.net/term/auth/login`. `ServerProfile.webSocketURL` has the same defect by
  construction (`comps.path = "/ws"`). **Therefore: the fused host refuses to mint a QR for a serve
  mapping whose handler path is not `/`.** Fixing the iOS side is the alternative and is not in this
  spec's scope.

---

## 5. Settings surface

A new **Host** section (`src/renderer/components/settings/sections/HostSection.tsx`), a sibling of
the existing `PhoneSection.tsx` / `RemoteSection.tsx` — not folded into either, because the fused
host is neither the relay nor SSH pairing and merging them would make three unrelated toggles read
as one feature.

Rows:

1. **Serve this Mac to my devices** — `settings.fusedHostEnabled`. Turning it on: `initFusedHost`
   generates the password if unset (§3.8 — the panel displays it, it does not mint it), starts the
   listener, runs address discovery, and shows the resolved URL with its precondition state.
2. **Reachable at** — the discovered `https://…ts.net` (or the specific refusal from §4, with the
   fix named: enable HTTPS certs, run `tailscale serve --bg --https=443 http://127.0.0.1:8443`,
   log in to Tailscale, **turn Funnel off for this node**, …).
3. **Pair a device** — button → `pair:mint` → render the payload with the already-present `qrcode`
   dependency (`package.json:156`; same `toDataURL` call as `usePhonePairing.ts:2`) → countdown →
   auto re-mint on expiry → `revokeAll()` on unmount. The hook is a sibling of `usePhonePairing`,
   `useHostPairing`, with the same "stop on unmount" contract for the same reason.
4. **Devices** — `pair:list`, one row per device: name (escaped — untrusted phone-supplied text,
   §3.4), platform, enrolled-at, last-seen, and the tailnet IP + `tailscale-user-login` recorded at
   enrolment under the label **"Enrolled from"**, never "Enrolled by" (§3.7 — a recorded claim, not
   proof). A **Revoke** button reporting `{revoked, socketsClosed}`. Merge in the SSH
   `pairing.listDevices()` rows, labelled by transport (§3.5).
5. **Server password** — reveal/copy/regenerate. Regenerating does **not** revoke device tokens (a
   device token is not derived from the password); say so on the row.
6. **Warnings**, when applicable: the legacy `~/.nodeterm-server` still present (§2.7); both the
   relay standing host and the fused host enabled at once (see below); the app-quit availability
   note (§2.6 / §11).

**The double-push warning is not hypothetical.** `src/server/index.ts:485-497` already warns that a
host both paired *and* granted double-pushes the same phone — which is precisely the two-process
state today. Fusing does not by itself resolve which push path wins; running the fused host beside
`settings.phoneAccessEnabled` reproduces it inside one process. For v1: surface the warning, do not
auto-disable the relay (that is the user's call, and the relay is the off-tailnet path). Deciding
which sender survives is a follow-up.

---

## 6. Consolidated security posture

What actually stands between a tailnet peer and a terminal on this Mac, once fused:

- **The bearer token, and only it.** The phone sends no Origin (`WebSocketFrameTransport.swift:71`)
  and the Origin check only fires when Origin is present (`ws.ts:90-100`) — correct and deliberate
  for native clients, but it means every property below is load-bearing rather than defence in
  depth.
- **Reachability is tailnet-only — and this is now CHECKED, not assumed.** `tailscale funnel
  status` prints `(tailnet only)`; this is serve, not funnel, so `/pair/claim` is not reachable
  from the open internet. An attacker who photographs the QR must already be a node on the tailnet.
  Every argument in this section, and the 120 s QR window, depends on that sentence, so §4 makes it
  a fail-closed precondition on minting rather than a premise nobody re-reads. Turning Funnel on
  for this node invalidates this whole section.
- **TLS** is real (Tailscale-terminated, `CertDomains`), and the browser cookie is `Secure` because
  `serve` sets `x-forwarded-proto: https` (`http.ts:76-80`).
- **`trustProxy` is never configured** in fused mode (§2.5), so the measured `Cf-Access` forgery
  class is structurally unreachable.
- **The QR is a bearer credential in plain sight.** Mitigations in this design: 120 s TTL, one-shot
  consumption, `revokeAll()` on panel close, and — importantly — the theft is **detectable**: if
  Siim scans and gets `invalid_code` on a QR still counting down, someone else consumed it. Say that
  in the error copy; it is the only detection signal the design has and it is free. **Not**
  mitigated: any proof that the enrolling device is the one in the user's hand.
- **A hostile QR** (DNS hijack, or a QR from elsewhere) is not defended and cannot be without a host
  key in the payload. The SSH flow shows the shape (`pairing-service.ts:561-597`) if it is ever
  wanted. Recommendation: do not build it in v1 over a tailnet with TLS terminated by Tailscale —
  flag it.
- **The pairing control plane is unreachable from any fused client.** `pair:mint`/`pair:list`/
  `pair:revoke` are raw `ipcMain` (§3.4) and additionally listed in `HOST_ONLY_CHANNELS` as a
  backstop, so a stolen device token cannot renew itself, enroll a second device, or revoke the
  owner's. The only pairing verb a device may reach is `/pair/revoke-self`, which can only delete
  the row it is presenting.
- **Host-only channels stay refused; `IPC.licenseUpgrade` gets gated** (§2.6 — the peer-reachable
  path to `platform().openExternal`; the renderer's `shell:open-external` is raw `ipcMain` and was
  never reachable).
- **The attribution shown beside a device row is a recorded claim, not evidence** (§3.7): the fused
  host binds loopback only, so any local process can present its own `x-forwarded-for` /
  `tailscale-user-login`. It is accurate for the remote case, which is the case that matters, but
  the copy must not overstate it.
- **The renderer's own https-only rule must survive the screen it lives in.** Today the *only*
  enforcement of "no plain http except localhost" is inside `AddServerView.swift:105-111` — the
  screen (B) replaces. If the QR path builds a `ServerProfile` on a different code path, that gate
  vanishes with the screen. The scanner must re-assert it, or better: accept `https` only from a QR.

---

## 7. Phased plan

Each phase is independently shippable and independently revertible.

**Phase 1 — the extraction (no behaviour change).**
`src/server/attach.ts`; `WsHost` widening in `ws.ts`; `startServer` rewired to call `attachHttp`.
Done when the whole existing server suite is green with no test edits.

**Phase 2 — the fused listener, desktop only, no pairing.**
`src/main/fused-host.ts` (adapter + lifecycle), `settings.fusedHostEnabled`, three lines in
`src/main/index.ts` plus the `before-quit` leg, the `IPC.licenseUpgrade` gate, the
legacy-data-dir boot warning.

**Phase 2 begins by unloading the launchd job**, and the earlier draft of this plan could not be
run because it did not:

```
launchctl bootout gui/$(id -u)/com.siimvene.nodeterm-server     # reversible: `launchctl bootstrap` re-loads it
```

The plist and `~/.nodeterm-server` both stay on disk — only Phase 6 deletes them — so the rollback
for the whole of Phases 2-5 is one `launchctl bootstrap` away. The reason this cannot be deferred:
§2.5 fixes the port at **8443** and requires a loud `EADDRINUSE` failure, and the launchd job holds
8443. A phase that says "bind 8443, and do not delete the launchd server yet" fails by this spec's
own rule before it reaches its first assertion. Unloading first is also what makes §2.5's "the
tailnet publication keeps working with no reconfiguration" **true**: with 8443 free, the existing
`Web[…:443].Handlers["/"].Proxy → http://127.0.0.1:8443` mapping already points at the fused host.
Do **not** re-point `tailscale serve` — nothing needs re-pointing, and mutating machine-wide state
is what §2.5 declines to do.

Honest cost, and it is the reason this is stated rather than assumed: **the phone has no access
from Phase 2 until it re-enrols.** Its credential is invalidated by the cut-over regardless (§2.4
decision 1), so this only moves the outage earlier, but it is a real outage of several phases:
Phase 4 is the earliest it *can* re-enrol (mint a code with `curl`, render the QR by hand) and
Phase 5 is where it is practical. To get access back during the interval, re-load the launchd job —
but the two servers cannot both hold 8443, so it is one or the other, and the fused host must be
toggled off first. Pick a window (§11 item 18).

Verify, in order:
1. `http://127.0.0.1:8443` in a local browser; log in with the generated password, which Phase 2
   reads off main's stdout under `npm run dev` (§3.8 — packaged builds log nothing).
2. The **same page over the tailnet name**, `https://<CertDomains[0]>/`, from another tailnet
   device. **This is the phase's real gate, and it is the one thing here nobody has measured:**
   `ws.ts:89-100` compares `new URL(origin).host` against `req.headers['host']` — the Host the
   **backend** receives, not `x-forwarded-host`. Nobody has captured what `tailscale serve`
   presents as `Host` to a loopback backend. If it rewrites it to `127.0.0.1:8443`, a tailnet
   browser's WS upgrade is **rejected** and the browser UI does not work over the tailnet at all.
   Today's setup cannot tell you either way, because its only client is the phone and the phone
   sends no Origin (`WebSocketFrameTransport.swift:71`), so that comparison has never run in the
   field. If it fails, the fix is to compare against `x-forwarded-host` when present and the peer
   is loopback (the same narrow, non-authenticating treatment §3.7 gives `x-forwarded-for`) — but
   measure before writing that. See §11.
   **The phone path is unaffected either way**, so a failure here does not block Phases 3-5.

**Phase 3 — the token model.**
Widen `SessionEntry`; add `lookupSession`, `createDeviceSession`, `listDevices`, `revokeDevice`; the
sha256 key migration; `writeFileAtomic` for both files; `closeByTokenHash` on the ws server;
`lastSeenAt` at the upgrade. No new UI. This is the phase whose bugs are the most expensive, so it
ships alone.

**Phase 4 — enrollment.**
`src/core/enrollment-codes.ts`; `POST /pair/claim` and `POST /pair/revoke-self`; the pairing rate
limiter and the loopback-only `clientKeyHeader`; `pair:mint`/`pair:list`/`pair:revoke` on **raw
`ipcMain`** plus the `HOST_ONLY_CHANNELS` backstop (§3.4); the shared payload builder/parser;
`src/main/fused-host/address.ts` including the Funnel precondition (§4).

**Phase 5 — Settings.**
`HostSection.tsx`, `useHostPairing`, the merged Devices list, the password row, the warnings.

**Phase 6 — migration.**
`rm -f` the plist, `rm -rf ~/.nodeterm-server`, and the serve verification (§2.7 — the
`launchctl bootout` half already happened at the top of Phase 2). Only after the phone has
successfully enrolled against the fused host in Phase 5.

**Ordering constraint against the iOS side, and it is a hard one.** Siim's existing phone profile
is `authKind == .password`; the cut-over invalidates both its cookie (§2.4 decision 1) and any
password it stored (§3.8 regenerates one). On the phone that surfaces as a 401 →
`AppEnvironment.autoReauth` → `ReauthSheet`, whose only control today is a password `SecureField`
(`AddServerView.swift:178`) — **for a password that no longer exists anywhere.** The iOS spec's
`.deviceToken` re-pair branch does not fire, because it keys on `authKind`. The recovery route
exists (dismiss → `ServerDetailView` → "Pair with QR") but it is three non-obvious taps behind a
dead-end sheet.

So: **an iOS build carrying §5.3's "Pair with QR" row, §6.4's `.password` escape hatch and the
scanner must be installed on Siim's phone BEFORE Phase 2 unloads the launchd job.** That is iOS P3.
The circularity is only apparent: P3's *scan-and-connect* DoD needs a live fused host and is
therefore verified against Phase 4/5 — but the code has to be **on the device** earlier, because
the moment 8443 changes hands the old build has no route out of the password sheet. Ship P3 to the
phone (TestFlight or a local install), then start Phase 2.

Device-checklist item, owed and previously missing from both documents: *on the P3 build and while
the launchd server is still up, force a 401 (revoke the row in `~/.nodeterm-server/sessions.json`)
and confirm the sheet offers a way to reach the scanner rather than only a password field.* That is
the one rehearsal of the cut-over that can be run before the cut-over.

iOS P1+P2 can land any time; **iOS P3 gates Phase 2**; Phase 5 is what P3 is finally verified
against; iOS P5 (self-revoke) follows Phase 4, which is where `/pair/revoke-self` ships. The
desktop can be tested end-to-end with `curl` against `/pair/claim` before the phone exists.

---

## 8. Testing strategy

Matching this repo's habits: pure logic extracted and unit-tested, generated shell run under real
`sh`, cross-shell parity pinned at source level.

**Pure, unit-tested (no timers, injectable `now`, fixture-driven):**
- `EnrollmentCodes` — TTL, one-shot, the delete-before-expiry-check race, cap eviction,
  `revokeAll`. Copy `download-tickets`' test shape.
- `buildHostPairPayload` / `parseHostPairPayload` — round trip, and **explicit mutual-rejection
  tests against a real `buildPairingPayload` output and a real `nodeterm://pair` URL** (§3.3). This
  test is the whole reason the shapes are safe to coexist; write it in the same commit.
- The Tailscale parsers — against the exact JSON captured in §4, plus: trailing-dot `DNSName`,
  empty `CertDomains`, `Self.Online: false`, a serve handler whose `Proxy` port disagrees with the
  bound port, a serve handler mounted at a path other than `/`, a `funnel status` output **without**
  `(tailnet only)`, and an **unreadable** funnel state — the last two must both refuse to mint
  (fail-closed, §4).
- `Auth`'s new surface — device row creation, password rows unchanged when `kind` is absent,
  `listDevices` never returning a token (assert on the serialized object, not on a type), the
  sha256 migration dropping legacy rows exactly once, and `/pair/revoke-self`'s row selection
  (deletes the presenting device row, leaves every other row and every password row alone).
- **The `expiresAt` sweep, written as its own corpus** — this is the one whose failure logs every
  paired phone out at once, so the four cases in §3.5 get four tests: a `kind:'device'` row with no
  `expiresAt` survives a `now` 10 years out; a device row whose file was hand-edited to
  `"expiresAt": null` **also** survives (the `Number.isFinite` guard); a password row with no
  `expiresAt` still culls at `createdAt + SESSION_TTL_MS`; a password row hand-edited to
  `"expiresAt": null` culls at 30 days, **not** immediately. Round-trip the map through
  `JSON.parse(JSON.stringify(...))` inside the test rather than constructing the objects in memory
  — the whole failure lives in that round trip.

**Real-`sh` tests:** none are *added* by this change — there is no new generated shell. But the
migration in §2.7 removes files the existing generated failover walk names, so
`hook-endpoint-failover-sh` / `node-token-sh` tests should gain a case asserting the walk still
resolves correctly when `~/.nodeterm-server` is **absent** (today every fixture has it present or
irrelevant; absence is the post-migration steady state and nothing pins it).

**Integration, real sockets:**
- `attachHttp` against a fake `WsHost` + a real `http.Server` on port 0: an unauthenticated GET
  redirects to `/login`, a `POST /pair/claim` with a good code returns a token, the same code again
  returns 403, an expired code returns 403, a WS upgrade with the returned token succeeds, and
  `close()` returns while a client is mid-connection (the `terminate()` property — this is the test
  that catches someone "simplifying" it away).
- Revocation: enrol, connect, revoke, assert the socket closed **and** that `presenceHub` no longer
  holds the peer.

**Source-level parity pins** (the repo's own answer to "this shipped in one shell only" —
`hook-verified-parity.test.ts` exists because that happened three times):
- Both `src/server/index.ts` and `src/main/fused-host.ts` reach the listener through `attachHttp`,
  and neither constructs `http.createServer` + `attachWsServer` itself.
- `src/main/fused-host.ts` does **not** reference `registerCoreHandlers`, `initPlatform`,
  `ServerPlatform`, `new SettingsStore`, `new PtyManager` or `new WorkspaceStore`. This is the
  ipcMain-double-registration guard, and a scan is the only thing that catches a future agent
  "reusing startServer".
- `/pair/claim` is registered **above** the session gate in `http.ts`, and `/pair/revoke-self`
  **below** it (assert by index of each route string vs the `sessionTokenFromCookie` gate in the
  file text). Sounds silly; `/pair/claim` above the gate is the whole feature, and
  `/pair/revoke-self` above it would be an unauthenticated revoke-anything route.
- **`src/main/fused-host.ts` contains no `electronPlatform(` call** (§2.2). The failure is total —
  every fused RPC answers `E_NO_HANDLER` — and a scan is cheaper than the debugging session.
- **`pair:mint`/`pair:list`/`pair:revoke` appear in `src/main/index.ts` only as `ipcMain.handle`,
  never as `platform().handle` / `platform.handle`, and all three are members of
  `HOST_ONLY_CHANNELS`** (§3.4). This is the security invariant of the whole feature and it is one
  token's difference from being wrong; `platform-electron.ts:46-52` states the rule but nothing
  enforces it, which is exactly the shape of gap `hook-verified-parity.test.ts` exists for.
- The fused `WsHost` adapter's `setSinkGoneHandler` is a no-op, its `detach` calls
  `unregisterPeerSink`, and it passes **no** `onClientGone` to `attachHttp` (§2.2). Pin all three —
  the failures are silent, and show up as a frozen shared terminal for other viewers or as a
  double teardown per disconnect.

**Manual, documented, not automated** (the pattern `standing-host.ts:440+` already uses for its
relay smoke test): the full phone round trip, and the packaged-build `asar` question from §2.2.

---

## 9. What this means for Desktop / Server Edition / iOS

### 9.1 Desktop (Electron)
The whole feature. Gains: an in-process http+ws listener behind an off-by-default setting; a Host
settings section with QR pairing and a device list; `pair:*` handlers on raw `ipcMain`, reachable
by the local renderer and by nothing else (§3.4). Loses: nothing that was working —
the SSH pairing UI (`src/main/index.ts:1445-1476`, `usePhonePairing.ts`) and the relay standing host
are untouched. **Regression to state out loud:** the phone is now reachable only while the Electron
app is running. The launchd job had `KeepAlive=true` / `RunAtLoad=true`. tmux sessions survive a quit
(`PtyManager.killAll()` only detaches), so this is reachability loss, not work loss — but it is a real
change from the thing being deleted, and the app has a hide-on-close path
(`src/main/index.ts:591`) that makes "quit" rarer than it sounds.

### 9.2 Server Edition
**Behaviour unchanged.** Phase 1 is a pure extraction and `startServer` must stay byte-equivalent in
effect. Phases 3-4 are strict additions it *gains*: per-device tokens, real revocation
(`/pair/revoke-self` included — it lives in `http.ts`, so both shells serve it), and atomic auth
writes.

**`pair:*` on the Server Edition is the one place the two shells legitimately diverge, and it needs
its own gate.** There is no `ipcMain` in `src/server`, and `ServerPlatform.dispatch` is the only
surface it has — so if the Server Edition is to have a pairing panel at all, the three methods must
register through `platform().handle` there. That is safe for the reason the desktop's answer is
unsafe: on the Server Edition *every* client is remote, and an authenticated **password** session
**is** the operator. What must not reach them is a **device** session, or a stolen device token is
self-renewing exactly as §3.4 describes. So:

> On the Server Edition, `pair:mint` / `pair:list` / `pair:revoke` are registered through
> `platform().handle` and **refused for any connection whose session row is `kind: 'device'`**. The
> refusal is keyed off the row the WS upgrade already validated — §3.6 is recording the token hash
> per socket anyway, so recording the `kind` beside it is free. `/pair/revoke-self` stays available
> to a device, because it can only delete the row presenting it.

Note the asymmetry is real and deliberate, not an oversight to be "unified" later: the desktop's
gate is the registration site (raw `ipcMain`), the server's is the connection's credential class.
Only `platform-electron` consults `isHostOnlyChannel` (`:106`, `:134`), so §2.6's
`HOST_ONLY_CHANNELS` backstop does not close the Server Edition's panel.

Two further caveats: a **headless** deployment (`NODETERM_HEADLESS=1`,
`src/server/config.ts:97-98`) binds no listener at all, so `pair:mint` there must refuse rather than
mint a code for an unreachable URL; and the Tailscale address discovery is desktop-only
(`src/main/fused-host/address.ts`) — the Server Edition keeps whatever URL its operator configured,
and with it the §4 Funnel precondition does not apply (the operator owns that exposure decision).

### 9.3 iOS (`nodeterm-mobile`, product Termscape)
Specified separately; this is the desktop-side contract and the constraints it imposes.

The transport work is **zero**: the device token rides the existing `Cookie: nt_session=` header out
of the existing per-profile Keychain slot (§3.1). What the phone needs:

- A new `PairingClienting` with `enroll(baseURL:code:deviceId:deviceLabel:)` and
  `revokeSelf(baseURL:token:)` — copies of `AuthClient.post()` with different paths and a JSON
  success test instead of a Set-Cookie one. **Additive protocol, not a member on `AuthClienting`**:
  `Contracts.swift:4-5` declares those signatures final and any new member also forces an edit to
  the `UnwiredAuth` stub in `Factory.swift:139-144`.
- **`deviceId` per §3.4:** send the stored one if the profile has one, omit the field if it does
  not, and adopt whatever the 200 body returns. The phone never treats its own generated id as
  authoritative.
- **`POST /pair/revoke-self` on server removal** (§3.4). Best-effort: any non-2xx is ignored and the
  local secrets are deleted regardless. This is the answer to the iOS spec's D-3, and it is granted
  rather than declined because with no absolute expiry on device rows the alternative is a
  credential that outlives the app that held it.
- A QR scanner in the **App** target (AVFoundation), with the pure `PairPayloadParser` in
  `NodetermKit` — `Package.swift` pins NodetermKit dependency-free and platform-neutral. Plus
  `NSCameraUsageDescription` in `project.yml` beside the existing mic/speech keys (a missing string
  is a hard crash on first camera access).
- Three optional `ServerProfile` fields (`authKind`, `deviceLabel`, `enrolledAt`), **every one
  decoded with `decodeIfPresent`**, exactly as `isDemo` is (`ServerProfile.swift:52-62`). The
  init at `:52-62` decodes every other field as REQUIRED, and `ServerProfileStore.readAll` sidelines
  a failed decode to `servers.json.corrupt-<ts>` and returns `[]` — a required new key makes Siim's
  existing server vanish from Home with orphaned Keychain items and no error shown.
- A branch in the re-auth path: a `.deviceToken` profile that gets a 401 must be offered
  **"re-pair"**, never a password `SecureField` — it has no password by construction. The 401 itself
  cannot carry the distinction (the WS one is a raw socket write, `ws.ts:154-161`), so this is a
  client-side branch on `authKind`.
- **And an escape hatch on the `.password` branch of that same sheet**, which the earlier draft of
  both documents missed. The cut-over invalidates Siim's existing profile's cookie (§2.4 decision 1)
  *and* the password behind it (§3.8 mints a new one), and that profile is `authKind == .password`
  — so the `.deviceToken` branch never fires and the user lands on a `SecureField` for a password
  that does not exist. A secondary **"Pair with QR instead"** action on the password sheet is the
  fix, and §7's ordering constraint says it must be on the phone before Phase 2 runs.
- An **"upgrade this profile to a device token"** row on `ServerDetailView`, which must also
  `deletePassword` and set `rememberPassword = false` — otherwise the plaintext password stays on
  the phone forever and the token buys nothing.
- **Demo mode must survive the Add Server rebuild.** A reviewer has no Mac to scan and the Simulator
  has no camera: the demo button stays visible without scrolling, and the scanner degrades to a
  "camera unavailable" message rather than a black view. The app must remain fully usable without
  camera permission.
- `ConnectFlowUITests` drives the current form by literal labels (`"Add Server"`, `"Name"`,
  `"Base URL (https://…)"`, the insecure-http switch, `"Connect"`) against a real server on
  `http://127.0.0.1:8444`. Any restructure must keep those reachable behind an "Enter details
  manually" disclosure or update the test in the same change, and the localhost-http branch must
  survive verbatim.

The **other** iOS app (`nodeterm-ios`, SSH/Citadel, private, not on this machine) is unaffected: it
speaks the SSH payload, which §3.3 deliberately makes unreadable to this scanner and vice versa.

---

## 10. Upstream-merge cost

Additive by construction. The files with **zero** conflict surface: `src/server/attach.ts`,
`src/main/fused-host.ts`, `src/main/fused-host/address.ts`, `src/core/enrollment-codes.ts`, the
shared payload module, the new Settings section, and all their tests.

The edits that will conflict, in order of pain:

| file | edit | why it hurts |
| --- | --- | --- |
| `src/main/index.ts` | 3 lines of toggle wiring + 1 `before-quit` leg + 3 `ipcMain.handle` lines for `hostPair*` beside the existing pairing block at `:1475-1476` (+ optionally the `registerFsHandlers` download-ticket dep at `:1517`) | 3,750 lines, the most merge-hostile file in the repo — hence the standing-host-shaped module |
| `src/server/auth.ts` | widened `SessionEntry`, 4 new methods, atomic writes, the sha256 migration | ~80 lines in a 180-line file; **every new field optional** is what makes this merge |
| `src/server/http.ts` | two route blocks — `/pair/claim` in the public section, `/pair/revoke-self` after the gate | ~35 lines, low churn upstream |
| `src/shared/host-control.ts` | 4 entries added to `HOST_ONLY_CHANNELS` (the three `hostPair*`, plus `licenseUpgrade`) | trivial, but it is the security backstop — do not drop it in a merge |
| `src/server/ws.ts` | `WsHost` type widening + token recording + `closeByTokenHash` | ~30 lines |
| `src/server/index.ts` | call `attachHttp` instead of inlining the listen block | one hunk, and the block is stable |
| `src/shared/ipc.ts` | three constants beside the `pairing*` block at `:565-571` | trivial |

No renames, no `nodeterm` → `termscape` sweep, nothing in the ~3,600-occurrence blast radius.

---

## 11. Open questions and where the surveys disagreed

Recorded rather than resolved. Each needs Siim's call, or a measurement nobody has taken.

1. **What counts as "the second moving part".** The host-seam pass said fusing does not remove
   `tailscale serve` unless the tailnet interface is bound directly; the address pass said a direct
   bind is impossible because of iOS ATS. Both are right. This spec picks loopback + serve and
   states the cost (§2.5). If Siim's definition requires the serve mapping to go, the answer is
   an ATS exception plus `NSLocalNetworkUsageDescription` on iOS, and that is a different project.
2. **TTL: 120 s or 10 minutes.** The pairing-proto pass and the address pass both recommended 120 s;
   the SSH flow's own history (`pairing-service.ts:194`, widened *after* a field report of expired
   QRs) argues the other way. Mitigated here by the countdown + auto re-mint (§3.2).
3. **Device-token lifetime.** No absolute expiry (recommended, revocation-only) versus a long
   sliding one. A sliding TTL means a write per connect, which `sessions.json`'s write path is not
   built for.
4. **Hash `sessions.json` keys now?** One-time re-login for everyone, better at-rest posture. This
   is a one-line policy decision with a user-visible cost, so it is Siim's.
5. **Pre-redemption confirmation on the Mac, or post-hoc attribution + undo?** This spec recommends
   post-hoc, because a prompt two seconds after deliberately displaying a QR trains click-through.
   The secondary argument — that the proxy-overwritten `x-forwarded-for` / `tailscale-user-login`
   make attribution *real* — is **narrower than the earlier draft claimed**: it holds for a remote
   tailnet caller and not for a local process, because the fused host binds loopback only and
   nothing distinguishes the two peers (§3.7). The recommendation stands on the click-through
   argument alone. A blocking prompt is strictly stronger and defeats the photographed-QR attack
   outright; it also requires the user to be at the Mac, which defeats scanning from the couch.
6. **Bind the enrolment to the redeeming tailnet identity?** Feasible given the measured headers, and
   it would kill the photographed-QR attack. It breaks any case where the phone's tailnet identity
   differs from the Mac's (shared tailnet, phone on another Tailscale account). Not recommended for
   v1; cheap to add later since the identity is already recorded.
7. **Is the fused phone a guest or a full operator?** This spec says guest (host-only channels stay
   refused, §2.6) — which is *more* restrictive than what the phone can do through the standalone
   server today. If the phone actually uses `githubControl:*`, that is a regression and the policy
   needs revisiting.
8. **Browser Explorer downloads fused** — worth the `registerFsHandlers` edit at
   `src/main/index.ts:1517`, or accept a dead download button for v1?
9. **Should the Server Edition get a QR panel?** The design gives it for free; whether to expose it
   is a product call.
10. **Which push path survives** once one process owns both the relay standing host and the fused
    host (`src/server/index.ts:485-497`'s double-push warning). Deferred; surfaced as a Settings
    warning in v1.
11. **`com.siimvene.nodeterm-server-sync.plist`** — nobody read it. Read before deleting anything.
12. **Unverified, owed a device check:** `serveStatic`'s `fs.promises.stat`/`readFile` against paths
    inside `app.asar` in a packaged build (§2.2). Only affects the browser UI served by the fused
    host, not the phone.

### Added after the adversarial review (2026-09-01)

13. **Unverified, owed a measurement — what `Host` does `tailscale serve` present to the backend?**
    `ws.ts:89-100` compares `new URL(origin).host` against `req.headers['host']`, i.e. the Host the
    **backend** receives, not `x-forwarded-host`. If serve rewrites it to `127.0.0.1:8443`, every WS
    upgrade from a tailnet **browser** is rejected and the Server-Edition-over-tailnet UI does not
    work at all. Today's setup cannot answer it: its only client is the phone, which sends no Origin
    (`WebSocketFrameTransport.swift:71`), so the comparison has never run. The survey measured the
    `x-forwarded-*` / `tailscale-user-*` families it injects and recorded nothing about `Host`.
    Settling it means another throwaway `--https=8444` serve entry; that mutates machine-wide state,
    so it is deferred to Phase 2's DoD (§7) rather than re-run here. **The phone path is unaffected
    either way** — this gates only the browser UI.
14. **Unverified — the funnel key in `serve status --json`.** §4's Funnel precondition is
    implemented against `tailscale funnel status`'s `(tailnet only)` line because that is what was
    measurable here (funnel is off on this Mac, and the serve JSON consequently carries no funnel
    key). Tailscale's `ServeConfig` has an `AllowFunnel` map, and a JSON key check would be far less
    brittle than parsing prose. Capture the funnel-ON shape on any machine that has it and switch.
15. **`settings.phoneAccessEnabled` defaults to TRUE, which means the relay broker is dialled on
    every packaged launch — today, and after fusing.** Verified: `src/shared/types.ts:1419` declares
    it, `:1583` defaults it `true`; `standing-host.ts:426-436` `syncFromSettings()` sets `enabled`
    from it and calls `reconcile()`; `:394-396` `want = enabled && relayAllowed()`, and
    `relayAllowed()` (`src/main/remote/host-service.ts:733-735`) is `app.isPackaged ||
    !!NODETERM_RELAY_URL` — unconditionally true in a shipped build. `start()` → `ensurePool()` →
    `connectOne()`, which mints a host token against the relay (`entitlement` is explicitly optional:
    *"null on free tier → mint by deviceId"*) and opens a WebSocket to `RELAY_URL`. §1 puts the
    relay out of scope and §5 row 6 surfaces a double-push warning, both of which stay correct — but
    "delete the second moving part" is not met by default while a third-party rendezvous is dialled
    at every launch. **This is a product decision for Siim, not a spec fix:** flip the default to
    `false`, auto-disable the relay when `fusedHostEnabled` goes on, or leave both on deliberately.
    Recorded here rather than decided.
16. **Should the Server Edition's `pair:*` gate reuse `HOST_ONLY_CHANNELS`?** §9.2 gates by the
    connection's session `kind` instead, because on that shell every client is remote and the list
    is only consulted by `platform-electron`. A cleaner unification would be a per-connection
    capability class both shells consult. Out of scope here; noted so the asymmetry is a decision
    rather than a drift.
17. **`/pair/revoke-self`'s answer for a password row.** §3.4 returns `200 {"ok":true,"revoked":0}`
    so a browser cannot log itself out through a path that never clears its cookie. A `403` would be
    more informative and is a one-word change; the client ignores the distinction either way.
18. **When does the phone-outage window open?** Phase 2 unloads the launchd job and the phone stays
    unreachable until it re-enrols against the fused host (Phase 4 at the earliest, Phase 5 in
    practice). Nothing technical decides this — Siim picks the days. It is listed because the plan
    reads as continuous and it is not: there is a multi-phase gap in the middle where remote access
    to this Mac does not exist, and the rollback out of it (`launchctl bootstrap` + fused host
    toggled off) has to be a decision someone made in advance rather than one made at 11pm.

### Raised by the review and REJECTED here, with the evidence

- **"The `x-forwarded-for` rate-limit key is evadable by rotating the header."** Rejected as stated;
  the attribution half of the same finding is accepted and is now written into §3.7. The header is
  forgeable only by a process already running **on this Mac** — for a remote tailnet caller,
  `serve` **overwrites** it (measured, §2.5), so the attacker the pairing limiter exists for cannot
  rotate the key at all. A local process runs as the same uid, can read `sessions.json` at mode
  0600 directly, and has no reason to brute-force a 192-bit enrollment code. The limiter is not
  weakened against anyone it was designed to stop, and keying it by peer identity instead would buy
  nothing while making the remote case worse (every tailnet caller collapses to one loopback key).
  What the same fact *does* invalidate is treating the recorded tailnet identity as **evidence** —
  §3.7 and §5 row 4 now say "Enrolled from", and §11 item 5's preference for post-hoc attribution
  no longer rests on it.
