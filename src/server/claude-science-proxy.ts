import http from 'http'
import type { Duplex } from 'stream'
import { SCIENCE_BASE_PATH } from '../shared/claude-science'

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'forwarded'])

/** Fixed loopback upstream, never a URL supplied by a caller. Authentication stays with Termscape
 * AND Science. Only this explicitly trusted application may be embedded; ordinary browser nodes
 * do not gain a frame-policy bypass. Preview traffic is never sent through this origin. */
export class ClaudeScienceProxy {
  constructor(private port: number, private enabled: () => boolean = () => true) {}

  matches(url: string): boolean {
    const pathname = new URL(url, 'http://localhost').pathname
    return pathname === SCIENCE_BASE_PATH || pathname.startsWith(`${SCIENCE_BASE_PATH}/`)
  }

  private options(req: http.IncomingMessage): http.RequestOptions {
    const headers: http.OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (!HOP_HEADERS.has(name) && !name.startsWith('x-forwarded-') && name !== 'cookie') headers[name] = value
    }
    // Do not disclose Termscape's session cookie to the upstream application.
    headers.cookie = (req.headers.cookie ?? '').split(';').filter((c) => /^\s*operon[_-]/i.test(c)).join(';')
    const host = `127.0.0.1:${this.port}`
    headers.host = host
    if (headers.origin) headers.origin = `http://${host}`
    const url = new URL(req.url ?? '/', 'http://localhost')
    return { hostname: '127.0.0.1', port: this.port, method: req.method,
      path: (url.pathname.slice(SCIENCE_BASE_PATH.length) || '/') + url.search, headers }
  }

  /** Refuse cross-site writes and upgrades before rewriting the upstream Origin. */
  originAllowed(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin
    if (!origin) return req.method === 'GET' || req.method === 'HEAD'
    try {
      const u = new URL(origin)
      return ['http:', 'https:'].includes(u.protocol) && u.host === req.headers.host
    } catch { return false }
  }

  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (!this.matches(req.url ?? '/')) return false
    if (!this.enabled()) { res.writeHead(403); res.end('Claude Science panels are disabled in Settings > Agents.'); return true }
    if (!this.originAllowed(req)) { res.writeHead(403); res.end('Forbidden origin'); return true }
    const upstream = http.request(this.options(req), (response) => {
      const headers = { ...response.headers }
      for (const key of HOP_HEADERS) delete headers[key]
      delete headers['x-frame-options']
      headers['content-security-policy'] = String(headers['content-security-policy'] ?? '')
        .replace(/frame-ancestors\s+[^;]+;?/gi, '').trim() + "; frame-ancestors 'self'"
      headers['x-frame-options'] = 'SAMEORIGIN'
      headers['cache-control'] = 'no-store'
      // Science's nonce confirmation is a native form POST. Chromium sends Origin: null when
      // its document says no-referrer, which would fail both Origin gates. Keep same-origin
      // form navigation working while still preventing nonce URLs leaking to other sites.
      headers['referrer-policy'] = 'same-origin'
      // Absolute loopback redirects must stay on the proxy, including OAuth callbacks.
      if (headers.location) {
        const target = new URL(headers.location, `http://127.0.0.1:${this.port}`)
        if (['localhost', '127.0.0.1'].includes(target.hostname) && target.port === String(this.port)) {
          headers.location = SCIENCE_BASE_PATH + (target.pathname.startsWith(SCIENCE_BASE_PATH)
            ? target.pathname.slice(SCIENCE_BASE_PATH.length) : target.pathname) + target.search + target.hash
        }
      }
      res.writeHead(response.statusCode ?? 502, headers)
      response.pipe(res)
    })
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Claude Science is not running. Reconnect from its node.') })
    req.on('aborted', () => upstream.destroy())
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
    return true
  }

  upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.enabled()) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
    if (!this.originAllowed(req)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
    const revoke = setInterval(() => { if (!this.enabled()) socket.destroy() }, 1000)
    revoke.unref()
    socket.once('close', () => clearInterval(revoke))
    const options = this.options(req)
    options.headers = { ...options.headers, connection: 'Upgrade', upgrade: 'websocket' }
    const upstream = http.request(options)
    upstream.on('upgrade', (response, peer, buffered) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
        .map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`)
      if (head.length) peer.write(head)
      if (buffered.length) socket.write(buffered)
      peer.on('error', () => socket.destroy())
      socket.on('error', () => peer.destroy())
      socket.on('close', () => peer.destroy())
      peer.pipe(socket).pipe(peer)
    })
    upstream.on('response', (response) => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode ?? 502} Rejected\r\n\r\n`) })
    upstream.on('error', () => socket.destroy())
    socket.on('close', () => upstream.destroy())
    upstream.end()
  }
}
