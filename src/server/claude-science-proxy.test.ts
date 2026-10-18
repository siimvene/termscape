import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import WebSocket, { WebSocketServer } from 'ws'
import { Auth } from './auth'
import { createHttpHandler } from './http'
import { attachWsServer } from './ws'
import { ServerPlatform } from './platform-server'
import { ClaudeScienceProxy } from './claude-science-proxy'

let dir: string, upstream: http.Server, server: http.Server, echo: WebSocketServer
let base: string, cookie: string, upstreamRequest: http.IncomingMessage | undefined
let sockets: WebSocket[]
let enabled: boolean

beforeEach(async () => {
  sockets = []
  enabled = true
  upstreamRequest = undefined
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'science-proxy-'))
  fs.writeFileSync(path.join(dir, 'index.html'), 'Termscape')
  upstream = http.createServer((req, res) => {
    upstreamRequest = req
    res.writeHead(200, { 'content-type': 'text/plain', 'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
      'set-cookie': 'operon_session=science; HttpOnly; Path=/apps/claude-science' })
    res.end(req.url)
  })
  echo = new WebSocketServer({ server: upstream })
  echo.on('connection', (ws) => ws.on('message', (data) => ws.send(data.toString())))
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const proxy = new ClaudeScienceProxy((upstream.address() as { port: number }).port, () => enabled)
  const auth = new Auth(dir)
  cookie = `nt_session=${auth.createSession()}`
  server = http.createServer(createHttpHandler({ auth, rendererDir: dir, scienceProxy: proxy }))
  attachWsServer(server, { auth, scienceProxy: proxy, platform: new ServerPlatform({ userDataDir: dir, appVersion: 'test' }) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterEach(async () => {
  sockets.forEach((s) => s.terminate())
  echo.clients.forEach((s) => s.terminate())
  echo.close()
  await Promise.all([server, upstream].map((s) => new Promise((r) => s.close(r))))
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('Science proxy', () => {
  it('blocks panel access when its machine-wide permission is revoked', async () => {
    enabled = false
    const response = await fetch(`${base}/apps/claude-science/`, { headers: { cookie } })
    expect(response.status).toBe(403)
    expect(upstreamRequest).toBeUndefined()
  })

  it('closes an existing Science WebSocket when panel permission is revoked', async () => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/apps/claude-science/ws', { headers: { cookie, origin: base } })
    sockets.push(ws)
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    const closed = new Promise((resolve) => ws.once('close', resolve))
    enabled = false
    await closed
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })
  it('requires Termscape authentication, preserves Science cookies, and never forwards Termscape credentials', async () => {
    const url = `${base}/apps/claude-science/api/me?x=1`
    expect((await fetch(url)).status).toBe(401)
    const response = await fetch(url, { headers: { cookie: `${cookie}; operon_session=own`, origin: base } })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('/api/me?x=1')
    expect(upstreamRequest?.headers.cookie).toBe('operon_session=own')
    expect(response.headers.get('set-cookie')).toContain('operon_session=science')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'self'")
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN')
  })

  it('rejects cross-origin writes and does not route previews or lookalike prefixes', async () => {
    const response = await fetch(`${base}/apps/claude-science/api/write`, {
      method: 'POST', headers: { cookie, origin: 'https://evil.example' }, body: 'no'
    })
    expect(response.status).toBe(403)
    expect(upstreamRequest).toBeUndefined()
    const proxy = new ClaudeScienceProxy(8765)
    expect(proxy.matches('/apps/claude-science-other')).toBe(false)
    expect(proxy.matches('/mcp_apps/preview')).toBe(false)
  })

  it('tunnels authenticated WebSockets and refuses unauthenticated upgrades', async () => {
    const url = base.replace('http:', 'ws:') + '/apps/claude-science/ws'
    const ws = new WebSocket(url, { headers: { cookie, origin: base } })
    sockets.push(ws)
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    const message = new Promise((resolve) => ws.once('message', (data) => resolve(data.toString())))
    ws.send('hello Science')
    expect(await message).toBe('hello Science')
    const denied = new WebSocket(url, { origin: base })
    sockets.push(denied)
    await expect(new Promise((resolve, reject) => { denied.once('open', resolve); denied.once('error', reject) })).rejects.toThrow('401')
  })
})
