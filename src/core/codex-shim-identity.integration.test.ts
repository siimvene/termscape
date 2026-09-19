// A shared Codex app-server forks tool shells without the pane's NODETERM_* environment. These
// tests run both generated local shims under real /bin/sh with only CODEX_THREAD_ID, proving that
// the signed ownership-record prelude executes before either shim's "not a nodeterm node" gate.
import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { buildControlShimScript } from './canvas-control-core'
import { buildContextShimScript } from './context-link-core'

const run = promisify(execFile)
const cleanup: string[] = []

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('local Codex tool-shell identity recovery', () => {
  for (const [name, build] of [
    ['canvas control', buildControlShimScript],
    ['linked context', buildContextShimScript]
  ] as const) {
    it(`${name} resolves CODEX_THREAD_ID before its NODETERM_* gate`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'nodeterm-codex-local-shim-'))
      cleanup.push(dir)
      const root = join(dir, 'codex-thread-nodes')
      const built = build(root)

      const bin = join(dir, 'bin')
      const endpoint = join(dir, 'hook-endpoint.env')
      const tokens = join(dir, 'node-tokens')
      const capture = join(dir, 'curl-args')
      const script = join(dir, 'shim.sh')
      mkdirSync(root)
      mkdirSync(bin)
      mkdirSync(tokens)
      writeFileSync(
        join(root, 'thread-1'),
        `accountId=\nnodeId=node-1\nendpoint=${endpoint}\nsignature=test-fixture\n`,
        { mode: 0o600 }
      )
      writeFileSync(
        endpoint,
        `NODETERM_HOOK_PORT=54321\nNODETERM_HOOK_TOKEN=test-hook\n` +
          `NODETERM_HOOK_VERSION=2\nNODETERM_NODE_TOKEN_DIR=${tokens}\n`,
        { mode: 0o600 }
      )
      writeFileSync(join(tokens, 'node-1'), 'test-node-token\n', { mode: 0o600 })
      writeFileSync(script, built, { mode: 0o755 })
      writeFileSync(
        join(bin, 'curl'),
        `#!/bin/sh
nt_out=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift; nt_out="$1" ;;
    --data-urlencode) shift; printf '%s\n' "$1" >> "$NT_CAPTURE" ;;
  esac
  shift
done
[ -n "$nt_out" ] && printf 'ok\n' > "$nt_out"
printf '200'
`,
        { mode: 0o755 }
      )

      const result = await run('/bin/sh', [script, 'list'], {
        env: {
          PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
          CODEX_THREAD_ID: 'thread-1',
          NT_CAPTURE: capture
        }
      })

      expect(result.stdout.trim()).toBe('ok')
      expect(readFileSync(capture, 'utf8').split('\n')).toContain('nodeId=node-1')
    })
  }
})
