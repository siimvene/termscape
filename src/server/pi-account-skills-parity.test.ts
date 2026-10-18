// Source-level parity pin (the shape of hook-verified-parity.test.ts): a managed pi account dir gets
// its status extension and skills from ONE owner on BOTH shells, the agent-integration consent
// lifecycle (core/agent-integrations.ts), under pi's own consent and the Server Edition's
// `installHooks: false` veto. pi reads skills only from `<agentDir>/skills`, so this is what lets a
// pi node discover either CLI; and no behavioral test boots src/server/index.ts or src/main/index.ts.
// A shell that grew its own per-account loop again would write around the consent (an undecided or
// declined pi) and leave nothing to clean on decline — the bug this pin exists for.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

const read = (rel: string): string =>
  readFileSync(path.join(__dirname, '..', '..', rel), 'utf8').replace(/\r\n/g, '\n')

describe('managed pi account integration — one consent-gated owner on both shells', () => {
  it('the add verb asks the consent lifecycle, never a shell-supplied installer', () => {
    const service = read('src/core/pi-accounts-service.ts')
    expect(service).toMatch(/currentIntegrationLifecycle\(\)\?\.installIntoPiAccount\(agentDir\)/)
    expect(service).not.toMatch(/installPiExtensionInto|installSkill/)
    expect(read('src/server/handlers/index.ts')).toMatch(/registerPiAccountsIpc\(\{ settings: deps\.settingsStore \}\)/)
    expect(read('src/main/pi-accounts.ts')).toMatch(/piAccountsHandlers\(\{ settings \}\)/)
  })

  it('neither shell runs its own per-account pi loop; the lifecycle owns every account dir', () => {
    for (const shell of ['src/main/index.ts', 'src/server/index.ts']) {
      const src = read(shell)
      expect(src, shell).not.toMatch(/reconcilePiAccounts|installPiAccountSkills|installPiExtensionIntoLocalAccounts/)
      expect(src, shell).toMatch(/registerIntegrationLifecycle\(integrations\)/)
    }
    const lifecycle = read('src/core/agent-integrations.ts')
    expect(lifecycle).toMatch(/case 'pi':\n\s+return \[\.\.\.new Set\(\[piAgentDir\(\), \.\.\.localPiAccountDirs\(settings, userDataDir\)\]\)\]/)
    expect(lifecycle).toMatch(/for \(const dir of localPiAccountDirs\(settings, deps\.userDataDir\(\)\)\)/)
  })

  it('the Server Edition lifecycle carries its veto and gates the canvas skill on canvas control', () => {
    const index = read('src/server/index.ts')
    expect(index).toMatch(/veto: config\.installHooks === false/)
    expect(index).toMatch(/canvas: config\.canvasControl === true \? serverCanvasShimPath\(\) : undefined/)
  })
})
