// Pure path logic for Explorer/canvas "New File…" / "New Folder…" — kept out of the
// components so name validation and expansion targets are unit-testable. Paths are
// `/`-separated absolutes (remote SSH paths included); names come from a user prompt.

/** The directory a create targets: the clicked dir itself, or the clicked file's parent. */
export function createTargetDir(path: string, isDir: boolean): string {
  return isDir ? path : parentDir(path)
}

export function parentDir(p: string): string {
  const i = p.replace(/\/+$/, '').lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

/**
 * Join a user-entered name onto a base dir. Multi-segment relative names (`a/b.ts`) are
 * allowed, and the intermediate dirs are the caller's job (see `ancestorDirs`). Returns null for
 * anything unsafe or senseless: empty, absolute, `..` traversal, trailing separator.
 *
 * The `..` guard splits on BOTH separators, the rule CONTRIBUTING states for every path split:
 * `..\x` used to be a single segment that was neither empty nor `..`, so it passed here on every
 * platform and then escaped `baseDir` the moment Windows resolved it. That is the same hole the
 * node-icon traversal check had, and the same fix.
 *
 * The path is still BUILT with `/`, and the empty-segment check still splits on `/` alone, on
 * purpose: on POSIX a backslash is ordinary filename text, so `a\\b` is a legal name for one file
 * and refusing it would be this guard being wrong about the filesystem it is writing to. Guard on
 * both dialects, construct in one.
 */
export function newEntryPath(baseDir: string, name: string): string | null {
  const n = name.trim()
  if (!n) return null
  // Absolute in either dialect escapes `baseDir`, which is the whole point of joining onto it:
  // a leading `/`, a leading `\` (root of the current Windows drive), or a drive qualifier.
  if (n.startsWith('/') || n.startsWith('\\') || /^[A-Za-z]:/.test(n)) return null
  if (n.endsWith('/') || n.endsWith('\\')) return null
  if (n.split(/[\\/]/).some((seg) => seg === '..')) return null
  if (n.split('/').some((seg) => !seg)) return null
  return `${baseDir.replace(/\/+$/, '')}/${n}`
}

/** Absolute paths of the intermediate dirs a nested name passes through (shallowest first). */
export function ancestorDirs(baseDir: string, name: string): string[] {
  const segs = name.trim().split('/').slice(0, -1)
  const out: string[] = []
  let acc = baseDir.replace(/\/+$/, '')
  for (const s of segs) {
    acc = `${acc}/${s}`
    out.push(acc)
  }
  return out
}

/**
 * The name of a directory — its last segment, or '/' at the root.
 *
 * Lives HERE rather than beside the file manager's other pure helpers because `state/workspace.ts`
 * needs it too (`createFilesNode`'s title) and `lib/filesNode.ts` imports `isVideoFile` FROM
 * workspace, so importing back would close a cycle. This module imports nothing, which is what
 * makes it the right home. `lib/filesNode.ts` re-exports it, so every existing call site is
 * unchanged.
 */
export function folderTitle(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? '/'
}
