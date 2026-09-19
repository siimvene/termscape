/**
 * TEST-ONLY — pin the machine noun so copy assertions do not depend on the DEVELOPER'S OS.
 *
 * `machineNoun()` sniffs `navigator`, so a string built through it reads "this computer" on the
 * Linux CI box and "this Mac" on a Mac. Three suites asserted the Linux answer as a literal and
 * were therefore red on every macOS checkout — reported by a contributor whose branch touched
 * none of those files (PR #592), which is the expensive way to find out: a test that fails only
 * on the maintainer's own platform teaches contributors to ignore red.
 *
 * Pinning the platform is the fix rather than softening the assertions: the exact sentence is the
 * thing under test (issue #563 is about billing copy naming the wrong machine), so it must stay a
 * literal — what must not stay is the assumption about which machine is running the suite.
 */
import { afterAll, beforeAll } from 'vitest'

/** Force `machineNoun()` to answer 'computer' for the whole file (jsdom `navigator.platform`). */
export function pinNeutralMachineNoun(): void {
  let original: PropertyDescriptor | undefined
  beforeAll(() => {
    original = Object.getOwnPropertyDescriptor(navigator, 'platform')
    Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64', configurable: true })
  })
  afterAll(() => {
    if (original) Object.defineProperty(navigator, 'platform', original)
    else delete (navigator as unknown as Record<string, unknown>).platform
  })
}
