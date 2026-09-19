import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import {
  adminKeysBlockActive,
  administratorsKeysPath,
  isAdministratorsMember,
  windowsKeyFileFor
} from './windows-ssh-keys'

// The tail of Microsoft's shipped sshd_config (PowerShell/openssh-portable
// contrib/win32/openssh/sshd_config), as measured on OpenSSH_for_Windows_9.5p2 in #758.
const STOCK = `# This is the sshd server system-wide configuration file.
AuthorizedKeysFile	.ssh/authorized_keys
PasswordAuthentication yes
Subsystem	sftp	sftp-server.exe

Match Group administrators
       AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys
`

const ADMIN_ROW = '"BUILTIN\\Administrators","Alias","S-1-5-32-544","Group used for deny only"'
const USERS_ROW = '"BUILTIN\\Users","Alias","S-1-5-32-545","Mandatory group, Enabled by default, Enabled group"'

describe('adminKeysBlockActive', () => {
  it('finds the shipped block', () => {
    expect(adminKeysBlockActive(STOCK)).toBe(true)
    expect(adminKeysBlockActive(STOCK.replace(/\n/g, '\r\n'))).toBe(true)
  })

  it('ignores the block once an administrator comments it out', () => {
    expect(
      adminKeysBlockActive(STOCK.replace('Match Group', '#Match Group').replace('       Authorized', '#       Authorized'))
    ).toBe(false)
  })

  it('does not credit a global AuthorizedKeysFile, nor another group, nor a block that points elsewhere', () => {
    expect(adminKeysBlockActive('AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys\n')).toBe(false)
    expect(adminKeysBlockActive('Match Group sshusers\n AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys\n')).toBe(false)
    expect(adminKeysBlockActive('Match Group administrators\n AuthorizedKeysFile .ssh/authorized_keys\n')).toBe(false)
  })

  it('ends a Match block at the next Match', () => {
    expect(
      adminKeysBlockActive('Match Group administrators\n PasswordAuthentication no\nMatch User bob\n AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys\n')
    ).toBe(false)
  })

  it('accepts sshd’s case-insensitive keywords, a quoted group list and a domain-qualified name', () => {
    expect(adminKeysBlockActive('match group "sshusers,Administrators"\n authorizedkeysfile __PROGRAMDATA__/ssh/administrators_authorized_keys')).toBe(true)
    expect(adminKeysBlockActive('Match User me Group BUILTIN\\Administrators\n AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys')).toBe(true)
  })
})

describe('isAdministratorsMember', () => {
  it('matches the SID, so a localized group name changes nothing', () => {
    expect(isAdministratorsMember(`${USERS_ROW}\r\n${ADMIN_ROW.replace('Administrators', 'Administratoren')}\r\n`)).toBe(true)
    expect(isAdministratorsMember(`${USERS_ROW}\r\n`)).toBe(false)
  })
})

describe('windowsKeyFileFor', () => {
  it('is the administrators file only for a member under an active block', () => {
    expect(windowsKeyFileFor({ sshdConfig: STOCK, whoamiGroupsCsv: ADMIN_ROW })).toBe('administrators')
    expect(windowsKeyFileFor({ sshdConfig: STOCK, whoamiGroupsCsv: USERS_ROW })).toBe('profile')
    expect(windowsKeyFileFor({ sshdConfig: 'PasswordAuthentication yes', whoamiGroupsCsv: ADMIN_ROW })).toBe('profile')
  })

  it('says unknown when either input could not be read, rather than guessing', () => {
    expect(windowsKeyFileFor({ sshdConfig: null, whoamiGroupsCsv: ADMIN_ROW })).toBe('unknown')
    expect(windowsKeyFileFor({ sshdConfig: STOCK, whoamiGroupsCsv: null })).toBe('unknown')
  })
})

describe('administratorsKeysPath', () => {
  it('resolves with Windows path rules on any runner', () => {
    expect(administratorsKeysPath({ ProgramData: 'D:\\PD' })).toBe('D:\\PD\\ssh\\administrators_authorized_keys')
    expect(administratorsKeysPath({})).toBe('C:\\ProgramData\\ssh\\administrators_authorized_keys')
  })
})

// Windows-only because it runs the real `whoami`: it proves the CSV shape the parser assumes. The
// GitHub windows-latest runner account is a local administrator.
describe('real whoami', () => {
  it.skipIf(process.platform !== 'win32')('prints the Administrators SID the way the parser reads it', () => {
    const csv = execFileSync('whoami', ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf8' })
    expect(isAdministratorsMember(csv)).toBe(true)
  })
})
