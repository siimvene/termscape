// Source-level parity pin (the shape of hook-verified-parity.test.ts): a managed pi account dir on
// the Server Edition gets the SAME two skills the desktop installs into it (get-linked-context, and
// manage-nodeterm-canvas when canvas control is enabled), both at boot and when the account is
// added. pi reads skills only from `<agentDir>/skills`, so an account dir without them is a pi
// node that cannot discover either CLI — and no behavioral test boots src/server/index.ts.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

const read = (rel: string): string =>
  readFileSync(path.join(__dirname, '..', '..', rel), 'utf8').replace(/\r\n/g, '\n')

describe('Server Edition — managed pi account skills parity with the desktop', () => {
  it('the add verb installs the per-account skills (handlers pass installPiSkill through)', () => {
    const handlers = read('src/server/handlers/index.ts')
    expect(handlers).toMatch(
      /registerPiAccountsIpc\(\{\s*settings: deps\.settingsStore,\s*installSkill: deps\.installPiSkill\s*\}\)/
    )
    const index = read('src/server/index.ts')
    expect(index).toMatch(/installPiSkill: installPiAccountSkills/)
  })

  it('the boot loop hands every existing account dir the same installer', () => {
    const index = read('src/server/index.ts')
    expect(index).toMatch(
      /installPiExtensionIntoLocalAccounts\(settingsStore\.get\(\)\.piAccounts \?\? \[\], installPiAccountSkills\)/
    )
    // Both skills, from the same builders the system dir gets.
    expect(index).toMatch(/const installPiAccountSkills = \(agentDir: string\): void => \{/)
    expect(index).toMatch(/installPiLinkSkillInto\(agentDir\)/)
    expect(index).toMatch(/installServerPiCanvasSkillInto\(agentDir\)/)
  })
})
