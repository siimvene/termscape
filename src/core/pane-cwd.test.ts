import { describe, it, expect } from 'vitest'
import { classifyPaneCwd, lsofCwdLinked } from './pane-cwd'

const exists = (): boolean => true
const missing = (): boolean => false

describe('classifyPaneCwd (issue #464 — stale cwd after delete/recreate)', () => {
  it('a live directory is ok', () => {
    expect(classifyPaneCwd('/home/user/project', exists, 'linux')).toBe('ok')
    expect(classifyPaneCwd('/home/user/project', exists, 'darwin')).toBe('ok')
  })

  it('the Linux "(deleted)" readlink suffix is stale — even when a same-named dir exists again', () => {
    // MEASURED (tmux 3.4, Linux): after `rm -rf dir && mkdir dir`, `#{pane_current_path}` still
    // reports `dir (deleted)` — the readlink names the inode the shell holds, not the path. The
    // recreated directory existing must NOT launder the verdict, so `exists` answers true here.
    expect(classifyPaneCwd('/home/user/project (deleted)', exists, 'linux')).toBe('stale')
  })

  it('a reported path that is gone from disk is stale (deleted, not yet recreated)', () => {
    expect(classifyPaneCwd('/home/user/project', missing, 'linux')).toBe('stale')
    expect(classifyPaneCwd('/home/user/project', missing, 'darwin')).toBe('stale')
  })

  it('an empty answer is stale ONLY on darwin', () => {
    // darwin: proc_pidinfo cannot name an unlinked cwd vnode, so tmux answers empty (inferred
    // from tmux's osdep-darwin.c — the PR's device checklist owes the on-device measurement).
    expect(classifyPaneCwd('', exists, 'darwin')).toBe('stale')
    // Elsewhere, empty means "tmux could not say" (an osdep with no cwd reader, a transient
    // tcgetpgrp failure). Flagging every terminal on such a platform would be a wrong fact on
    // screen, so the verdict degrades to nothing.
    expect(classifyPaneCwd('', exists, 'linux')).toBe('unknown')
    expect(classifyPaneCwd('', exists, 'freebsd')).toBe('unknown')
  })

  it('a non-absolute answer is unknown, never judged', () => {
    expect(classifyPaneCwd('not a path', missing, 'linux')).toBe('unknown')
  })

  it('a path ending in spaces is judged as-is (no trimming)', () => {
    let asked = ''
    const record = (p: string): boolean => {
      asked = p
      return true
    }
    expect(classifyPaneCwd('/tmp/dir with trailing  ', record, 'linux')).toBe('ok')
    expect(asked).toBe('/tmp/dir with trailing  ')
  })

  it('an unlinked pane cwd outranks every string rule — including a healthy-looking path', () => {
    // The darwin case (MEASURED, tmux 3.7c): tmux names the UNLINKED directory by its old path,
    // so the string is indistinguishable from a healthy pane and only the identity answer can
    // reach the banner. `undefined` (nobody asked / not evidence) must change nothing.
    expect(classifyPaneCwd('/home/user/project', exists, 'darwin', false)).toBe('stale')
    expect(classifyPaneCwd('/home/user/project', exists, 'linux', false)).toBe('stale')
    expect(classifyPaneCwd('', exists, 'linux', false)).toBe('stale')
    expect(classifyPaneCwd('/home/user/project', exists, 'darwin', true)).toBe('ok')
    expect(classifyPaneCwd('/home/user/project', exists, 'darwin', undefined)).toBe('ok')
  })

  it('a throwing-free contract: dirExists is only consulted for plain absolute paths', () => {
    // The "(deleted)" branch never stats — the suffix IS the verdict, and statting the suffixed
    // string would be statting a name that never existed.
    const boom = (): boolean => {
      throw new Error('must not be called')
    }
    expect(classifyPaneCwd('/x (deleted)', boom, 'linux')).toBe('stale')
    expect(classifyPaneCwd('', boom, 'darwin')).toBe('stale')
  })
})

describe('lsofCwdLinked (the darwin identity signal)', () => {
  // Real `lsof -a -p <pid> -d cwd -FDin` output, captured on macOS 27 — the healthy and the
  // unlinked pane differ ONLY in the inode, which is the whole reason this comparison exists.
  const LSOF = (ino: number): string =>
    `p90426\nfcwd\nD0x1000012\ni${ino}\nn/private/tmp/proj\n`
  const onDisk = { dev: 0x1000012, ino: 24350991 }
  const statDir = (p: string): { dev: number; ino: number } | undefined =>
    p === '/private/tmp/proj' ? onDisk : undefined

  it('same inode at that name = the process is where it says it is', () => {
    expect(lsofCwdLinked(LSOF(onDisk.ino), statDir)).toBe(true)
  })

  it('a different inode at the same name = an unlinked (deleted-and-recreated) directory', () => {
    expect(lsofCwdLinked(LSOF(24350987), statDir)).toBe(false)
  })

  it('a different device at the same name is a different directory too', () => {
    const other = `p1\nfcwd\nD0x2000099\ni${onDisk.ino}\nn/private/tmp/proj\n`
    expect(lsofCwdLinked(other, statDir)).toBe(false)
  })

  it('nothing readable is never evidence — no banner on a guess', () => {
    expect(lsofCwdLinked('', statDir)).toBeUndefined() // dead pane: lsof exits 1, prints nothing
    expect(lsofCwdLinked('p1\nfcwd\nn/private/tmp/proj\n', statDir)).toBeUndefined() // no inode
    expect(lsofCwdLinked(`p1\nfcwd\ni${onDisk.ino}\n`, statDir)).toBeUndefined() // no name
    expect(lsofCwdLinked(`p1\nfcwd\ni${onDisk.ino}\nnrelative\n`, statDir)).toBeUndefined()
    // The name is gone from disk entirely: `classifyPaneCwd`'s own rules already judge that case,
    // and answering "unlinked" from a failed stat would put a banner on a mangled parse.
    expect(lsofCwdLinked(`p1\nfcwd\ni${onDisk.ino}\nn/gone\n`, statDir)).toBeUndefined()
  })

  it('a device field lsof omitted is skipped, not read as a mismatch', () => {
    expect(lsofCwdLinked(`p1\nfcwd\ni${onDisk.ino}\nn/private/tmp/proj\n`, statDir)).toBe(true)
  })
})
