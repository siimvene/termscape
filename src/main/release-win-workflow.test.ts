import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * Release guard for the unsigned Windows beta, in the TERMSCAPE FORK's shape. `dist:win:release`
 * packages productName Termscape (nsis `${productName}-Setup-${version}`) with `publish: null` and
 * `nodeTermUpdates=disabled`, so it writes no `latest.yml`: `release-win` must check and upload the
 * Termscape-named installer + zip, and must neither require nor upload a feed file (upstream's job
 * failed on the missing `latest.yml` and globbed `nodeterm-*` names this build never produces). No
 * blockmaps either: differential downloads belong to the self-install story that waits on code
 * signing. Text-level, like the job's own artifact-contract step; no YAML parser needed for a job
 * block this regular.
 */
const WORKFLOW = path.resolve(__dirname, '../../.github/workflows/release.yml')

function jobBlock(text: string, job: string): string {
  const start = text.indexOf(`\n  ${job}:\n`)
  expect(start, `job ${job} not found in release.yml`).toBeGreaterThanOrEqual(0)
  const rest = text.slice(start + 1)
  // The next top-level job: a line indented exactly two spaces that names a key.
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/)
  return next < 0 ? rest : rest.slice(0, next + 1)
}

/** Only the shell lines — comments explain the omissions and would match the negative checks. */
function commands(block: string): string {
  return block
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
}

describe('release.yml release-win', () => {
  const text = fs.readFileSync(WORKFLOW, 'utf8')
  const job = commands(jobBlock(text, 'release-win'))

  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8').replace(/\r\n/g, '\n')) as {
    scripts: Record<string, string>
    build: { productName: string; publish: unknown; nsis: { artifactName: string } }
  }

  it('builds the release package, which stamps no feed and publishes nowhere', () => {
    expect(job).toMatch(/run: npm run dist:win:release\s*\n/)
    expect(pkg.scripts['dist:win:release']).toContain('nodeTermUpdates=disabled')
    expect(pkg.scripts['dist:win:release']).toContain('--publish never')
    expect(pkg.build.publish).toBeNull()
  })

  it('checks and uploads the Termscape-named installer + zip the build actually produces', () => {
    expect(pkg.build.productName).toBe('Termscape')
    expect(pkg.build.nsis.artifactName).toBe('${productName}-Setup-${version}.${ext}')
    expect(job).toContain('test -f "dist/Termscape-Setup-${version}.exe"')
    expect(job).toContain('ls dist/Termscape-*-win.zip')
    const upload = job.split('\n').find((l) => l.includes('gh release upload'))
    expect(upload).toBeDefined()
    expect(upload).toContain('dist/Termscape-Setup-*.exe')
    expect(upload).toContain('dist/Termscape-*-win.zip')
    expect(job).not.toContain('dist/nodeterm-')
  })

  it('neither requires nor uploads latest.yml (the fork has no update feed)', () => {
    expect(job).not.toContain('latest.yml')
  })

  it('uploads no blockmap and no broad yml glob', () => {
    expect(job).not.toContain('blockmap')
    expect(job).not.toContain('dist/*.yml')
  })

  it('is still not a gate on the mac+linux publish', () => {
    const publish = commands(jobBlock(text, 'publish'))
    expect(publish).toMatch(/needs: \[release-mac, release-linux\]/)
    expect(publish).not.toContain('release-win')
  })
})

// TERMSCAPE FORK: upstream's verify-feed job (U2) curls its update mirror at nodeterm.dev after
// every release. The fork has no update feed and never talks to upstream's backend, so the job is
// removed; this pins that it stays gone and that nothing else in the workflow polls the mirror.
describe('release.yml has no upstream feed check (fork)', () => {
  const text = fs.readFileSync(WORKFLOW, 'utf8')

  it('carries no verify-feed job', () => {
    expect(text.indexOf('\n  verify-feed:\n')).toBe(-1)
  })

  it('no command line fetches nodeterm.dev', () => {
    const live = commands(text)
    expect(live).not.toMatch(/curl[^\n]*nodeterm\.dev/)
    expect(live).not.toContain('FEED: https://nodeterm.dev')
  })
})
