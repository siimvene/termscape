import { describe, expect, it } from 'vitest'
import { ancestorDirs, createTargetDir, newEntryPath, parentDir } from './explorerCreate'

describe('createTargetDir', () => {
  it('a dir targets itself, a file targets its parent', () => {
    expect(createTargetDir('/repo/src', true)).toBe('/repo/src')
    expect(createTargetDir('/repo/src/a.ts', false)).toBe('/repo/src')
  })
})

describe('parentDir', () => {
  it('strips the last segment', () => {
    expect(parentDir('/repo/src/a.ts')).toBe('/repo/src')
    expect(parentDir('/repo')).toBe('/')
  })
})

describe('newEntryPath', () => {
  it('joins simple and nested names', () => {
    expect(newEntryPath('/repo/src', 'notes.md')).toBe('/repo/src/notes.md')
    expect(newEntryPath('/repo/src/', 'a/b.ts')).toBe('/repo/src/a/b.ts')
  })
  it('rejects empty, absolute, traversal and trailing-slash names', () => {
    expect(newEntryPath('/repo', '')).toBeNull()
    expect(newEntryPath('/repo', '  ')).toBeNull()
    expect(newEntryPath('/repo', '/etc/passwd')).toBeNull()
    expect(newEntryPath('/repo', '../evil')).toBeNull()
    expect(newEntryPath('/repo', 'a/../../evil')).toBeNull()
    expect(newEntryPath('/repo', 'a/')).toBeNull()
  })

  // The hole eneskirca spotted on #294: `..` was only ever looked for between `/` separators, so
  // a backslash-delimited traversal was one segment that is neither empty nor `..`. It passed on
  // every platform and escaped `baseDir` as soon as Windows resolved it.
  it('rejects a backslash traversal, which used to pass as a single segment', () => {
    expect(newEntryPath('/repo', '..\\evil')).toBeNull()
    expect(newEntryPath('/repo', 'a\\..\\..\\evil')).toBeNull()
    expect(newEntryPath('/repo', 'a/..\\evil')).toBeNull()
    expect(newEntryPath('/repo', 'a\\../evil')).toBeNull()
  })

  it('rejects a name that is absolute in the Windows dialect', () => {
    expect(newEntryPath('/repo', '\\Windows\\system32')).toBeNull()
    expect(newEntryPath('/repo', 'C:\\Windows')).toBeNull()
    expect(newEntryPath('/repo', 'C:/Windows')).toBeNull()
    expect(newEntryPath('/repo', 'a\\')).toBeNull()
  })

  // CONTRIBUTING is explicit that the two separators are NOT interchangeable: on POSIX a
  // backslash is ordinary filename text. The guard reads both dialects, the construction stays
  // `/`, and a legal POSIX name survives.
  it('still accepts a backslash as ordinary filename text', () => {
    expect(newEntryPath('/repo', 'weird\\name.txt')).toBe('/repo/weird\\name.txt')
    expect(newEntryPath('/repo', 'a\\\\b')).toBe('/repo/a\\\\b')
  })
})

describe('ancestorDirs', () => {
  it('lists the intermediate dirs a nested name creates', () => {
    expect(ancestorDirs('/repo', 'a/b/c.ts')).toEqual(['/repo/a', '/repo/a/b'])
    expect(ancestorDirs('/repo', 'c.ts')).toEqual([])
  })
})
