import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for `--after-pr` inside the desktop's control dispatch, launch loop and node
 * badge. Same reason as `control-prompt-spill.source.test.ts`: these live inside a 16,000-line
 * component with no unit seam. Every behavioural half is proven against real code elsewhere:
 * the grammar and the persisted shape in `shared/pr-wait.test.ts`, when a wait is met and what an
 * open may store in `lib/prWait.test.ts`, the AND with `--after` in `lib/pendingLaunch.test.ts`, the
 * watch and the lookup in `state/githubIssues.test.ts`, the load seam in `state/workspace.test.ts`.
 */
const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const src = read('./Canvas.tsx')
const node = read('../nodes/TerminalNode.tsx')
const mainSrc = read('../../main/index.ts')

const PROJECT_GUARD = "(verb === 'open-terminal' || verb === 'open-claude' || verb === 'open-agent') &&\n        args.project !== undefined"
const RUN_PROJECT = "if (verb === 'run' && args.project !== undefined) {"

function slice(fromMarker: string, toMarker: string, text = src): string {
  const start = text.indexOf(fromMarker)
  expect(start, `marker: ${fromMarker}`).toBeGreaterThan(-1)
  const end = text.indexOf(toMarker, start + fromMarker.length)
  expect(end, `marker: ${toMarker}`).toBeGreaterThan(start)
  return text.slice(start, end)
}

describe('main refuses a malformed --after-pr before the renderer sees it', () => {
  it('runs the shared shape gate in the control handler, before the forward', () => {
    const handler = mainSrc.slice(mainSrc.indexOf('hookServer.setControlHandler('))
    const gate = handler.indexOf('afterPrFlagRefusal(verb, args)')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(handler.indexOf("'window unavailable'"))
  })
})

describe('the wait is resolved ONCE, before any open path reads the store', () => {
  it('against the project the node OPENS in, for all three open verbs', () => {
    const at = src.indexOf('const prWaitPre')
    expect(at).toBeGreaterThan(-1)
    expect(src.indexOf('const prWaitPre', at + 1)).toBe(-1)
    const body = src.slice(at, at + 2000)
    expect(body).toContain('resolvePrWaitFor(')
    expect(body).toContain('project: openProjectPre')
    expect(body).toContain('lookupPullRequests(')
    expect(at).toBeGreaterThan(src.indexOf('const openPrompt:'))
    expect(at).toBeLessThan(src.indexOf(PROJECT_GUARD))
    expect(at).toBeLessThan(src.indexOf('routeControlSource(projects, activeId, sourceNodeId)'))
    // `openProjectIdPre` (and so `openProjectPre`) now covers open-terminal as well.
    expect(src).toMatch(/const openVerb = verb === 'open-terminal' \|\| issueOpen/)
    expect(src).toMatch(/const openScopePre = openVerb\s*\?\s*issueFlagScope\(/)
  })

  it('asks nobody for a caller the open paths would refuse (the same belt as `#N`)', () => {
    const at = src.indexOf('const prWaitPre')
    const body = src.slice(at, at + 600)
    const belt = body.indexOf('openScopePre && !openScopePre.ok')
    expect(belt).toBeGreaterThan(-1)
    expect(belt).toBeLessThan(body.indexOf('resolvePrWaitFor('))
    expect(body).toContain('error: openScopePre.error')
  })

  it('refuses on a failed resolution and replies exactly once', () => {
    const at = src.indexOf('const prWaitPre')
    const body = src.slice(at, at + 2500)
    expect(body).toMatch(/if \(!prWaitPre\.ok\) \{\s*reply\(\{ ok: false, error: prWaitPre\.error \}\)\s*return\s*\}/)
  })

  it('the renderer belt refuses --run-now with --after-pr too (main is not the only gate)', () => {
    expect(src).toContain('reply({ ok: false, error: RUN_NOW_AFTER_PR_REFUSAL })')
  })
})

// The fork runs every control verb against ONE `ControlSurface`: the live canvas, or the OWNING
// project's store when the source is off screen (a control call never switches the view). Upstream's
// separate cold-open path does not exist here — an off-screen open is the same `case` on the store
// surface, building through the same `armAfter` and replying through the same dry run. The consent
// wrappers (`queueControlLaunchHere` / `armColdOpenHere`) are upstream's `queueControlLaunch` /
// `armForColdOpen` plus the fork's record that THIS process armed the launch.
describe('every open path attaches the wait through withPrHold', () => {
  it('the live AND the off-screen (store surface) opens, through armAfter (terminal and agent both use it)', () => {
    const armAfter = slice('const armAfter = (', 'const addGrouped = (')
    expect(armAfter).toMatch(
      /withPrHold\(\s*withLaunchBrief\(queueControlLaunchHere\(node, after, awaitSetupGroup\), promptFile\),\s*prHoldPre\s*\)/
    )
    expect(slice("case 'open-terminal': {", "case 'open-claude':")).toMatch(/const node = armAfter\(/)
    expect(slice("case 'open-agent': {", "case 'show-image': {")).toMatch(/const node = armAfter\(/)
    // No second (cold) arming path an off-screen open could take around armAfter.
    expect(src).not.toContain('if (canColdOpen(verb)) {')
  })

  it('every dry run reports the wait in its result, on either surface', () => {
    for (const [from, to] of [
      ["case 'open-terminal': {", "case 'open-claude':"],
      ["case 'open-agent': {", "case 'show-image': {"]
    ] as const) {
      const body = slice(from, to)
      // Bound the window to the dry-run reply itself (`if (dryRun) {` … the `})` + `return` that
      // closes it): the REAL reply further down also spreads `...prResult`, so an open-ended window
      // would still match after the dry run stopped reporting the wait.
      const start = body.indexOf('if (dryRun) {')
      const resStart = body.indexOf('dryRun: true,', start)
      expect(start).toBeGreaterThan(-1)
      expect(resStart).toBeGreaterThan(start)
      const closeAt = body.slice(resStart).search(/\}\)\s*return\b/)
      expect(closeAt).toBeGreaterThan(0)
      const dry = body.slice(start, resStart + closeAt)
      expect(dry).not.toContain('prReplyText') // the real reply's text: the window stayed in the dry run
      expect(body.slice(resStart, resStart + closeAt)).toContain('...prResult')
      expect(dry).toContain('...prReplyLines')
    }
  })

  it('the off-screen open is answered from the store surface — never a cold copy of the verb', () => {
    // The surface is chosen after the wait was resolved; the store surface is what an off-screen
    // source gets, and the verbs above run against it unchanged.
    const route = slice('let surface: ControlSurface = liveSurface', "if (!src) {\n        reply({ ok: false, error: 'source node is not on an open canvas' })")
    expect(route).toContain('surface = storeSurfaceFor(route.projectId)')
    expect(src.indexOf('const prWaitPre')).toBeLessThan(src.indexOf('let surface: ControlSurface = liveSurface'))
  })

  it('both --project branches (on screen and stored)', () => {
    const block = slice(PROJECT_GUARD, RUN_PROJECT)
    expect(block).toMatch(/withPrHold\(withLaunchBrief\(queueControlLaunchHere\(node\), openPrompt\.promptFile\), prHoldPre\)/)
    expect(block).toMatch(/withPrHold\(withLaunchBrief\(armColdOpenHere\(node\), openPrompt\.promptFile\), prHoldPre\)/)
  })
})

describe('the launch loop judges the wait on the ACTIVE project’s pull request status', () => {
  const effect = (): string => slice('const ready = launchesToFire(', '}, [nodes, armedDepSig')

  // The board of the project the effect's `nodes` belong to — `renderedProjectId`, not the ref: the
  // ref is the LATEST installed epoch and, in a project switch's window, already names the incoming
  // project while `nodes` are still the outgoing one's (useNodesEpoch, Task 3).
  it('passes the board and the clock to launchesToFire', () => {
    expect(effect()).toMatch(/\{ board: pullBoardFor\(useGitHubIssues\.getState\(\), renderedProjectId \?\? ''\), now: Date\.now\(\) \}/)
  })

  it('re-runs when a waited-on pull request changes, off a PRIMITIVE signature', () => {
    expect(src).toMatch(/\}, \[nodes, armedDepSig, armedHandoverSig, armedSetupSig, armedPrSig, armedSuccessSig, launchNudge\]\)/)
    const sig = slice('const armedPrSig = useGitHubIssues((s) => {', '})')
    expect(sig).toContain('prHoldReports(')
    expect(sig).toContain("sig +=")
  })

  it('asks for a read taken after arming while a checks wait lacks one (B2), bounded', () => {
    const fresh = slice('const prFreshReadWanted = useGitHubIssues((s) => {', '// Bumped to re-run the launch effect')
    expect(fresh).toContain('board.readStartedAt < hold.armedAt')
    expect(fresh).toContain('startFreshReadAsks({')
    expect(fresh).toContain('api.githubIssues.refresh(prWatchProjectId)')
    expect(fresh).toMatch(/if \(!prWatchProjectId \|\| !prFreshReadWanted\) return/)
  })

  it('keeps the host watch (and the checks chase) only while some node holds a PR wait', () => {
    const watch = slice('const prWatchNeeded =', 'usePullChase(')
    expect(watch).toContain('watchPulls(api.githubIssues,')
    expect(src).toMatch(/usePullChase\(api\.githubIssues, prWatchProjectId, prChaseNeeded\)/)
  })
})

describe('the node badge', () => {
  it('a PR hold is a real hold: it is never hidden as a first-open delivery', () => {
    const first = slice('const firstOpenInFlight =', '\n  const ', node)
    expect(first).toContain('!pendingLaunch?.afterPr')
  })

  it('reads EXPIRED and hands the PR wait to the tooltip', () => {
    expect(node).toMatch(/prExpired \|\| successExpired\s*\?\s*'⚠ EXPIRED'/)
    expect(node).toMatch(/launchTooltip\([^)]*prTooltip, successTooltip, pendingInterruptedOn, pendingHandedOverOn\)/)
  })
})
