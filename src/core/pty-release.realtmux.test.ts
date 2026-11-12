import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createRequire } from 'module'
import fs from 'fs'
import { releasePty } from './pty-release'
import { makeTmuxTmpdir } from './tmux-test-socket'

const SOCKET = `nt-release-${process.pid}`
const SESSION = 'release-survivor'
const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    return process.platform !== 'win32'
  } catch {
    return false
  }
})()
let nativePty: typeof import('node-pty') | null = null
try {
  nativePty = createRequire(import.meta.url)('node-pty')
} catch {
  // Electron-only native builds cannot be loaded by the Node test runner.
}

describe.skipIf(!hasTmux)('real tmux attachment release', () => {
  let tmp: string
  const children = new Set<ChildProcessWithoutNullStreams>()
  const env = () => ({ ...process.env, TMUX_TMPDIR: tmp })
  const tmux = (args: string[]) =>
    execFileSync('tmux', ['-L', SOCKET, ...args], {
      env: env(), encoding: 'utf8', timeout: 3000
    }).trim()

  beforeAll(() => {
    tmp = makeTmuxTmpdir('ntrelease-', SOCKET)
    tmux(['-f', '/dev/null', 'new-session', '-d', '-s', SESSION, 'sleep 120'])
  })

  afterAll(() => {
    for (const child of children) child.kill('SIGKILL')
    try {
      if (tmp) tmux(['kill-server'])
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('reaps unresponsive clients across reconnects without killing the server or pane', async () => {
    const identity = () => tmux(['display-message', '-p', '-t', SESSION, '#{pid}:#{pane_pid}'])
    const original = identity()
    const panePid = Number(original.split(':')[1])

    for (let cycle = 0; cycle < 3; cycle++) {
      const child = spawn('tmux', ['-L', SOCKET, '-C', 'attach-session', '-t', `=${SESSION}`], {
        env: env(), stdio: ['pipe', 'pipe', 'pipe']
      })
      children.add(child)
      child.stdout.resume()
      child.stderr.resume()
      let exited = false
      let spawnError: Error | undefined
      const exit = new Promise<NodeJS.Signals | null>((resolve) => {
        child.once('error', (error) => { spawnError = error })
        child.once('exit', (_code, signal) => {
          exited = true
          children.delete(child)
          resolve(signal)
        })
      })
      try {
        await expect.poll(() => {
          if (spawnError) throw spawnError
          return tmux(['list-clients', '-F', '#{client_pid}']).split('\n')
        }, { timeout: 3000 }).toContain(String(child.pid))

        // A stopped event loop cannot service HUP/TERM, just like the incident's spinning client.
        child.kill('SIGSTOP')
        releasePty({
          resume: () => child.stdout.resume(),
          kill: (signal) => { child.kill(signal as NodeJS.Signals) },
          destroy: () => {
            child.stdin.destroy()
            child.stdout.destroy()
            child.stderr.destroy()
            child.kill('SIGHUP')
          }
        }, { forceKill: true })

        await expect.poll(() => exited, { timeout: 3000 }).toBe(true)
        expect(await exit).toBe('SIGKILL')
        await expect.poll(() => tmux(['list-clients', '-F', '#{client_pid}'])).toBe('')
        expect(identity()).toBe(original)
        expect(() => process.kill(panePid, 0)).not.toThrow()
      } finally {
        if (!exited) child.kill('SIGKILL')
      }
    }
  }, 15000)

  it.skipIf(!nativePty)('releases real node-pty foreground clients and reattaches to the same pane', async () => {
    const identity = () => tmux(['display-message', '-p', '-t', SESSION, '#{pid}:#{pane_pid}'])
    const original = identity()
    for (let cycle = 0; cycle < 3; cycle++) {
      const proc = nativePty!.spawn('tmux', ['-L', SOCKET, 'attach-session', '-t', `=${SESSION}`], {
        env: env(), name: 'xterm-256color', cols: 80, rows: 24
      })
      let exited = false
      proc.onData(() => {})
      proc.onExit(() => { exited = true })
      try {
        await expect.poll(() => tmux(['list-clients', '-F', '#{client_pid}']).split('\n'), {
          timeout: 3000
        }).toContain(String(proc.pid))
        process.kill(proc.pid, 'SIGSTOP')
        releasePty(proc, { forceKill: true })
        await expect.poll(() => exited, { timeout: 3000 }).toBe(true)
        await expect.poll(() => tmux(['list-clients', '-F', '#{client_pid}'])).toBe('')
        expect(identity()).toBe(original)
      } finally {
        if (!exited) releasePty(proc, { forceKill: true })
      }
    }
  }, 15000)
})
