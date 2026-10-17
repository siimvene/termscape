import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { IPC } from '../shared/ipc'
import type { ClaudeScienceStatus } from '../shared/claude-science'
import type { CorePlatform } from './platform'
import { redactSecrets } from './log-redact'

const execute = promisify(execFile)
type Run = (args: string[]) => Promise<string>

export function redactScienceSecrets(text: string): string {
  return redactSecrets(text).replace(/([?&]nonce=)[^\s"'<>&]+/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[redacted]')
}

export class ClaudeScienceService {
  private opening?: Promise<void>
  private run: Run
  readonly port: number
  readonly previewPort: number
  readonly dataDir: string
  readonly basePath: string
  readonly previewOrigin?: string
  readonly appOrigin?: string

  constructor(userDataDir: string, options: { basePath?: string; run?: Run; env?: NodeJS.ProcessEnv } = {}) {
    const env = options.env ?? process.env
    // Science creates AF_UNIX sockets beneath this directory. Keep its name short.
    this.dataDir = path.join(userDataDir, 'science')
    this.basePath = options.basePath ?? ''
    const port = (value: string | undefined, fallback: number): number => {
      const n = Number(value ?? fallback)
      if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error('Invalid Claude Science port')
      return n
    }
    this.port = port(env.NODETERM_SCIENCE_PORT, 8765)
    this.previewPort = port(env.NODETERM_SCIENCE_PREVIEW_PORT, 8766)
    if (this.port === this.previewPort) throw new Error('Science and its previews need separate ports')
    if (env.NODETERM_SCIENCE_PREVIEW_ORIGIN) {
      const u = new URL(env.NODETERM_SCIENCE_PREVIEW_ORIGIN)
      if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) {
        throw new Error('NODETERM_SCIENCE_PREVIEW_ORIGIN must be an HTTPS origin')
      }
      this.previewOrigin = u.origin
    }
    if (env.NODETERM_SCIENCE_APP_ORIGIN) {
      const u = new URL(env.NODETERM_SCIENCE_APP_ORIGIN)
      if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) {
        throw new Error('NODETERM_SCIENCE_APP_ORIGIN must be an HTTPS origin')
      }
      this.appOrigin = u.origin
    }
    if (this.appOrigin && this.appOrigin === this.previewOrigin) throw new Error('Science and its previews need separate origins')
    const localBinary = path.join(os.homedir(), '.local', 'bin', 'claude-science')
    const binary = env.NODETERM_SCIENCE_BIN || (fs.existsSync(localBinary) ? localBinary : 'claude-science')
    const scratch = path.join(userDataDir, 'claude-science-scratch')
    this.run = options.run ?? (async (args) => {
      fs.mkdirSync(scratch, { recursive: true, mode: 0o700 })
      try {
        const result = await execute(binary, [...args, '--data-dir', this.dataDir], {
          timeout: 45_000, maxBuffer: 1024 * 1024, windowsHide: true,
          env: { ...env, TMPDIR: scratch, ...(this.previewOrigin ? { OPERON_SANDBOX_ORIGIN: this.previewOrigin } : {}) }
        })
        return result.stdout
      } catch (e) {
        throw Object.assign(new Error(redactScienceSecrets((e as Error).message).slice(0, 3000)),
          { code: (e as NodeJS.ErrnoException).code })
      }
    })
  }

  async status(): Promise<ClaudeScienceStatus> {
    try {
      const s = JSON.parse(await this.run(['status']))
      return {
        installed: true, running: s.running === true,
        version: typeof s.version === 'string' ? s.version : undefined,
        port: s.running === true && Number.isInteger(s.port) ? s.port : undefined,
        sandboxActive: s.daemon?.sandbox_active,
        previewConfigured: (!!this.previewOrigin && !!this.appOrigin) || !this.basePath
      }
    } catch (e) {
      const missing = (e as NodeJS.ErrnoException).code === 'ENOENT'
      return { installed: !missing, running: false, previewConfigured: (!!this.previewOrigin && !!this.appOrigin) || !this.basePath,
        error: missing ? 'Install Claude Science on this host, then try again.' : 'Could not read Claude Science status.' }
    }
  }

  /** Serializes simultaneous opens: there is exactly one daemon for this data directory. */
  private async ensureRunning(): Promise<void> {
    const status = await this.status()
    if (status.error) throw new Error(status.error)
    if (status.running) {
      if (status.port !== this.port) throw new Error('Science is running on a different port. Stop it before reopening.')
      return
    }
    try {
      await this.run(['serve', '--detached', '--no-browser', '--no-auto-update',
        '--port', String(this.port), '--sandbox-port', String(this.previewPort),
        // The preview server's frame-ancestors policy must also admit the public app front.
        ...(this.appOrigin ? ['--allow-origin', this.appOrigin] : []),
        ...(this.basePath ? ['--base-path', this.basePath] : [])])
    } catch (e) {
      // execFile errors include stdout (and therefore a login nonce). Only return redacted text.
      throw new Error(redactScienceSecrets(String((e as Error).message)).slice(0, 3000))
    }
    const started = await this.status()
    if (!started.running || started.port !== this.port) throw new Error('Claude Science did not start. Check its logs.')
  }

  async open(): Promise<string> {
    if (!this.opening) {
      this.opening = this.ensureRunning().finally(() => { this.opening = undefined })
    }
    await this.opening
    const output = await this.run(['url'])
    const raw = output.match(/https?:\/\/[^\s]+/)?.[0]
    if (!raw) throw new Error('Claude Science did not return a login link.')
    const url = new URL(raw)
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== String(this.port) || !url.searchParams.get('nonce')) {
      throw new Error('Claude Science returned an unexpected login link.')
    }
    // The server proxy strips this prefix. Desktop uses Science directly in a webview.
    return this.basePath ? `${this.basePath}/${url.search}` : url.href
  }

  async stop(): Promise<void> {
    await this.opening
    await this.run(['stop'])
  }

  async logs(): Promise<string> {
    // Science's logs can contain its one-time login links. Never forward those to a log panel.
    return redactScienceSecrets((await this.run(['logs'])).slice(-16_384))
  }
}

export function registerClaudeScience(platform: Pick<CorePlatform, 'handle'>, service: ClaudeScienceService, enabled: () => boolean): void {
  platform.handle(IPC.scienceStatus, async () => ({ ...await service.status(), enabled: enabled() }))
  platform.handle(IPC.scienceOpen, () => {
    if (!enabled()) throw new Error('Allow Claude Science panels in Settings > Agents first.')
    return service.open()
  })
  platform.handle(IPC.scienceStop, () => service.stop())
  platform.handle(IPC.scienceLogs, () => service.logs())
}
