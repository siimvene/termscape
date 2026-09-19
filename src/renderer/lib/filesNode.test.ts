import { describe, expect, it } from 'vitest'
import {
  breadcrumbs,
  childPath,
  classifyEmptyListing,
  displacedFilesPatch,
  fileOpenTarget,
  filterEntries,
  folderTitle,
  parentDir
} from './filesNode'

describe('breadcrumbs', () => {
  it('walks a shallow path in full', () => {
    expect(breadcrumbs('/a/b')).toEqual([
      { name: '/', path: '/' },
      { name: 'a', path: '/a' },
      { name: 'b', path: '/a/b' }
    ])
  })

  it('is just root at the root', () => {
    expect(breadcrumbs('/')).toEqual([{ name: '/', path: '/' }])
  })

  it('collapses a deep path but keeps every crumb navigable', () => {
    const crumbs = breadcrumbs('/one/two/three/four/five/six', 3)
    expect(crumbs.map((c) => c.name)).toEqual(['/', '…', 'four', 'five', 'six'])
    // The ellipsis is not decoration: it goes to the deepest directory it hid, so a user can
    // climb back out one level at a time instead of being teleported to root.
    expect(crumbs[1].path).toBe('/one/two/three')
    expect(crumbs[crumbs.length - 1].path).toBe('/one/two/three/four/five/six')
  })

  it('does not collapse a path that exactly fits', () => {
    expect(breadcrumbs('/a/b/c', 3).map((c) => c.name)).toEqual(['/', 'a', 'b', 'c'])
  })
})

describe('folderTitle', () => {
  it('names the directory', () => expect(folderTitle('/home/me/repo')).toBe('repo'))
  it('names the root', () => expect(folderTitle('/')).toBe('/'))
  it('ignores a trailing slash', () => expect(folderTitle('/home/me/repo/')).toBe('repo'))
})

describe('childPath', () => {
  it('joins normally', () => expect(childPath('/a/b', 'c.ts')).toBe('/a/b/c.ts'))
  it('does not double the separator at the root', () => expect(childPath('/', 'etc')).toBe('/etc'))
  it('absorbs a trailing slash', () => expect(childPath('/a/', 'b')).toBe('/a/b'))
})

describe('parentDir', () => {
  it('climbs one level', () => expect(parentDir('/a/b/c')).toBe('/a/b'))
  it('stops at the root', () => expect(parentDir('/a')).toBe('/'))
  it('stays at the root', () => expect(parentDir('/')).toBe('/'))
})

describe('filterEntries', () => {
  const entries = [{ name: 'README.md' }, { name: 'src' }, { name: 'package.json' }]

  it('matches case-insensitively anywhere in the name', () => {
    expect(filterEntries(entries, 'age').map((e) => e.name)).toEqual(['package.json'])
    expect(filterEntries(entries, 'readme').map((e) => e.name)).toEqual(['README.md'])
  })

  // The bug this pins: select-all + delete leaves '' (or a stray space), and a filter that treats
  // that as "match nothing" blanks the whole listing with no way to tell why.
  it('matches everything for an empty or whitespace query', () => {
    expect(filterEntries(entries, '')).toEqual(entries)
    expect(filterEntries(entries, '   ')).toEqual(entries)
  })

  it('can legitimately match nothing', () => {
    expect(filterEntries(entries, 'zzz')).toEqual([])
  })
})

describe('fileOpenTarget', () => {
  it('opens text and images on the canvas', () => {
    expect(fileOpenTarget('/a/notes.md')).toBe('canvas')
    expect(fileOpenTarget('/a/logo.png')).toBe('canvas')
    expect(fileOpenTarget('/a/Makefile')).toBe('canvas')
  })

  it('opens video on the canvas (the video node, not Monaco)', () => {
    expect(fileOpenTarget('/a/clip.mp4')).toBe('canvas')
    expect(fileOpenTarget('/a/clip.mov')).toBe('canvas')
  })

  it('hands binaries and archives to the OS', () => {
    expect(fileOpenTarget('/a/installer.dmg')).toBe('os')
    expect(fileOpenTarget('/a/bundle.zip')).toBe('os')
    expect(fileOpenTarget('/a/data.sqlite')).toBe('os')
  })

  // shell.openPath opens a path on THIS machine. For a remote listing that is either a silent
  // no-op or, if the path happens to exist locally too, an unrelated local file.
  it('never hands a remote path to the OS', () => {
    expect(fileOpenTarget('/a/installer.dmg', { remote: true })).toBe('canvas')
    expect(fileOpenTarget('/a/bundle.zip', { remote: true })).toBe('canvas')
    expect(fileOpenTarget('/a/notes.md', { remote: true })).toBe('canvas')
  })
})

describe('classifyEmptyListing', () => {
  const parent = [{ name: 'docs' }, { name: 'src' }, { name: 'README.md' }]

  // The case the fourth empty state exists for, and could not reach before: a removed worktree.
  // `listDir` answers [] for a directory that is gone, exactly as it does for an empty one.
  it('says missing when the parent lists real entries and ours is not among them', () => {
    expect(classifyEmptyListing('/repo/gone', parent)).toBe('missing')
  })

  it('says empty when the parent lists us — the folder is there and simply has nothing in it', () => {
    expect(classifyEmptyListing('/repo/docs', parent)).toBe('empty')
    expect(classifyEmptyListing('/repo/docs/', parent)).toBe('empty')
  })

  // The parent contains us, so it cannot legitimately be childless: an empty listing means we
  // could not see it. That is real information, and reporting it as `unknown` let the node say
  // "This folder is empty." over a dead ControlMaster, which is the commonest cause of an empty
  // remote listing.
  it('says unreachable when the parent itself came back empty', () => {
    expect(classifyEmptyListing('/repo/docs', [])).toBe('unreachable')
  })

  it('says unreachable when the parent could not be asked at all', () => {
    expect(classifyEmptyListing('/repo/docs', null)).toBe('unreachable')
  })

  // The distinction that keeps `unreachable` honest: a path whose parent could never answer is
  // still `unknown`, so a `~` root or a `.git` cwd does not start claiming the host is down.
  it('keeps unknown for the paths no parent listing could ever answer', () => {
    expect(classifyEmptyListing('~', null)).toBe('unknown')
    expect(classifyEmptyListing('~', [])).toBe('unknown')
    expect(classifyEmptyListing('/repo/.git', [])).toBe('unknown')
    expect(classifyEmptyListing('relative/dir', [])).toBe('unknown')
  })

  // Root has no parent to interrogate and always exists.
  it('says empty at the root rather than interrogating a parent that does not exist', () => {
    expect(classifyEmptyListing('/', null)).toBe('empty')
    expect(classifyEmptyListing('/', [])).toBe('empty')
  })

  // Every case below would name-match FAIL and be reported as a deletion. Each is a readable
  // directory, so `unknown` (which renders as "empty") is the only honest answer.

  // The one that shipped: an SSH project's remoteCwd DEFAULTS to `~`. `ls ~` works, but
  // parentDir('~') is '/' and '/' has no entry named '~' — so an empty remote HOME reported
  // "Could not read this folder."
  it('never calls a non-absolute path missing — `~` is an SSH project default, not a deletion', () => {
    expect(classifyEmptyListing('~', [{ name: 'bin' }, { name: 'etc' }])).toBe('unknown')
    expect(classifyEmptyListing('~/src', [{ name: 'bin' }])).toBe('unknown')
    expect(classifyEmptyListing('relative/dir', [{ name: 'bin' }])).toBe('unknown')
  })

  // Both listing legs strip `.git` on purpose, so a node pointed at one can never find itself.
  it('never calls a .git directory missing — both listing legs filter it out', () => {
    expect(classifyEmptyListing('/repo/.git', [{ name: 'src' }, { name: 'README.md' }])).toBe('unknown')
  })

  it('never calls a dot segment missing — readdir and `ls -A` do not emit them', () => {
    expect(classifyEmptyListing('/repo/.', [{ name: 'src' }])).toBe('unknown')
    expect(classifyEmptyListing('/repo/..', [{ name: 'src' }])).toBe('unknown')
  })

  // APFS/NTFS list a directory fine under the wrong case, but readdir answers with the on-disk
  // spelling. "Missing" has to be the conclusion we are SURE of.
  it('accepts a case-folded match on a case-insensitive filesystem', () => {
    expect(classifyEmptyListing('/repo/Docs', [{ name: 'docs' }])).toBe('empty')
    expect(classifyEmptyListing('/repo/docs', [{ name: 'DOCS' }])).toBe('empty')
  })

  // A symlinked directory can list as a non-dir entry depending on the leg; matching on `dir`
  // would call it missing. Name matching is what keeps that false alarm out.
  it('matches by name, not by entry kind', () => {
    // Real callers pass `DirEntry[]`; a symlinked directory can arrive with `dir: false`.
    const listed: { name: string; dir: boolean }[] = [{ name: 'link', dir: false }]
    expect(classifyEmptyListing('/repo/link', listed)).toBe('empty')
  })
})

describe('displacedFilesPatch', () => {
  it('re-points to the fallback and renames while the title still tracks the folder', () => {
    expect(displacedFilesPatch({}, '/repo/src')).toEqual({ cwd: '/repo/src', title: 'src' })
  })

  // The `titleAuto` contract: a name the user typed is never overwritten by a cwd change,
  // whether that change came from navigating or from a worktree being removed underneath.
  it('leaves a hand-typed title alone', () => {
    expect(displacedFilesPatch({ titleAuto: false }, '/repo/src')).toEqual({ cwd: '/repo/src' })
  })

  // The one that matters: FilesNode reads `data.cwd || '/'`, so writing undefined would make a
  // displaced node silently list the filesystem ROOT. Doing nothing leaves it on the dead path,
  // where the parent-listing probe tells the truth instead.
  it('refuses to write anything when there is no fallback directory', () => {
    expect(displacedFilesPatch({}, undefined)).toBeNull()
    expect(displacedFilesPatch({ titleAuto: false }, '')).toBeNull()
  })
})
