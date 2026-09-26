import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CODEX_PERMISSION_FLAGS } from '../shared/agents/approval-mode'

// Two lists decide what a codex permission flag is, in two languages: `withPermissionMode`'s
// suppressors (TypeScript, shared/agents/approval-mode.ts) and the shared-identity launcher's
// preflight `case` (generated sh, codex-identity-proxy.ts). They drifted once: `--approve-for-me`
// was in the preflight only, so the funnel appended `--ask-for-approval …` beside it and codex
// (0.155.1) refused the pair. This guard makes the next flag a two-file change or a red test.

const src = readFileSync(join(__dirname, 'codex-identity-proxy.ts'), 'utf8').replace(/\r\n/g, '\n')

/** The alternatives of the ONE `case` arm that ends in the permission-policy fallback. */
function preflightAlternatives(): string[] {
  const at = src.indexOf('nt_fail permission-policy-requires-local')
  expect(at, 'preflight fallback not found').toBeGreaterThan(-1)
  const armStart = src.lastIndexOf('\n', src.lastIndexOf(')', at)) + 1
  const arm = src.slice(armStart, src.lastIndexOf(')', at)).trim()
  return arm.split('|').map((s) => s.trim())
}

describe('codex permission flags: funnel and launcher preflight agree', () => {
  const alts = preflightAlternatives()

  it('reads the real preflight arm (test the test)', () => {
    expect(alts).toContain('--ask-for-approval')
    expect(alts).not.toContain('--not-a-codex-flag')
  })

  it('every flag the funnel suppresses on is also a preflight fallback trigger', () => {
    for (const flag of CODEX_PERMISSION_FLAGS) expect(alts, flag).toContain(flag)
  })

  it('every bare flag the preflight falls back on is known to the funnel', () => {
    // `=*` forms are the same flag; glued short forms (`-anever`) are listed only in the preflight
    // because the funnel's argvHasFlag matches whole tokens (a known, narrower gap).
    const bare = alts.filter((a) => !a.endsWith('=*') && !/^-[as][a-z]/.test(a))
    for (const flag of bare) expect(CODEX_PERMISSION_FLAGS, flag).toContain(flag)
  })
})
