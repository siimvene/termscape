// THE STALE-CWD SIGNAL, PROVEN AGAINST A REAL TMUX (issue #464).
//
// Unit tests pin what `classifyPaneCwd` does with an answer; whether tmux actually gives that
// answer for a session whose start directory was deleted — and keeps giving it after a same-named
// directory is re-created (a DIFFERENT inode, the whole point of the issue) — is a property of
// tmux and the kernel, so it is measured here on a private socket, exactly like the other
// realtmux suites.
//
// Also proven, because the issue asks it explicitly: a NEW session created after the re-creation
// starts in the re-created directory — the spawn path was never the broken half.
//
// The two platforms answer through DIFFERENT signals and both are asserted here, because the
// guarantee ("a pane on a deleted inode is reported stale") is the product's, not tmux's: on Linux
// tmux passes `/proc`'s " (deleted)" suffix through, and on macOS (MEASURED 2026-09-02, tmux 3.7c)
// tmux's string is byte-identical to a healthy pane's, so the verdict rides the pane process's own
// cwd inode instead. Everything below runs the same probes the product runs, in the same order.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { classifyPaneCwd, lsofCwdLinked, type PaneCwdVerdict } from './pane-cwd'
import { makeTmuxTmpdir } from './tmux-test-socket'

const SOCKET = `nt-cwd-${process.pid}`

let tmp: string
let tmuxOk = false

function tmux(args: string[], opts?: { cwd?: string }): string {
  return execFileSync('tmux', ['-L', SOCKET, ...args], {
    env: { ...process.env, TMUX_TMPDIR: tmp },
    cwd: opts?.cwd,
    stdio: ['ignore', 'pipe', 'pipe']
  }).toString()
}

/** The exact probe `PtyManager.paneCwdStale` runs: exact-match target, one format. The trailing
 *  colon is load-bearing and MEASURED here (tmux 3.4): a bare `=name` target-pane resolves
 *  NOTHING silently — exit 0, every format empty — while `=name:` is "exactly this session, its
 *  active pane". The first assertion below (`'ok'`, not `'unknown'`) is what pins it. */
function panePath(session: string): string {
  return tmux(['display-message', '-p', '-t', `=${session}:`, '#{pane_current_path}']).replace(
    /\r?\n$/,
    ''
  )
}

const dirExists = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

const statDir = (p: string): { dev: number; ino: number } | undefined => {
  try {
    const st = fs.statSync(p)
    return st.isDirectory() ? { dev: st.dev, ino: st.ino } : undefined
  } catch {
    return undefined
  }
}

/** The OTHER half of `PtyManager.paneCwdStale`, darwin only: tmux's string cannot see an unlinked
 *  cwd on macOS (MEASURED in the first test below), so the pane's own process is asked and parsed
 *  by the same `lsofCwdLinked` the product uses. `undefined` everywhere else — on Linux the
 *  `/proc` readlink already carries the whole signal, and the product passes `undefined` there
 *  too. */
function paneCwdLinked(session: string): boolean | undefined {
  if (process.platform !== 'darwin') return undefined
  const pid = tmux(['display-message', '-p', '-t', `=${session}:`, '#{pane_pid}']).trim()
  const out = execFileSync('/usr/sbin/lsof', ['-a', '-p', pid, '-d', 'cwd', '-FDin'], {
    stdio: ['ignore', 'pipe', 'pipe']
  }).toString()
  return lsofCwdLinked(out, statDir)
}

/** The verdict the product reaches for a live session, mirroring `PtyManager.paneCwdStale` argument
 *  for argument: tmux's string first, plus — on darwin, where that string is blind — the pane
 *  process's own cwd identity. */
function verdict(session: string, reported: string): PaneCwdVerdict {
  return classifyPaneCwd(reported, dirExists, process.platform, paneCwdLinked(session))
}

beforeAll(() => {
  if (process.platform === 'win32') return // no tmux on Windows — the session host owns that world
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    tmuxOk = true
  } catch {
    return // no tmux on this host — every test below self-skips
  }
  tmp = makeTmuxTmpdir('ntcwd-', SOCKET)
})

afterAll(() => {
  if (!tmuxOk) return
  try {
    tmux(['kill-server'])
  } catch {
    /* already gone */
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('pane_current_path across delete → recreate (real tmux)', () => {
  it('a deleted-then-recreated start dir stays STALE for the live session, and a healthy one is ok', () => {
    if (!tmuxOk) return
    const dir = path.join(tmp, 'proj')
    fs.mkdirSync(dir)
    // `sleep` rather than an interactive shell: the pane's process-group leader holds the cwd and
    // sits still, so the measurement has no prompt/rc-file noise in it.
    // `-f /dev/null` on the server-starting call: a contributor's ~/.tmux.conf must not join the
    // measurement (the private socket makes this call the one that boots the server).
    tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'victim', '-c', dir, 'sleep 60'])

    // Healthy: tmux names the directory, it exists, and the pane process really is in it — the
    // identity probe must not manufacture a banner for a perfectly fine pane.
    expect(paneCwdLinked('victim')).toBe(process.platform === 'darwin' ? true : undefined)
    expect(verdict('victim', panePath('victim'))).toBe('ok')

    // Deleted: the shell keeps the inode; the classifier must call it stale.
    fs.rmSync(dir, { recursive: true, force: true })
    const afterDelete = panePath('victim')
    expect(verdict('victim', afterDelete)).toBe('stale')

    // Recreated at the same path — a different inode, so nothing self-heals. This is the exact
    // reported state: the folder EXISTS again, and the verdict must still be stale.
    fs.mkdirSync(dir)
    const afterRecreate = panePath('victim')
    expect(dirExists(dir)).toBe(true)
    expect(verdict('victim', afterRecreate)).toBe('stale')
    if (process.platform === 'darwin') {
      // The measured macOS signal, pinned for the same reason the Linux one below is. tmux's
      // string is NOT it: `osdep-darwin.c` reads the cwd with
      // `proc_pidinfo(PROC_PIDVNODEPATHINFO)`, and the kernel keeps naming the UNLINKED directory
      // by its old path, so the answer is byte-identical to the healthy one above and the string
      // rules alone can only say 'ok' (measured on tmux 3.7c / macOS 27 — while `/bin/pwd` inside
      // that very pane fails with "No such file or directory"). What carries the verdict is the
      // pane process's own cwd inode. If a future tmux/kernel starts marking the unlinked cwd,
      // the first assertion here goes red — that is the signal to re-read this comment, not to
      // delete the identity probe, which stays correct either way.
      expect(afterRecreate.endsWith(' (deleted)')).toBe(false)
      expect(classifyPaneCwd(afterRecreate, dirExists)).toBe('ok')
      expect(paneCwdLinked('victim')).toBe(false)
    }
    if (process.platform === 'linux') {
      // The measured Linux signal, pinned so a kernel/tmux change that stops emitting it turns
      // this suite red instead of silently disabling the banner: /proc's readlink names the dead
      // inode with the " (deleted)" suffix, before AND after the same-named mkdir.
      expect(afterDelete.endsWith(' (deleted)')).toBe(true)
      expect(afterRecreate.endsWith(' (deleted)')).toBe(true)
    }
  })

  it('a NEW session created after the recreation starts in the recreated directory', () => {
    if (!tmuxOk) return
    const dir = path.join(tmp, 'proj2')
    fs.mkdirSync(dir)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir)
    tmux(['new-session', '-d', '-s', 'fresh', '-c', dir, 'sleep 60'])
    const reported = panePath('fresh')
    expect(verdict('fresh', reported)).toBe('ok')
    expect(fs.realpathSync(reported)).toBe(fs.realpathSync(dir))
  })
})
