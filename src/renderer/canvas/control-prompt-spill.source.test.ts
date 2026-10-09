import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins: EVERY canvas-control open path types the same prompt the same way (#706).
 *
 * A `--prompt` becomes a quoted argument on a launch line TYPED into the pane, and a canonical-mode
 * tty drops everything past 1024 bytes on macOS. `spillPromptToFile` moves an over-budget prompt
 * into a file the pane's shell reads, and the agent-facing docs promise that a long `--prompt` is
 * therefore safe on a local project. That promise held on ONE of three paths: the live open. The
 * `--project` path and the cold open (the caller's own project, not on screen) typed the prompt
 * inline, and the issue reference line (#1000, ~490 bytes on its own) made that likelier. The
 * `--project` path also dropped `--prompt-file` without a word, so the session started with no
 * brief at all.
 *
 * The decision itself is `launchPromptFor` (lib/promptSpill.ts), proven against real inputs in its
 * own test. What only the SOURCE can show is that each path asks it, once, before any path snapshots
 * the projects store — an await inside a path is the #443 class (a tab switch in that window writes
 * the node into the project that just became active).
 *
 * Fork note: Termscape has no separate cold-open dispatch block. A control call never switches the
 * user's view, so an off-screen source runs the SAME verb case (`case 'open-claude':` …) against a
 * store-backed ControlSurface (control-no-travel.source.test.ts). The live-open pins below therefore
 * cover the fork's cold open too. The spill was once dropped at every launch site in a merge (the
 * fork's f0776c8c restored it for open-agent, verify and spawn-team); the verify / spawn-team pins
 * at the bottom fail if it goes missing again.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const PROJECT_GUARD = "(verb === 'open-terminal' || verb === 'open-claude' || verb === 'open-agent') &&\n        args.project !== undefined"
const RUN_PROJECT = "if (verb === 'run' && args.project !== undefined) {"

function slice(fromMarker: string, toMarker: string, from = 0): string {
  const start = src.indexOf(fromMarker, from)
  expect(start, `marker: ${fromMarker}`).toBeGreaterThan(-1)
  const end = src.indexOf(toMarker, start + fromMarker.length)
  expect(end, `marker: ${toMarker}`).toBeGreaterThan(start)
  return src.slice(start, end)
}

const projectBlock = (): string => slice(PROJECT_GUARD, RUN_PROJECT)
const liveAgentCase = (): string => slice("case 'open-claude':", "case 'show-image':")

/** Every `createAgentNode(…)` call in a block, argument list included (balanced parentheses). */
function agentNodeCalls(block: string): string[] {
  const calls: string[] = []
  let at = block.indexOf('createAgentNode(')
  while (at !== -1) {
    let depth = 0
    let end = at + 'createAgentNode'.length
    for (; end < block.length; end++) {
      if (block[end] === '(') depth++
      else if (block[end] === ')' && --depth === 0) break
    }
    calls.push(block.slice(at, end + 1))
    at = block.indexOf('createAgentNode(', end)
  }
  return calls
}

describe('the open prompt is resolved ONCE, before any path reads the store', () => {
  it('is decided by launchPromptFor next to issuePre, ahead of the --project block and routing', () => {
    const decided = src.indexOf('const openPrompt:')
    expect(decided, 'the one openPrompt resolution').toBeGreaterThan(-1)
    expect(src.indexOf('const openPrompt:', decided + 1), 'resolved exactly once').toBe(-1)
    expect(src.slice(decided, decided + 1500)).toContain('launchPromptFor(')
    expect(decided).toBeGreaterThan(src.indexOf('const issuePre: IssueFlagResult'))
    expect(decided).toBeLessThan(src.indexOf(PROJECT_GUARD))
    expect(decided).toBeLessThan(src.indexOf('routeControlSource(projects, activeId, sourceNodeId)'))
  })

  it('never spills for a dry run — a dry run writes no file', () => {
    const decided = src.indexOf('const openPrompt:')
    expect(src.slice(decided, decided + 1500)).toMatch(/!dryRun/)
  })

  it('asks the SAME authorization belt as `#N` which project that is — a refused caller spills nothing', () => {
    const decided = src.indexOf('const openPrompt:')
    const before = src.slice(src.indexOf('const issuePre: IssueFlagResult'), decided)
    expect(before).toMatch(/const openScopePre = (issueOpen|openVerb)\s*\?\s*issueFlagScope\(/)
    expect(src.slice(decided, decided + 400)).toContain('openScopePre?.ok')
  })

  it('judges "local" by the project the node OPENS in, never the one on screen', () => {
    // An SSH project's pane runs on the host, so a spilled file would land on the wrong machine.
    const decided = src.indexOf('const openPrompt:')
    const body = src.slice(decided, decided + 1500)
    expect(body).toMatch(/localFs: !openProjectPre\?\.ssh/)
    expect(src).toContain('const openProjectPre')
  })
})

describe('each open path types openPrompt, never its own inline prompt', () => {
  // The fork's cold open is the live case on a store surface (see the header), so there is no
  // separate cold-open block to pin here.
  const cases: [string, () => string, RegExp][] = [
    ['--project', projectBlock, /\btgPrompt\b/],
    ['live open', liveAgentCase, /promptLaunch/]
  ]
  for (const [name, block, legacy] of cases) {
    it(`${name}: every agent node takes openPrompt.prompt and openPrompt.promptFile`, () => {
      const calls = agentNodeCalls(block())
      expect(calls.length, `${name} builds agent nodes`).toBeGreaterThan(0)
      for (const call of calls) {
        expect(call).toContain('openPrompt.prompt,')
        expect(call).toMatch(/openPrompt\.promptFile\s*\)/)
      }
      // The per-path prompt that used to be typed inline is gone, not merely unused.
      expect(block()).not.toMatch(legacy)
    })
  }

  it('--project passes --model through instead of dropping it', () => {
    for (const call of agentNodeCalls(projectBlock())) expect(call).toMatch(/args\.model,\s*openPrompt\.promptFile/)
  })

  it('--project validates --prompt-file instead of dropping it', () => {
    const body = projectBlock()
    expect(body).toContain('promptFilePathError(')
    expect(body).toContain('pass either --prompt or --prompt-file, not both')
    expect(body).toMatch(/\.exists\(/)
  })

  it('--project re-reads the store after its await, so a tab switch cannot misroute the node', () => {
    // `tgActive` decides between setNodes (live canvas) and a store write; a value read before an
    // await describes a canvas that may no longer be on screen.
    const body = projectBlock()
    const awaited = body.indexOf('.exists(')
    const active = body.indexOf('const tgActive')
    expect(awaited).toBeGreaterThan(-1)
    expect(active).toBeGreaterThan(awaited)
    expect(body.slice(active, active + 200)).toContain('useProjects.getState().activeProjectId')
  })
})

describe('the brief file is checked when the launch is DELIVERED (#1014 review)', () => {
  // A cold-opened node launches when its project is next viewed, maybe weeks later; the file its
  // command `cat`s may be gone by then. Behaviour: `lib/pendingLaunch.test.ts` (briefFile, tooltip)
  // and `core/uploads.test.ts` (spills survive the paste sweep).
  it('every open path records the file on the held launch', () => {
    // The fork arms through its consent-recording wrappers (`queueControlLaunchHere`,
    // `armColdOpenHere`: only a launch THIS process armed may auto-fire, see wasArmedThisSession)
    // where upstream calls the bare primitives; the brief file rides on the wrapped launch.
    expect(projectBlock()).toContain('withLaunchBrief(queueControlLaunchHere(node), openPrompt.promptFile)')
    expect(projectBlock()).toContain('withLaunchBrief(armColdOpenHere(node), openPrompt.promptFile)')
    expect(src).toContain('withLaunchBrief(queueControlLaunchHere(node, after, awaitSetupGroup), promptFile)')
    // …and the live open (on screen or on a store surface) hands its file to armAfter.
    expect(liveAgentCase()).toMatch(/after \?\? \[\],\s*intoGroupId,\s*openPrompt\.promptFile\s*\)/)
  })

  it('the launch loop checks the file before typing, and holds the node for ▶ when it is gone', () => {
    const loop = slice('const ready = launchesToFire(', '}, [nodes, armedDepSig')
    const check = loop.indexOf('briefPresent(f.briefFile)')
    expect(check).toBeGreaterThan(-1)
    // Bounded by the `.then` callback's own end, not a character count: the fork's not-present
    // branch also releases the registry claim and consumes the consent (`settleLaunch`,
    // `forgetArmed`) before holding the node, which pushed upstream's 700-char window short.
    const thenEnd = loop.indexOf("}, () => settle('cancelled'))", check)
    expect(thenEnd).toBeGreaterThan(check)
    const missing = loop.slice(check, thenEnd)
    expect(missing).toMatch(/\.then\(\(present\) => \{\s*if \(!present\) \{/)
    expect(missing).toContain('manualOnly: true')
    expect(missing).toContain('markBriefMissing(f.id')
    // Fork: the consent is consumed on the hold, so ▶ Run now is the only way onward.
    expect(missing).toContain('forgetArmed(f.id)')
    // Typing happens only on the "present" branch.
    expect(missing).toMatch(/return deliverHeld\(\)/)
    // …on the node's own project, with the local fs (the rule itself: `launchBriefPresent`). The
    // node's own project is the RENDERED epoch (`renderedProjectId`), the one its `nodes` came from —
    // the ref is the latest installed epoch and may already name the next project (useNodesEpoch).
    const effect = slice('const briefPresent = ', 'const ready = launchesToFire(')
    expect(effect).toContain('launchBriefPresent(')
    expect(effect).toContain('getProject(renderedProjectId')
  })
})

describe('canvas-control prompt spill on the multi-node verbs (fork f0776c8c, source pins)', () => {
  it('defines the ControlSurface-local helper, judged against the TARGET project', () => {
    // One helper, defined after the surface's `ctlSsh` is known so the SSH exclusion is evaluated
    // against the project the pane will run on; the decision is the same `launchPromptFor`.
    expect(src).toMatch(/const spillLongPrompt = async \(/)
    expect(src).toContain('launchPromptFor({ prompt, localFs: !ctlSsh }, spillIo)')
    expect(src).toMatch(/saveUpload: \(name: string, data: string\) => api\.files\.saveUpload\(name, data\)/)
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
