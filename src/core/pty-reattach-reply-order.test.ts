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
/** Fired when the probe is in flight — the window in which another client can act. */
let duringProbe: (() => void) | null = null
/** The literal `-l` payloads the stale-cwd heal typed into the pane (the `cd` repair command). */
const sentKeys: string[] = []
/** Force the repair's send-keys to fail, to exercise the banner backstop. */
let failRepair = false
/** What the heal's `#{pane_in_mode}` / `#{pane_current_command}` guard probe reports. */
let paneInMode = '0'
let paneForegroundCmd = 'zsh'

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
      duringProbe?.()
      setTimeout(() => ok(paneCurrentPath), PROBE_MS)
    } else if (args.some((a) => a.includes('pane_current_command'))) {
      // The heal's foreground/copy-mode guard: `#{pane_in_mode}\t#{pane_current_command}`.
      events.push('probe:pane_state')
      ok(`${paneInMode}\t${paneForegroundCmd}`)
    } else if (args.includes('display-message')) {
      events.push('probe:pane_pid')
      setTimeout(() => ok(''), 2)
    } else if (args.includes('send-keys')) {
      // The stale-cwd heal: a literal (`-l`) `cd` payload, then a bare `Enter` to run it.
      const li = args.indexOf('-l')
      if (li >= 0) {
        events.push('repair:send-keys')
        sentKeys.push(args[li + 1])
      } else if (args.includes('Enter')) {
        events.push('repair:enter')
      }
      if (failRepair) cb?.(Object.assign(new Error('send-keys failed'), { code: 1 }))
      else ok('')
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
  let managers: Array<{ killAll(): Promise<void> }> = []

  beforeEach(() => {
    events.length = 0
    liveTmuxSessions.clear()
    paneCurrentPath = os.tmpdir()
    duringProbe = null
    sentKeys.length = 0
    failRepair = false
    paneInMode = '0'
    paneForegroundCmd = 'zsh'
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-reattach-'))
    fake = fakePlatform({ userDataDir })
    initPlatform(fake)
  })
  afterEach(async () => {
    // Stop the manager's snapshot/reap intervals before the platform goes away.
    for (const m of managers) await m.killAll()
    managers = []
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
    managers.push(m)
    return m
  }
  type WithTombstone = { tombstone(persistKey: string, by: number): void }

  const create = () =>
    fake.handlers[IPC.ptyCreate](CLIENT, { cols: 80, rows: 24, persistKey: NODE }) as Promise<{
      sessionId: string
      fresh: boolean
      staleCwd?: true
    }>

  const paintsSentTo = (sessionId: string) =>
    fake.sent.filter((s) => s.to === CLIENT && s.channel === IPC.ptyData(sessionId))

  /** Poll until `pred` holds (bounded). Preferred over a fixed sleep: the flush is a timer the
   *  test does not own, so "wait for the observable" cannot be starved into a false failure. */
  const until = async (pred: () => boolean, ms = 1000): Promise<void> => {
    const deadline = Date.now() + ms
    while (!pred()) {
      if (Date.now() > deadline) throw new Error('condition not reached in time')
      await new Promise<void>((r) => setTimeout(r, 5))
    }
  }
  /** Every test that spawned must drain the fake pty's 1 ms paint + 8 ms flush before teardown
   *  resets the platform — a flush landing on an uninitialized platform would throw out of a
   *  timer, outside any test. */
  const drained = (sessionId: string) => until(() => paintsSentTo(sessionId).length === 1)

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
    await drained(r.sessionId)
    expect(paintsSentTo(r.sessionId)[0].args[0]).toBe(PAINT)
  })

  it('a fresh spawn never runs the probe (there is no pane to ask) and still replies first', async () => {
    await tmuxManager()

    const r = await create()
    events.push('create-resolved')

    expect(r.fresh).toBe(true)
    expect(events.filter((e) => e.startsWith('probe:'))).toHaveLength(0)
    expect(paintsSentTo(r.sessionId)).toHaveLength(0)
    await drained(r.sessionId)
  })

  it('a pane on a vanished directory is auto-healed before reattach: a cd is sent, banner suppressed', async () => {
    await tmuxManager()
    liveTmuxSessions.add(sessionName(NODE))
    paneCurrentPath = path.join(os.tmpdir(), 'nt-reattach-gone', String(process.pid), 'never-made')

    const r = await create()
    expect(r.fresh).toBe(false)
    // The guard probe, the literal cd, then Enter — all BEFORE the client is spawned (so they can
    // never collide with the renderer's later agent launch, and add no post-spawn await).
    expect(events.indexOf('probe:pane_state')).toBeLessThan(events.indexOf('repair:send-keys'))
    expect(events.indexOf('repair:send-keys')).toBeLessThan(events.indexOf('repair:enter'))
    expect(events.indexOf('repair:enter')).toBeLessThan(events.indexOf('spawn'))
    // The exact command: cwd single-quoted (create() passes none here, so $HOME), with the
    // 2>/dev/null and double-quoted $HOME fallback for a cwd that is itself gone.
    expect(sentKeys).toEqual([`cd '${os.homedir()}' 2>/dev/null || cd "$HOME"`])
    // A clean heal suppresses the manual "recycle + respawn" banner.
    expect(r.staleCwd).toBeUndefined()
    await drained(r.sessionId)
  })

  it('declines to heal a pane in copy-mode (send-keys would be swallowed): banner stays', async () => {
    await tmuxManager()
    liveTmuxSessions.add(sessionName(NODE))
    paneCurrentPath = path.join(os.tmpdir(), 'nt-reattach-gone', String(process.pid), 'never-made')
    paneInMode = '1'

    const r = await create()
    expect(r.fresh).toBe(false)
    expect(events).not.toContain('repair:send-keys')
    expect(sentKeys).toHaveLength(0)
    expect(r.staleCwd).toBe(true)
    await drained(r.sessionId)
  })

  it('declines to heal a pane whose foreground is a TUI, not a shell: banner stays', async () => {
    await tmuxManager()
    liveTmuxSessions.add(sessionName(NODE))
    paneCurrentPath = path.join(os.tmpdir(), 'nt-reattach-gone', String(process.pid), 'never-made')
    paneForegroundCmd = 'nvim'

    const r = await create()
    expect(r.fresh).toBe(false)
    expect(events).not.toContain('repair:send-keys')
    expect(r.staleCwd).toBe(true)
    await drained(r.sessionId)
  })

  it('a stale pane whose repair send FAILS still raises the banner as the backstop', async () => {
    await tmuxManager()
    liveTmuxSessions.add(sessionName(NODE))
    paneCurrentPath = path.join(os.tmpdir(), 'nt-reattach-gone', String(process.pid), 'never-made')
    failRepair = true

    const r = await create()
    expect(r.fresh).toBe(false)
    expect(r.staleCwd).toBe(true)
    await drained(r.sessionId)
  })

  it('a delete that lands while the probe is in flight still wins: no spawn, the create is refused', async () => {
    // The probe is an await between create()'s tombstone check and the spawn, and spawnSession
    // CLEARS a tombstone for the tmux session it attaches. So a delete racing into that window
    // must be re-asked immediately before the spawn, or the create resurrects what was deleted.
    const m = await tmuxManager()
    liveTmuxSessions.add(sessionName(NODE))
    const OTHER = 99
    duringProbe = () => (m as unknown as WithTombstone).tombstone(NODE, OTHER)

    const r = await create()
    expect(r.sessionId).toBe('')
    expect((r as { closed?: { by: number | null } }).closed).toEqual({ by: OTHER })
    expect(events).not.toContain('spawn')
  })

  it('the SAME client deleting mid-create is a later intent, not a resurrection: refused too', async () => {
    // create()'s pre-flight exempts the owner so a deliberate delete-then-recreate works; that
    // exemption must not let a create that was already in flight when the delete landed undo it.
    const m = await tmuxManager()
    liveTmuxSessions.add(sessionName(NODE))
    duringProbe = () => (m as unknown as WithTombstone).tombstone(NODE, CLIENT)

    const r = await create()
    expect(r.sessionId).toBe('')
    expect((r as { closed?: { by: number | null } }).closed).toEqual({ by: CLIENT })
    expect(events).not.toContain('spawn')
  })

  it('a tombstone that PREDATES the create keeps the owner-resurrection contract: the owner may recreate', async () => {
    const m = await tmuxManager()
    liveTmuxSessions.add(sessionName(NODE))
    ;(m as unknown as WithTombstone).tombstone(NODE, CLIENT)

    const r = await create()
    expect(r.sessionId).not.toBe('')
    expect(events).toContain('spawn')
    await drained(r.sessionId)
  })
})
