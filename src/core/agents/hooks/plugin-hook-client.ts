// The hook CLIENT embedded in nodeterm's JS plugins/extensions (opencode's plugin, pi's extension).
//
// Those agents load a JS module in-process instead of running a hook command, so they cannot use the
// managed POSIX script (managed-script.ts). This is the ONE JS copy of that script's wire contract,
// shared by every such plugin so the two cannot drift (it used to live inline in opencode.ts):
//  - gate on NODETERM_NODE_ID (the caller returns early without it — outside nodeterm, nothing runs);
//  - per POST, re-read the NODETERM_HOOK_ENDPOINT FILE for the LIVE port/sock/token (tmux sessions
//    outlive the app, so env-baked coordinates go stale after a restart); fall back to the env vars;
//  - present the per-node token from <NODETERM_NODE_TOKEN_DIR>/<nodeId> (a lookup by name, never a
//    scan); missing is an ordinary state and goes out EMPTY (the server reads that as legacy);
//  - POST application/x-www-form-urlencoded `nodeId` + `version` + `payload` (JSON) with the
//    x-nodeterm-hook-token header to `<route>`; a UNIX SOCKET (an SSH host advertises one, with no
//    PORT line) wins over TCP, like the POSIX script's `curl --unix-socket` branch.
// Known gap vs the POSIX script: no cross-endpoint FAILOVER walk (#445). A plugin pinned to a dead
// endpoint stays dark until the endpoint file is rewritten; the POSIX script tries siblings.
//
// The returned text is spliced into a generated module that has already imported `fs` and `http`,
// declared `parseEndpointEnv`, and bound `nodeId`. It declares `live`, `nodeToken`, `post` (fire and
// forget, returns undefined) and `postAndWait` (resolves when the request settles or after
// `waitMs`) — the latter for an event whose process may exit right after it (a session end).
export function buildPluginHookClient(route: string, indent = '  '): string {
  const body = `const live = () => {
  const conf = {
    port: process.env.NODETERM_HOOK_PORT,
    sock: process.env.NODETERM_HOOK_SOCK,
    token: process.env.NODETERM_HOOK_TOKEN,
    version: process.env.NODETERM_HOOK_VERSION,
    tokenDir: process.env.NODETERM_NODE_TOKEN_DIR
  }
  try {
    const file = process.env.NODETERM_HOOK_ENDPOINT
    if (file) {
      const env = parseEndpointEnv(fs.readFileSync(file, 'utf8'))
      if ('NODETERM_HOOK_PORT' in env) conf.port = env.NODETERM_HOOK_PORT
      if ('NODETERM_HOOK_SOCK' in env) conf.sock = env.NODETERM_HOOK_SOCK
      if ('NODETERM_HOOK_TOKEN' in env) conf.token = env.NODETERM_HOOK_TOKEN
      if ('NODETERM_HOOK_VERSION' in env) conf.version = env.NODETERM_HOOK_VERSION
      // The v2 endpoint line: where this instance keeps per-node tokens.
      if ('NODETERM_NODE_TOKEN_DIR' in env) conf.tokenDir = env.NODETERM_NODE_TOKEN_DIR
    }
  } catch {}
  return conf
}
// The PER-NODE capability, read fresh per POST from <dir>/<nodeId> — a lookup by name, never a
// scan, so this session can only ever present its own. Missing (pre-v2 endpoint, a node whose
// token was never materialised) is an ordinary state: the header goes out EMPTY and the server
// reads that as legacy, exactly like every client that predates this.
const nodeToken = (dir) => {
  try {
    if (!dir) return ''
    return fs.readFileSync(dir + '/' + nodeId, 'utf8').split('\\n')[0].trim()
  } catch {
    return ''
  }
}
// Sends one event. Resolves (never rejects) when the request settles; callers that must not
// block ignore the promise.
const send = (event, extra) => {
  try {
    const { port, sock, token, version, tokenDir } = live()
    if (!token || (!sock && !port)) return Promise.resolve()
    const payload = JSON.stringify({ event, ...extra })
    const headers = {
      'content-type': 'application/x-www-form-urlencoded',
      'x-nodeterm-hook-token': token,
      'x-nodeterm-node-token': nodeToken(tokenDir)
    }
    const body =
      'nodeId=' + encodeURIComponent(nodeId) +
      '&version=' + encodeURIComponent(version || '') +
      '&payload=' + encodeURIComponent(payload)
    if (sock && typeof Bun !== 'undefined') {
      return fetch('http://localhost${route}', { method: 'POST', unix: sock, headers, body }).then(() => {}, () => {})
    }
    if (sock) {
      return new Promise((resolve) => {
        const req = http.request(
          { socketPath: sock, path: '${route}', method: 'POST', headers },
          (res) => { res.resume(); res.on('end', resolve); res.on('error', resolve) }
        )
        req.on('error', () => resolve())
        req.end(body)
      })
    }
    return fetch('http://127.0.0.1:' + port + '${route}', { method: 'POST', headers, body }).then(() => {}, () => {})
  } catch {
    return Promise.resolve()
  }
}
const post = (event, extra) => { send(event, extra) }
// The timer is unref'd: it bounds the wait, it must not keep a quitting process alive by itself.
const postAndWait = (event, extra, waitMs = 1500) =>
  Promise.race([
    send(event, extra),
    new Promise((resolve) => { const t = setTimeout(resolve, waitMs); if (t && t.unref) t.unref() })
  ])`
  return body
    .split('\n')
    .map((line) => (line ? indent + line : line))
    .join('\n')
}
