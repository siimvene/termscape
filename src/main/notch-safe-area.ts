// The ONE honest notch signal on macOS: `NSScreen.safeAreaInsets.top` is non-zero exactly on a
// panel with a camera housing. Electron's `screen` API does not expose it, and every height
// heuristic the HUD has shipped was wrong on SOME machine (docs/notch-hud.md): the absolute 32 pt
// missed scaled modes (#508), the 0.03 ratio missed the 16" MBP at its default scaling, and an
// absolute 27 pt cannot separate a notched 28–33 pt strip from macOS Tahoe's taller notchless
// menu bar (consort finding 2026-09-02, 31 pt measured on a notchless M1 Air). So ask AppKit,
// through the JavaScript-for-Automation bridge that ships with every Mac — one short-lived
// osascript process, ~0.3 s, no user input in the script, fail-open to `null` so the caller falls
// back to the heuristic rather than deciding on a probe that did not answer.
//
// Read `NSScreen.screens[0]`, not `mainScreen`: screens[0] is the display whose top edge holds the
// menu bar, which is what Electron's `screen.getPrimaryDisplay()` (the geometry's input) reports.

import { execFile } from 'node:child_process'

const OSASCRIPT_BIN = '/usr/bin/osascript'
const PROBE_TIMEOUT_MS = 5_000

// Fixed script, no interpolation. Prints the primary screen's top safe-area inset in points.
const SCRIPT =
  'ObjC.import("AppKit"); var s = $.NSScreen.screens.objectAtIndex(0); ' +
  'var sa = s.safeAreaInsets; String(Number(sa.top))'

/**
 * Probe the primary display's top safe-area inset (points). Resolves `null` when the answer is not
 * trustworthy — not darwin, osascript missing or slow, non-numeric output — never rejects.
 */
export function probeSafeAreaTop(platform: NodeJS.Platform = process.platform): Promise<number | null> {
  if (platform !== 'darwin') return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      execFile(
        OSASCRIPT_BIN,
        ['-l', 'JavaScript', '-e', SCRIPT],
        { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => {
          if (err) return resolve(null)
          resolve(parseSafeAreaTop(String(stdout)))
        }
      )
    } catch {
      resolve(null)
    }
  })
}

/** Pure: the probe's stdout → inset in points, or null for anything that is not a finite number ≥ 0. */
export function parseSafeAreaTop(stdout: string): number | null {
  const s = stdout.trim()
  if (!s) return null // `Number('')` is 0, and an empty answer is no answer, not "no notch"
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? n : null
}
