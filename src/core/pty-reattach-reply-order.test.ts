// WARM REATTACH: THE `pty:create` REPLY MUST BEAT THE FIRST OUTPUT FLUSH.
//
// The renderer learns a session's id from the `pty:create` reply and registers its
// `pty:data:<sid>` listener in that reply's continuation — it cannot subscribe earlier, the id does
// not exist yet. tmux, meanwhile, paints the attached screen AND sends its terminal queries
// (DA1/DA2/OSC 10/11/`?996n`) within ~6 ms of the client attaching, and `queueData` flushes them
// FLUSH_MS (8 ms) later. So any await between `spawnSession` and `spawnNew`'s return hands that
// first flush to a channel nobody is listening on: the paint is gone, the queries are gone, xterm
// never answers them, and tmux waits out its 5.000 s TTY_QUERY_TIMEOUT before redrawing.
//
// MEASURED 2026-09-02 (tmux 3.7c): the stale-cwd probe (issue #464, ~50 ms of `display-message` +
// `lsof`) had been placed after the spawn, and every project switch past the park window showed
// blank agent terminals for 5-10 s. The probe now runs BEFORE the attach — the session exists on a
// warm reattach, so its pane can be asked first — and this file pins both halves:
//   (1) the probe's tmux calls precede the node-pty spawn;
//   (2) no `pty:data` reaches the creating client before its `create()` has resolved — and the
//       output is not lost either: it arrives, after the reply.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import { DEFAULT_SETTINGS } from '../shared/types'
import { sessionName } from './tmux-naming'

/** One ordered log of everything that matters: tmux probes, the spawn, the reply, the flush. */
const events: string[] = []

/** What tmux would paint into the fresh client the moment it attaches. */
const PAINT = '\x1b[?1049h\x1b[H\x1b[2JMARKER\x1b[c\x1b[>c'
/** How long the pre-attach probe takes (the real one is 2× display-message + lsof, ~50 ms). */
const PROBE_MS = 30

vi.mock('./session-host-backend', async () =>
  (await import('./__fixtures__/no-session-host')).noSessionHost()
)

vi.mock('node-pty', () => ({
  spawn: () => {
    events.push('spawn')
    return {
      onData: (cb: (d: string) => void) => {
        // tmux paints ~6 ms after attach; the exact figure is irrelevant, only that it is far
        // sooner than the probe's round trips.
        setTimeout(() => cb(PAINT), 1)
      },
      onExit: () => {},
      write: () => {},
      resize: () => {},
      pause: () => {},
      resume: () => {},
      kill: () => {},
      pid: 1
    }
  }
}))

const liveTmuxSessions = new Set<string>()
let paneCurrentPath = os.tmpdir()

vi.mock('child_process', () => {
  type Cb = (err: Error | null, res?: { stdout: string; stderr: string }) => void
  const execFile = (file: string, args: string[], a?: unknown, b?: unknown): unknown => {
    const cb = (typeof a === 'function' ? a : b) as Cb | undefined
    const ok = (stdout: string): void => cb?.(null, { stdout, stderr: '' })
    if (args.includes('has-session')) {
      const target = args[args.indexOf('-t') + 1]
      if (liveTmuxSessions.has(target)) ok('')
      else cb?.(Object.assign(new Error('no such session'), { code: 1 }))
    } else if (args[0] === '-ilc') {
      ok('__NT_PATH_START__/usr/bin:/bin__NT_PATH_END__')
    } else if (args.includes('display-message') && args.includes('#{pane_current_path}')) {
      // The stale-cwd probe. Slow on purpose: this is the await whose position is under test.
      events.push('probe:pane_current_path')
      setTimeout(() => ok(paneCurrentPath), PROBE_MS)
    } else if (args.includes('display-message')) {
      events.push('probe:pane_pid')
      setTimeout(() => ok(''), 2)
    } else {
      ok('')
    }
    return {}
  }
  return { execFile, execFileSync: (): string => '' }
})

vi.mock('./tmux-hint', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tmux-hint')>()),
  findFixedTmux: () => '/usr/bin/tmux'
}))

vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

const CLIENT = 7
const NODE = 'node-reattach-1'

describe('warm reattach: the create reply beats the first output flush', () => {
  let fake: FakePlatform
  let userDataDir: string

  beforeEach(() => {
    events.length = 0
    liveTmuxSessions.clear()
    paneCurrentPath = os.tmpdir()
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-reattach-'))
    fake = fakePlatform({ userDataDir })
    initPlatform(fake)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    resetPlatformForTests()
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
    } catch {
      /* a temp dir we could not remove is not a test result */
    }
  })

  async function tmuxManager() {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager()
    m.init(() => DEFAULT_SETTINGS)
    m.registerIpc()
    return m
  }

  const create = () =>
    fake.handlers[IPC.ptyCreate](CLIENT, { cols: 80, rows: 24, persistKey: NODE }) as Promise<{
      sessionId: string
      fresh: boolean
      staleCwd?: true
    }>

  const paintsSentTo = (sessionId: string) =>
    fake.sent.filter((s) => s.to === CLIENT && s.channel === IPC.ptyData(sessionId))

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  it('probes the pane cwd BEFORE spawning the client, and no output is flushed before the reply', async () => {
    await tmuxManager()
    liveTmuxSessions.add(sessionName(NODE))

    const r = await create()
    events.push('create-resolved')

    expect(r.fresh).toBe(false)
    // (1) ordering: every probe round trip is over before node-pty is asked for the client.
    expect(events.indexOf('probe:pane_current_path')).toBeGreaterThanOrEqual(0)
    expect(events.indexOf('probe:pane_current_path')).toBeLessThan(events.indexOf('spawn'))
    expect(events.indexOf('spawn')).toBeLessThan(events.indexOf('create-resolved'))
    // (2) the moment the renderer gets the reply, nothing has been sent on the data channel yet —
    //     this is the flush the old ordering handed to a listener that did not exist.
    expect(paintsSentTo(r.sessionId)).toHaveLength(0)

    // …and the paint is not LOST, only later: it lands after FLUSH_MS, once a listener can exist.
    await sleep(PROBE_MS + 30)
    const paints = paintsSentTo(r.sessionId)
    expect(paints).toHaveLength(1)
    expect(paints[0].args[0]).toBe(PAINT)
  })

  it('a fresh spawn never runs the probe (there is no pane to ask) and still replies first', async () => {
    await tmuxManager()

    const r = await create()
    events.push('create-resolved')

    expect(r.fresh).toBe(true)
    expect(events.filter((e) => e.startsWith('probe:'))).toHaveLength(0)
    expect(paintsSentTo(r.sessionId)).toHaveLength(0)
    await sleep(30)
    expect(paintsSentTo(r.sessionId)).toHaveLength(1)
  })

  it('moving the probe kept its verdict: a pane on a vanished directory is still flagged stale', async () => {
    await tmuxManager()
    liveTmuxSessions.add(sessionName(NODE))
    paneCurrentPath = path.join(os.tmpdir(), 'nt-reattach-gone', String(process.pid), 'never-made')

    const r = await create()
    expect(r.fresh).toBe(false)
    expect(r.staleCwd).toBe(true)
  })
})
