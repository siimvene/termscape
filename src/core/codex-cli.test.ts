import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { codexApprovalValuesFrom } from './codex-cli'
import { CODEX_APP_SERVER_ARGS } from './usage/codex-usage'

/**
 * The four fixtures are REAL `codex --help` / `codex -h` output, captured by running the published
 * linux-x64 binaries (`npm pack @openai/codex@<v>-linux-x64`) rather than transcribed from an
 * issue. That distinction is the point of this file: #785 reported the removal as a 0.154 change,
 * and running the releases one at a time showed `untrusted` was already gone in **0.149.0** — five
 * releases earlier, so the "Manual kills the launch" window had been open far longer than the
 * report implied.
 */
const fixture = (name: string): string =>
  readFileSync(path.join(__dirname, '__fixtures__', 'codex', name), 'utf8')

describe('codexApprovalValuesFrom — real help pages', () => {
  it('reads the pre-removal vocabulary from codex 0.148.0 (long --help)', () => {
    expect(codexApprovalValuesFrom(fixture('help-0.148.0.txt'))).toEqual([
      'untrusted',
      'on-request',
      'never'
    ])
  })

  it('reads the post-removal vocabulary from codex 0.151.0 (long --help)', () => {
    expect(codexApprovalValuesFrom(fixture('help-0.151.0.txt'))).toEqual(['on-request', 'never'])
  })

  // `-h` renders the same fact inline and WRAPS IT mid-phrase ("… [possible" / "values: on-request,
  // never]"), which a line-by-line parser reads as no values at all.
  it('reads the inline `[possible values: …]` form from `-h`, wrapping included', () => {
    expect(codexApprovalValuesFrom(fixture('help-short-0.148.0.txt'))).toEqual([
      'untrusted',
      'on-request',
      'never'
    ])
    expect(codexApprovalValuesFrom(fixture('help-short-0.151.0.txt'))).toEqual([
      'on-request',
      'never'
    ])
  })

  /**
   * THE trap this parser was written around. `-s, --sandbox` carries its own `[possible values:
   * read-only, workspace-write, danger-full-access]` a few lines above `--ask-for-approval` on
   * every one of these pages, so a scan for "possible values" answers with the SANDBOX vocabulary
   * — and the launch line then says `--ask-for-approval read-only`, which is a dead node wearing a
   * valid-looking flag.
   */
  it('never returns the neighbouring --sandbox vocabulary', () => {
    for (const name of [
      'help-0.148.0.txt',
      'help-0.151.0.txt',
      'help-short-0.148.0.txt',
      'help-short-0.151.0.txt'
    ]) {
      const values = codexApprovalValuesFrom(fixture(name))
      // Asserted non-null FIRST and deliberately: `?? []` would let a parser that found nothing at
      // all pass this as vacuously clean, which is the one way a "never returns the wrong
      // vocabulary" test can be green while the parser is broken in both directions at once.
      expect(values, name).not.toBeNull()
      expect(values, name).toContain('never')
      for (const sandbox of ['read-only', 'workspace-write', 'danger-full-access'])
        expect(values, `${name} / ${sandbox}`).not.toContain(sandbox)
    }
  })
})

describe('codexApprovalValuesFrom — unknown is null, not empty', () => {
  // `null` and `[]` mean different things one layer up: null falls back to the baseline vocabulary
  // (today's command line), an empty list would forbid every value including the two that have
  // worked on every release. A probe that cannot read the page must say so.
  it.each([
    ['no output', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['a help page without the option', 'Usage: codex [OPTIONS]\n  -m, --model <MODEL>\n'],
    ['the option with no values at all', '  -a, --ask-for-approval <POLICY>\n          Configure it\n  -h, --help\n']
  ])('answers null for %s', (_label, input) => {
    expect(codexApprovalValuesFrom(input as string | null | undefined)).toBeNull()
  })

  it('drops tokens that are not plain flag values, and answers null if none survive', () => {
    // The help page is untrusted input at an interpolation site: these strings are appended to a
    // command typed into a tmux pane.
    const forged = [
      '  -a, --ask-for-approval <APPROVAL_POLICY>',
      '          Configure when the model requires human approval [possible values: $(id), `id`, a b, ok-1]',
      '  -h, --help'
    ].join('\n')
    expect(codexApprovalValuesFrom(forged)).toEqual(['ok-1'])

    const allForged = [
      '  -a, --ask-for-approval <APPROVAL_POLICY>',
      '          Configure it [possible values: ; rm -rf ~]',
      '  -h, --help'
    ].join('\n')
    expect(codexApprovalValuesFrom(allForged)).toBeNull()
  })
})

/**
 * The two facts that are NOT read off a probe, pinned at source level because the failure mode of
 * each is silence.
 */
describe('the codex vocabulary reaches every surface it has to', () => {
  const read = (rel: string): string =>
    readFileSync(path.join(__dirname, '..', ...rel.split('/')), 'utf8')

  /**
   * CLAUDE.md invariant: a probe registered in one shell and forgotten in the other gives the
   * Server Edition the feature's silence, and the boundary tests cannot tell you a handler is
   * MISSING. `registerGrokCliIpc`'s own comment in the server shell states this rule; this asserts
   * it for all three CLI probes rather than leaving it as a comment.
   */
  it('registers every CLI capability probe in BOTH shells', () => {
    const main = read('main/index.ts')
    const server = read('server/handlers/index.ts')
    for (const fn of ['registerClaudeCliIpc', 'registerGrokCliIpc', 'registerCodexCliIpc']) {
      expect(main, `main: ${fn}`).toContain(`${fn}()`)
      expect(server, `server: ${fn}`).toContain(`${fn}()`)
    }
  })

  /**
   * The app-server usage tier (issue #785's second half). It spawns `codex` directly, so the argv
   * is exported to be assertable rather than buried in the spawn — it was `-a untrusted` and on
   * every codex >= 0.149.0 clap refused the whole invocation, which made this tier return null
   * forever with nothing on screen to say why.
   *
   * MEASURED: `-s read-only -a never app-server` gets past clap on 0.148.0, 0.151.0 and 0.154.0
   * (all three then fail only on this container's missing sandbox helper, which is an environment
   * fact, not a flag one), while `-a untrusted` exits at the parser on 0.151.0 and 0.154.0.
   */
  it('asks the app-server for an approval policy both vocabularies contain', () => {
    const value = CODEX_APP_SERVER_ARGS[CODEX_APP_SERVER_ARGS.indexOf('-a') + 1]
    for (const vocabulary of [
      ['untrusted', 'on-request', 'never'], // codex <= 0.148.0
      ['on-request', 'never'] // codex >= 0.149.0
    ]) {
      expect(vocabulary, value).toContain(value)
    }
    // The sandbox is the guard that keeps a quota refresh away from the user's files, and it is a
    // separate axis from the approval policy — it must not be traded away for one.
    expect(CODEX_APP_SERVER_ARGS).toContain('read-only')
  })
})
