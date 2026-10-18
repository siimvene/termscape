import { createHash, randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { renameAtomic } from './fs-atomic'

const DOWNLOADS = 'https://downloads.claude.ai/claude-science'
const MAX_BINARY_BYTES = 512 * 1024 * 1024
const TARGETS = new Set(['linux-x64', 'darwin-x64', 'darwin-arm64', 'windows-x64', 'windows-arm64'])

/** A user-owned runtime, separate from Science's projects and credentials. No privileged installer. */
export class ClaudeScienceInstaller {
  readonly binary: string
  readonly unavailableReason?: string
  private pending?: Promise<void>
  private readonly target: string
  private readonly fetch: typeof globalThis.fetch

  constructor(userDataDir: string, options: {
    platform?: NodeJS.Platform; arch?: string; fetch?: typeof globalThis.fetch
  } = {}) {
    const platform = options.platform ?? process.platform
    this.target = `${platform === 'win32' ? 'windows' : platform}-${options.arch ?? process.arch}`
    this.binary = path.join(userDataDir, 'science-bin', platform === 'win32' ? 'claude-science.exe' : 'claude-science')
    this.fetch = options.fetch ?? globalThis.fetch
    if (!TARGETS.has(this.target)) this.unavailableReason = `Claude Science has no official download for ${this.target}.`
  }

  get installing(): boolean { return !!this.pending }

  install(): Promise<void> {
    if (this.unavailableReason) return Promise.reject(new Error(this.unavailableReason))
    // Multiple panels reuse the same download; merely restoring a panel never downloads anything.
    if (!this.pending) this.pending = this.download().finally(() => { this.pending = undefined })
    return this.pending
  }

  private async download(): Promise<void> {
    const signal = AbortSignal.timeout(5 * 60_000)
    const request = async (url: string): Promise<Response> => {
      // Both URLs are constructed here, never supplied by the renderer or manifest. Do not follow
      // redirects to arbitrary hosts, including an authenticated user's private network.
      const response = await this.fetch(url, { signal, redirect: 'error' })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`Claude Science download failed (HTTP ${response.status}). Try installing again.`)
      }
      return response
    }
    const read = async (response: Response, max: number, consume: (bytes: Uint8Array) => Promise<void>): Promise<void> => {
      if (!response.body) throw new Error('Claude Science download was empty.')
      const reader = response.body.getReader()
      let size = 0
      try {
        if (Number(response.headers.get('content-length')) > max) throw new Error('Claude Science download is too large.')
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > max) throw new Error('Claude Science download is too large.')
          await consume(value)
        }
        if (!size) throw new Error('Claude Science download was empty.')
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    }
    const chunks: Buffer[] = []
    await read(await request(`${DOWNLOADS}/latest/manifest.json`), 64 * 1024, async (bytes) => { chunks.push(Buffer.from(bytes)) })
    const manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const version: unknown = manifest?.version
    const checksum: unknown = manifest?.sha256?.[this.target]
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version) ||
        typeof checksum !== 'string' || !/^[a-f0-9]{64}$/i.test(checksum)) {
      throw new Error('The official Claude Science download manifest is invalid or has no download for this host.')
    }
    await fs.mkdir(path.dirname(this.binary), { recursive: true, mode: 0o700 })
    const temporary = `${this.binary}.${randomUUID()}.download`
    try {
      const file = await fs.open(temporary, 'wx', 0o600)
      const hash = createHash('sha256')
      try {
        // Pin the version so a new release between the manifest and binary requests cannot race.
        await read(await request(`${DOWNLOADS}/${version}/${this.target}`), MAX_BINARY_BYTES, async (bytes) => {
          hash.update(bytes)
          await file.writeFile(bytes)
        })
        if (hash.digest('hex') !== checksum.toLowerCase()) throw new Error('Claude Science checksum verification failed. Try installing again.')
        await file.sync()
      } finally { await file.close() }
      await fs.chmod(temporary, 0o700)
      await renameAtomic(temporary, this.binary)
    } finally { await fs.rm(temporary, { force: true }) }
  }
}
