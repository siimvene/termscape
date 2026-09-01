import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import net from 'net'
import { startServer } from '../../src/server/index'

// Headless notification-host boot smoke: every core service (incl. the loopback hook server) boots,
// but NO public HTTP/WS listener is bound. Follows the same startServer harness as server-e2e, minus
// tmux/pty (nothing is spawned here), so it runs everywhere.
describe('server headless mode: boots core services, binds no public listener', () => {
  it('startServer with headless:true returns port 0 and closes cleanly', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-headless-'))
    // Don't hard-code a "surely free" port: a developer machine can genuinely have something
    // (including this app's own self-hosted server) already bound to a fixed guess like 8443.
    // Bind a throwaway listener on port 0 to get a kernel-assigned free port, close it
    // immediately, then use that port number as the *configured* port below — freeing the race
    // window is unavoidable but short, and this is the same probe-then-use pattern the rest of
    // the port-selection code in this repo relies on.
    const configuredPort = await new Promise<number>((resolve, reject) => {
      const probe = net.createServer()
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1', () => {
        const addr = probe.address()
        const assigned = typeof addr === 'object' && addr ? addr.port : 0
        probe.close(() => resolve(assigned))
      })
    })
    try {
      const srv = await startServer({
        port: configuredPort,
        host: '127.0.0.1',
        dataDir,
        rendererDir: path.join(dataDir, 'no-renderer'),
        insecureHttp: false,
        headless: true,
        // Never touch the developer's real ~/.claude — the hook would point into `dataDir`,
        // which the teardown removes, leaving a dangling hook that breaks agent sessions.
        installHooks: false
      })
      // Nothing bound: the sentinel port is 0.
      expect(srv.port).toBe(0)
      // And the configured port is NOT listening — a connect attempt is refused.
      const listening = await new Promise<boolean>((resolve) => {
        const sock = net
          .connect({ host: '127.0.0.1', port: configuredPort }, () => {
            sock.destroy()
            resolve(true)
          })
          .on('error', () => resolve(false))
        sock.setTimeout(500, () => {
          sock.destroy()
          resolve(false)
        })
      })
      expect(listening).toBe(false)
      await srv.close()
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  }, 30_000)
})
