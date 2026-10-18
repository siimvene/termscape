import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeScienceInstaller } from './claude-science-install'
import { testTmpDir } from './test-tmp'

const bytes = Buffer.from('official fixture runtime')
const checksum = createHash('sha256').update(bytes).digest('hex')
const manifest = { version: '0.1.63', sha256: { 'linux-x64': checksum } }
function fixture(responses: Array<() => Response>) {
  const fetch = vi.fn(async () => {
    const next = responses.shift()
    if (!next) throw new Error('Unexpected download')
    return next()
  })
  const installer = new ClaudeScienceInstaller(testTmpDir('science-install-'), {
    platform: 'linux', arch: 'x64', fetch: fetch as typeof globalThis.fetch
  })
  return { installer, fetch }
}
const json = (value: unknown) => new Response(JSON.stringify(value))

describe('Claude Science user runtime installer', () => {
  it('coalesces downloads, pins the official version, and publishes only checksum-verified bytes', async () => {
    const { installer, fetch } = fixture([() => json(manifest), () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(bytes.subarray(0, 5)); controller.enqueue(bytes.subarray(5)); controller.close() }
    }))])
    const first = installer.install()
    expect(installer.install()).toBe(first)
    expect(installer.installing).toBe(true)
    await first
    expect(installer.installing).toBe(false)
    expect(await fs.readFile(installer.binary)).toEqual(bytes)
    if (process.platform !== 'win32') expect((await fs.stat(installer.binary)).mode & 0o777).toBe(0o700)
    expect(fetch.mock.calls).toEqual([
      ['https://downloads.claude.ai/claude-science/latest/manifest.json', expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) })],
      ['https://downloads.claude.ai/claude-science/0.1.63/linux-x64', expect.objectContaining({ redirect: 'error' })]
    ])
    expect(await fs.readdir(path.dirname(installer.binary))).toEqual(['claude-science'])
  })

  it('never replaces an existing executable with corrupted bytes, removes partial downloads, and allows retry', async () => {
    const { installer } = fixture([
      () => json(manifest), () => new Response('corrupted'),
      () => json(manifest), () => new Response(bytes)
    ])
    await fs.mkdir(path.dirname(installer.binary))
    await fs.writeFile(installer.binary, 'previous runtime')
    await expect(installer.install()).rejects.toThrow('checksum verification failed')
    expect(await fs.readFile(installer.binary, 'utf8')).toBe('previous runtime')
    expect(await fs.readdir(path.dirname(installer.binary))).toEqual(['claude-science'])
    expect(installer.installing).toBe(false)
    await installer.install()
    expect(await fs.readFile(installer.binary)).toEqual(bytes)
  })

  it.each([
    { ...manifest, version: '../../private' },
    { ...manifest, version: 'https://other.test/run' },
    { ...manifest, sha256: { 'linux-x64': 'invalid' } },
    { ...manifest, sha256: {} }
  ])('rejects an invalid manifest before fetching an executable: %j', async (invalid) => {
    const { installer, fetch } = fixture([() => json(invalid)])
    await expect(installer.install()).rejects.toThrow('manifest is invalid')
    expect(fetch).toHaveBeenCalledTimes(1)
    await expect(fs.stat(installer.binary)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    () => new Response(bytes, { status: 503 }),
    () => new Response(bytes, { headers: { 'content-length': String(512 * 1024 * 1024 + 1) } }),
    () => new Response(''),
    () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('connection lost')) } }))
  ])('rejects incomplete, oversized, or failed downloads without leaving an executable', async (response) => {
    const { installer } = fixture([() => json(manifest), response])
    await expect(installer.install()).rejects.toThrow()
    expect(await fs.readdir(path.dirname(installer.binary))).toEqual([])
  })

  it('rejects oversized manifests before allocating their entire contents', async () => {
    const { installer } = fixture([() => new Response(' '.repeat(65 * 1024))])
    await expect(installer.install()).rejects.toThrow('too large')
  })

  it('does not download or invent an executable on an unsupported architecture', async () => {
    const fetch = vi.fn()
    const installer = new ClaudeScienceInstaller('/unused', { platform: 'linux', arch: 'arm64', fetch })
    await expect(installer.install()).rejects.toThrow('no official download for linux-arm64')
    expect(fetch).not.toHaveBeenCalled()
    expect(installer.installing).toBe(false)
  })

  it('uses the Windows executable suffix and isolates runtime paths per Termscape data directory', () => {
    const a = new ClaudeScienceInstaller('/user-a', { platform: 'win32', arch: 'arm64' })
    const b = new ClaudeScienceInstaller('/user-b', { platform: 'darwin', arch: 'arm64' })
    expect(a.binary).toBe(path.join('/user-a', 'science-bin', 'claude-science.exe'))
    expect(b.binary).toBe(path.join('/user-b', 'science-bin', 'claude-science'))
    expect(a.unavailableReason).toBeUndefined()
    expect(b.unavailableReason).toBeUndefined()
  })
})
