import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { installPiLinkSkillInto, contextLinkDir } from './context-link'

// pi is CONTEXT_LINK_CAPABLE but reads skills only from `<agentDir>/skills` and `~/.agents/skills`
// (measured on 0.84.1; never `~/.claude/skills`), so the get-linked-context skill must land in the
// pi agent dir itself — including each managed pi account's dir.
describe('installPiLinkSkillInto', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ctxlink-pi-'))
    resetPlatformForTests()
    initPlatform(fakePlatform({ userDataDir: join(dir, 'ud') }))
  })
  afterEach(() => {
    resetPlatformForTests()
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes <agentDir>/skills/get-linked-context/SKILL.md pointing at this instance’s shim', () => {
    const agentDir = join(dir, 'pi-accounts', 'a1')
    installPiLinkSkillInto(agentDir)
    const p = join(agentDir, 'skills', 'get-linked-context', 'SKILL.md')
    expect(existsSync(p)).toBe(true)
    const body = readFileSync(p, 'utf8')
    expect(body).toContain(join(contextLinkDir(), 'context.sh'))
    expect(body).toMatch(/^---\n[\s\S]*name:/)
  })
})
