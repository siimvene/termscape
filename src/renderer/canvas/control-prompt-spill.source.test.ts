import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Structural pins for the automatic prompt spill (#706) inside the canvas-control dispatch.
 *
 * The behaviour of the spill itself is proven against real primitives in lib/promptSpill.test.ts.
 * What only the Canvas source can state is that the control dispatch CALLS it — a `--prompt` over
 * the typed-line budget must reach the pane through the `"$(cat …)"` file substitution, not as a
 * launch line that command-delivery (dbdbed77) now REFUSES for being too long. The spill was
 * dropped at every launch site in the v0.3.7 merge; these pins fail if it goes missing again.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8')

describe('canvas-control prompt spill (source pins)', () => {
  it('imports the spill primitives and defines the ControlSurface-local helper', () => {
    expect(src).toContain('shouldSpillPrompt')
    expect(src).toContain('spillPromptToFile')
    // One helper, defined after the surface's `ctlSsh` is known so the SSH exclusion is evaluated
    // against the TARGET project the pane will run on.
    expect(src).toMatch(/const spillLongPrompt = async \(/)
    expect(src).toContain('if (!shouldSpillPrompt(prompt, !ctlSsh)) return { prompt }')
    expect(src).toContain('saveUpload: (n, d) => api.files.saveUpload(n, d)')
  })

  it('open-agent spills a long --prompt, and an explicit --prompt-file passes through untouched', () => {
    expect(src).toContain('const promptLaunch = await spillLongPrompt(promptFile ? undefined : args.prompt)')
    // The node is built from the spilled prompt, and an explicit `--prompt-file` wins over a spill.
    expect(src).toContain('promptLaunch.prompt')
    expect(src).toContain('promptFile ?? promptLaunch.promptFile')
  })

  it('verify spills every lens brief and the verdict brief before building the panel', () => {
    expect(src).toMatch(/const lensLaunches = await Promise\.all\(/)
    expect(src).toContain('lensLaunches[i].prompt')
    expect(src).toContain('lensLaunches[i].promptFile')
    expect(src).toContain('const judgeLaunch = await spillLongPrompt(')
    expect(src).toContain('judgeLaunch.prompt')
    expect(src).toContain('judgeLaunch.promptFile')
  })

  it('spawn-team spills each role brief, and a role naming its own promptFile wins', () => {
    expect(src).toMatch(/const roleLaunches = await Promise\.all\(/)
    expect(src).toContain('r.promptFile ? spillLongPrompt(undefined) : spillLongPrompt(r.prompt)')
    expect(src).toContain('roleLaunches[i].prompt')
    expect(src).toContain('r.promptFile ?? roleLaunches[i].promptFile')
  })
})
