import { afterEach, describe, expect, it } from 'vitest'
import net from 'net'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { encodeFrame } from './protocol'
import { trySessionHostHello } from './hello-probe'

const cleanupPaths: string[] = []
const cleanupDirs: string[] = []
afterEach(() => {
  for (const target of cleanupPaths.splice(0)) rmSync(target, { force: true })
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// AF_UNIX paths are capped at ~104-108 bytes (see the same note in paths.ts). os.tmpdir() on
// macOS is a long per-process /var/folders path, so a UUID-suffixed name under it can overflow
// the cap and fail with EINVAL. mkdtemp against the OS's real temp root (macOS: /private/tmp,
// not the long per-process dir) with a short random suffix keeps well under the limit while
// still giving every test its own throwaway namespace.
function testEndpoint(): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\nodeterm-hello-probe-${randomUUID()}`
  const dir = mkdtempSync(path.join('/tmp', 'nt-'))
  cleanupDirs.push(dir)
  const endpoint = path.join(dir, 's.sock')
  cleanupPaths.push(endpoint)
  return endpoint
}

describe('session-host hello liveness probe', () => {
  it('ignores an unrelated ok frame and waits for the exact hello response ID', async () => {
    const endpoint = testEndpoint()
    const server = net.createServer((socket) => {
      socket.once('data', () => {
        socket.write(
          encodeFrame({ id: 999, ok: true }) + encodeFrame({ id: 0, ok: false, error: 'wrong token' })
        )
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(endpoint, resolve)
    })
    try {
      await expect(trySessionHostHello(endpoint, 'not-the-token', 1_000)).resolves.toBe(false)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('keeps waiting after an unrelated ok until the delayed exact ID succeeds', async () => {
    const endpoint = testEndpoint()
    const server = net.createServer((socket) => {
      socket.once('data', () => {
        socket.write(encodeFrame({ id: 999, ok: true }))
        setTimeout(() => socket.write(encodeFrame({ id: 0, ok: true })), 20)
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(endpoint, resolve)
    })
    try {
      await expect(trySessionHostHello(endpoint, 'token', 1_000)).resolves.toBe(true)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('accepts the exact correlated ok response', async () => {
    const endpoint = testEndpoint()
    const server = net.createServer((socket) => {
      socket.once('data', () => socket.write(encodeFrame({ id: 0, ok: true })))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(endpoint, resolve)
    })
    try {
      await expect(trySessionHostHello(endpoint, 'token', 1_000)).resolves.toBe(true)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
