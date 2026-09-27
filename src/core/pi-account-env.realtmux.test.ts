// ISSUE #419 for managed PI accounts, PROVEN AGAINST A REAL TMUX: a tmux server inherits the env
// of whichever client STARTS it, so a server started by a pi-account node's client (which carries
// `PI_CODING_AGENT_DIR=<account dir>`, pty-manager's spawn env) holds that dir in its GLOBAL env.
// Without PI_CODING_AGENT_DIR in the LOCAL conf's update-environment (ACCOUNT_SCOPE_UPDATE_ENV),
// every later session created without a `-e` override — system pi nodes, plain terminals, the
// missing-dir fallback — silently ran pi as that account. Measured with the EXACT conf text
// `tmuxConf()` ships, on a private socket (same harness as account-env.realtmux.test.ts).
//
// MUTATION: drop PI_CODING_AGENT_DIR from ACCOUNT_SCOPE_UPDATE_ENV ⇒ the system-session case prints
// the seeded account dir and reddens.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { tmuxConf } from './pty-manager'
import { makeTmuxTmpdir } from './tmux-test-socket'

const SOCKET = `nt-piaccttest-${process.pid}`

let tmp: string
let conf: string
let tmuxOk = false

/** process.env minus PI_CODING_AGENT_DIR, so a developer's own exported value can never seed or
 *  satisfy an assertion. */
function cleanEnv(): Record<string, string | undefined> {
  const e = { ...process.env }
  delete e.PI_CODING_AGENT_DIR
  return e
}

function tmux(args: string[], env?: Record<string, string>): string {
  // TMUX_TMPDIR last: a caller's `env` chooses what the CLIENT carries, never which server it reaches.
  return execFileSync('tmux', ['-L', SOCKET, ...args], {
    env: { ...cleanEnv(), ...env, TMUX_TMPDIR: tmp },
    stdio: ['ignore', 'pipe', 'pipe']
  }).toString()
}

beforeAll(() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    tmuxOk = true
  } catch {
    return // no tmux on this host — every test below self-skips
  }
  tmp = makeTmuxTmpdir('ntpiacct-', SOCKET)
  conf = path.join(tmp, 'tmux.conf')
  fs.writeFileSync(conf, tmuxConf(2000))
})

afterAll(() => {
  if (!tmuxOk) return
  try {
    tmux(['kill-server'])
  } catch {
    /* already gone */
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

const waitFor = async (file: string, ms = 3000): Promise<string> => {
  const t0 = Date.now()
  for (;;) {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8')
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${file}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('managed pi account isolation on a shared tmux server (issue #419)', () => {
  it('a pi-account node (client env + -e, the pty-manager shape) sees its own agent dir', async () => {
    if (!tmuxOk) return
    const out = path.join(tmp, 'pi-account-pane')
    // This FIRST create also starts the server, seeding its global env with the account dir.
    tmux(
      [
        '-f', conf, 'new-session', '-d',
        '-e', 'PI_CODING_AGENT_DIR=/ud/pi-accounts/p1',
        '-s', 'pi-acct',
        `echo "PI=[$PI_CODING_AGENT_DIR]" > ${out}; sleep 5`
      ],
      { PI_CODING_AGENT_DIR: '/ud/pi-accounts/p1' }
    )
    expect(await waitFor(out)).toBe('PI=[/ud/pi-accounts/p1]\n')
    expect(tmux(['show-environment', '-g'])).toContain('PI_CODING_AGENT_DIR=/ud/pi-accounts/p1')
  })

  it('a SYSTEM session on that seeded server does NOT inherit the pi account', async () => {
    if (!tmuxOk) return
    const out = path.join(tmp, 'pi-system-pane')
    tmux(['new-session', '-d', '-s', 'pi-system', `echo "PI=[$PI_CODING_AGENT_DIR]" > ${out}`])
    expect(await waitFor(out)).toBe('PI=[]\n')
  })

  it('a second pi-account node on the seeded server gets ITS dir, not the seed', async () => {
    if (!tmuxOk) return
    const out = path.join(tmp, 'pi-account2-pane')
    tmux(
      [
        'new-session', '-d',
        '-e', 'PI_CODING_AGENT_DIR=/ud/pi-accounts/p2',
        '-s', 'pi-acct2',
        `echo "PI=[$PI_CODING_AGENT_DIR]" > ${out}`
      ],
      { PI_CODING_AGENT_DIR: '/ud/pi-accounts/p2' }
    )
    expect(await waitFor(out)).toBe('PI=[/ud/pi-accounts/p2]\n')
  })
})
