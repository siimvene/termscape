import { describe, it, expect, vi } from 'vitest'
import { ClaudeScienceService, redactScienceSecrets, registerClaudeScience } from './claude-science'

describe('Claude Science service', () => {
  it('enforces machine-wide consent before a saved node can launch Science', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>()
    const service = new ClaudeScienceService('/unused', { env: {}, run: async () => '{}' })
    const open = vi.spyOn(service, 'open').mockResolvedValue('fresh')
    let enabled = false
    registerClaudeScience({ handle: (name, fn) => { handlers.set(name, fn) } }, service, () => enabled)
    expect(() => handlers.get('science:open')!()).toThrow('Allow Claude Science')
    expect(open).not.toHaveBeenCalled()
    enabled = true
    expect(await handlers.get('science:open')!()).toBe('fresh')
  })
  it('starts only once for simultaneous views, and mints independent login links', async () => {
    let running = false
    let nonce = 0
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === 'status') return JSON.stringify({ running, port: 8765, version: '0.1.63', daemon: { sandbox_active: true } })
      if (args[0] === 'serve') { running = true; return '' }
      if (args[0] === 'url') return `http://localhost:8765/?nonce=${++nonce}`
      if (args[0] === 'stop') { running = false; return '' }
      return ''
    })
    const service = new ClaudeScienceService('/unused', { run, basePath: '/apps/claude-science', env: {
      NODETERM_SCIENCE_APP_ORIGIN: 'https://termscape.test',
      NODETERM_SCIENCE_PREVIEW_ORIGIN: 'https://termscape.test:8444'
    } })
    const links = await Promise.all([service.open(), service.open()])
    expect(links).toEqual(['/apps/claude-science/?nonce=1', '/apps/claude-science/?nonce=2'])
    const launches = run.mock.calls.filter(([a]) => a[0] === 'serve')
    expect(launches).toHaveLength(1)
    expect(launches[0][0]).toContain('--base-path')
    expect(launches[0][0]).toContain('--allow-origin')
    expect(launches[0][0]).toContain('https://termscape.test')
    expect(launches[0][0].join(' ')).not.toMatch(/dangerously/)
    expect((await service.status()).sandboxActive).toBe(true)
    expect((await service.status()).previewConfigured).toBe(true)
    await service.stop()
    expect((await service.status()).running).toBe(false)
  })

  it('does not relaunch an existing instance or stop it on view closure', async () => {
    const run = vi.fn(async (args: string[]) => args[0] === 'status'
      ? JSON.stringify({ running: true, port: 8765 }) : 'http://localhost:8765/?nonce=fresh')
    await new ClaudeScienceService('/unused', { run, env: {} }).open()
    expect(run.mock.calls.map(([a]) => a[0])).toEqual(['status', 'url'])
  })

  it('rejects foreign login URLs and mismatched running ports', async () => {
    const run = async (args: string[]) => args[0] === 'status'
      ? JSON.stringify({ running: true, port: 8765 }) : 'https://evil.example/?nonce=secret'
    await expect(new ClaudeScienceService('/unused', { run, env: {} }).open()).rejects.toThrow('unexpected login')
    await expect(new ClaudeScienceService('/unused', { run, env: { NODETERM_SCIENCE_PORT: '9000' } }).open()).rejects.toThrow('different port')
  })

  it('reports a missing install, and redacts one-time credentials from logs', async () => {
    const missing = new ClaudeScienceService('/unused', { run: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }, env: {} })
    expect(await missing.status()).toMatchObject({ installed: false, running: false })
    expect(redactScienceSecrets('URL http://localhost/?nonce=secret&x=1 Bearer abc.def')).toBe('URL http://localhost/?nonce=[redacted]&x=1 Bearer [redacted]')
    const service = new ClaudeScienceService('/unused', { run: async () => 'Web UI http://localhost/?nonce=secret', env: {} })
    expect(await service.logs()).not.toContain('secret')
  })

  it('requires a separate valid HTTPS preview origin and distinct ports', () => {
    expect(() => new ClaudeScienceService('/unused', { env: { NODETERM_SCIENCE_PREVIEW_ORIGIN: 'http://host' } })).toThrow('HTTPS origin')
    expect(() => new ClaudeScienceService('/unused', { env: { NODETERM_SCIENCE_PREVIEW_PORT: '8765' } })).toThrow('separate ports')
    expect(() => new ClaudeScienceService('/unused', { env: { NODETERM_SCIENCE_APP_ORIGIN: 'https://host', NODETERM_SCIENCE_PREVIEW_ORIGIN: 'https://host' } })).toThrow('separate origins')
  })
})
