import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { readPeerClaudeAccounts } from './peer-claude-accounts'

describe('readPeerClaudeAccounts', () => {
  let peer: string
  beforeEach(() => {
    peer = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-accts-'))
  })
  afterEach(() => fs.rmSync(peer, { recursive: true, force: true }))

  const write = (claudeAccounts: unknown) =>
    fs.writeFileSync(path.join(peer, 'settings.json'), JSON.stringify({ claudeAccounts }))
  const dir = (id: string) => fs.mkdirSync(path.join(peer, 'claude-accounts', id), { recursive: true })

  it('offers only spawnable rows: not pending, not host-pinned, dir present, safe id; strings bounded', () => {
    write([
      { id: 'ok-1', label: 'Work', email: 'w@x', pending: false, createdAt: 5, color: '#fff', extra: 1 },
      { id: 'pend', label: 'Pending', pending: true },
      { id: 'remote', label: 'Remote', host: 'box' },
      { id: 'nodir', label: 'No dir' },
      { id: '../escape', label: 'Bad id' },
      { id: 'long', label: 'x'.repeat(500), email: 'y'.repeat(500) },
      'junk',
      null,
      { label: 'no id' }
    ])
    for (const id of ['ok-1', 'pend', 'remote', 'long']) dir(id)
    fs.mkdirSync(path.join(peer, 'claude-accounts', '..', 'escape'), { recursive: true })
    const rows = readPeerClaudeAccounts(peer)
    expect(rows.map((r) => r.id)).toEqual(['ok-1', 'long'])
    expect(rows[0]).toEqual({ id: 'ok-1', label: 'Work', email: 'w@x', createdAt: 5 })
    expect(rows[1].label.length).toBe(200)
    expect(rows[1].email?.length).toBe(320)
  })

  it('label falls back to the id; absent / corrupt / foreign-shaped settings → []', () => {
    write([{ id: 'nolabel' }])
    dir('nolabel')
    expect(readPeerClaudeAccounts(peer)).toEqual([{ id: 'nolabel', label: 'nolabel' }])
    fs.writeFileSync(path.join(peer, 'settings.json'), '{not json')
    expect(readPeerClaudeAccounts(peer)).toEqual([])
    fs.writeFileSync(path.join(peer, 'settings.json'), JSON.stringify({ claudeAccounts: 'nope' }))
    expect(readPeerClaudeAccounts(peer)).toEqual([])
    fs.rmSync(path.join(peer, 'settings.json'))
    expect(readPeerClaudeAccounts(peer)).toEqual([])
  })
})
