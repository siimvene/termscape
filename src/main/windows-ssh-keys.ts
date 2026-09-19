// Which authorized_keys file Windows OpenSSH reads for THIS account — detected only to EXPLAIN
// why phone pairing installs no SSH key on Windows (issue #758). Nothing here writes a key.
//
// Microsoft's shipped sshd_config ends with
//
//   Match Group administrators
//          AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys
//
// so for an account in the local Administrators group sshd ignores `~/.ssh/authorized_keys` and
// reads a MACHINE-WIDE file that only an elevated process can write, and whose ACL must be
// Administrators + SYSTEM only (measured by the #758 reporter on OpenSSH_for_Windows_9.5p2). The
// decision is the server's EFFECTIVE configuration for the TARGET account — an administrator can
// delete that block — not whether nodeterm happens to run elevated, so both inputs are read.
//
// Every read fails soft to `unknown`: this feeds a sentence in the UI, never a decision.

import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'

export type WindowsKeyFile = 'administrators' | 'profile' | 'unknown'

/** The well-known SID of BUILTIN\Administrators — matched by SID so a localized group name
 *  ("Administratoren", "Administrateurs") changes nothing. */
const ADMINISTRATORS_SID = 'S-1-5-32-544'

/**
 * Does an active `Match Group …administrators…` block point `AuthorizedKeysFile` at the
 * administrators file? Comments and blank lines are ignored; a `Match` block ends at the next
 * `Match`. Keywords are case-insensitive, as sshd's are.
 */
export function adminKeysBlockActive(sshdConfig: string): boolean {
  let inAdminMatch = false
  for (const raw of sshdConfig.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim()
    if (!line) continue
    const [keyword, ...rest] = line.split(/\s+/)
    const value = rest.join(' ')
    if (/^match$/i.test(keyword)) {
      // `Match Group administrators` / `Match Group "administrators,other"` / `Match User x Group y`
      const criteria = value.split(/\s+/)
      inAdminMatch = false
      for (let i = 0; i < criteria.length - 1; i++) {
        if (!/^group$/i.test(criteria[i])) continue
        const groups = criteria[i + 1].replace(/"/g, '').split(',')
        if (groups.some((g) => /(^|\\)administrators$/i.test(g.trim()))) inAdminMatch = true
      }
      continue
    }
    if (inAdminMatch && /^authorizedkeysfile$/i.test(keyword)) {
      if (/administrators_authorized_keys/i.test(value)) return true
    }
  }
  return false
}

/** Is `S-1-5-32-544` among the groups `whoami /groups /fo csv /nh` printed? A filtered UAC token
 *  lists it as "Group used for deny only" — still a member, which is what sshd matches on. */
export function isAdministratorsMember(whoamiGroupsCsv: string): boolean {
  return whoamiGroupsCsv.split(/\r?\n/).some((row) => row.includes(`"${ADMINISTRATORS_SID}"`))
}

export function windowsKeyFileFor(input: {
  sshdConfig: string | null
  whoamiGroupsCsv: string | null
}): WindowsKeyFile {
  if (input.sshdConfig === null || input.whoamiGroupsCsv === null) return 'unknown'
  if (!adminKeysBlockActive(input.sshdConfig)) return 'profile'
  return isAdministratorsMember(input.whoamiGroupsCsv) ? 'administrators' : 'profile'
}

/** `%ProgramData%\ssh`, resolved with Windows path rules whatever OS runs this. */
export function programDataSshDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData', 'ssh')
}

export function administratorsKeysPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(programDataSshDir(env), 'administrators_authorized_keys')
}

/** Read both inputs on a real Windows machine. `whoami` runs with a fixed argv, no shell. */
export async function detectWindowsKeyFile(env: NodeJS.ProcessEnv = process.env): Promise<WindowsKeyFile> {
  const sshdConfig = await fs
    .readFile(path.win32.join(programDataSshDir(env), 'sshd_config'), 'utf8')
    .catch(() => null)
  const whoamiGroupsCsv = await new Promise<string | null>((resolve) => {
    execFile('whoami', ['/groups', '/fo', 'csv', '/nh'], { timeout: 3000, windowsHide: true }, (err, stdout) =>
      resolve(err ? null : String(stdout))
    )
  })
  return windowsKeyFileFor({ sshdConfig, whoamiGroupsCsv })
}
