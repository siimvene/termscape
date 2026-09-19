// The shell must FORWARD the agent identity into the ownership record, and no type can make it.
//
// `hookServer.setCodexThread{Start,Bind}Handler` take a request object. A handler that destructures
// `{ nodeId, cwd, hookEndpoint, accountId }` and drops `agent` is perfectly well-typed — an object
// destructure is allowed to ignore properties — and so is a call to `writeCodexThreadIdentity`
// that omits its optional trailing argument. So the whole agent dimension can be plumbed through
// core, the route, the launcher and the sh prelude, pass `npm run typecheck`, pass every unit test,
// and still be INERT in the shipped desktop app: every record written would carry no agent line,
// every one would read back as the implied `codex` with the grant, and the mislabel this exists to
// remove would survive untouched with a green suite. That happened once while writing this change.
//
// It is the same class of hole `hook-verified-parity.test.ts` was written for — "the boundary tests
// cannot tell you a field is MISSING" — and the same remedy: pin it at SOURCE level.
//
// Only `src/main` registers these handlers today. If the Server Edition ever grows a shared-Codex
// leg it must be added to `SHELLS` below, or it inherits exactly this silence.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const SHELLS = [{ name: 'desktop', file: join(__dirname, 'index.ts') }] as const

/**
 * The text of one handler registration: from its `setCodexThread…Handler(` to the closing `})` that
 * ends the call. Found by brace-free scanning for the terminator at the registration's own
 * indentation, which is enough here and keeps the guard free of a TS parser.
 */
function handlerBody(source: string, setter: string): string {
  const start = source.indexOf(`hookServer.${setter}(`)
  expect(start, `${setter} is not registered — this guard is looking at the wrong file`).toBeGreaterThan(-1)
  const end = source.indexOf('\n  })', start)
  expect(end, `${setter} has no recognisable end`).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('the desktop shell forwards Codex agent identity into the ownership record', () => {
  for (const shell of SHELLS) {
    const source = readFileSync(shell.file, 'utf8')

    for (const [setter, writer] of [
      ['setCodexThreadStartHandler', 'writeCodexThreadIdentity'],
      ['setCodexThreadBindHandler', 'bindCodexThreadIdentity']
    ] as const) {
      const body = handlerBody(source, setter)

      it(`${shell.name}: ${setter} destructures the agent off the request`, () => {
        // Without this the field is silently dropped at the very first line of the handler.
        expect(body).toMatch(/\{[^}]*\bagent\b[^}]*\}/)
      })

      it(`${shell.name}: ${setter} passes it to ${writer}`, () => {
        const call = body.slice(body.indexOf(writer))
        expect(call, `${writer} is not called in ${setter}`).not.toBe('')
        // The argument list must actually name it. A record written without it is a PRE-AGENT
        // record: legal, readable, and wrong for every node whose agent is not plain codex.
        expect(call).toMatch(/\bagent\b/)
      })
    }
  }
})
