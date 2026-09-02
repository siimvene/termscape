import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'

// The fork ships under its own mark. Upstream nodeterm's node-graph logo (the `M13 12 L31 24 L13 36`
// path with its three node dots) used to be inlined in three renderer files and came back with every
// upstream merge. BUSL-1.1 grants no rights in the Licensor's logo, so any renderer source that
// carries that path data fails here — route the placement through `TermscapeMark` instead.
const UPSTREAM_MARK_PATH = 'M13 12 L31 24 L13 36'

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx?|css|html)$/.test(name) && !name.endsWith('.test.ts') && !name.endsWith('.test.tsx')) out.push(p)
  }
  return out
}

describe('brand mark guard', () => {
  const root = path.join(__dirname)
  const offenders = walk(root).filter((f) => readFileSync(f, 'utf8').includes(UPSTREAM_MARK_PATH))
  it('no renderer source draws upstream nodeterm\'s mark', () => {
    expect(offenders.map((f) => path.relative(root, f))).toEqual([])
  })
  it('test the test: the guard string is the real upstream path (docs/assets/mark.svg still carries it)', () => {
    const svg = readFileSync(path.join(root, '..', '..', 'docs', 'assets', 'mark.svg'), 'utf8')
    expect(svg).toContain(UPSTREAM_MARK_PATH)
  })
})
