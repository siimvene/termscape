import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { Project } from '@shared/types'
import { countKnownUnread, knownNodeIdsFromSig, knownNodeIdsSig } from './dockBadge'

const project = (id: string, nodeIds: string[], closed = false): Project =>
  ({ id, name: id, closed, nodes: nodeIds.map((n) => ({ id: n })) }) as unknown as Project

describe('dock badge counts only nodes that still exist', () => {
  const projects = [project('a', ['n1', 'n2']), project('b', ['n3'], true)]
  const known = knownNodeIdsFromSig(knownNodeIdsSig(projects))

  it('ignores unread flags of nodes no project holds (the 2026-10-09 phantom "3")', () => {
    const byId = {
      n1: { unread: true },
      ghost1: { unread: true },
      ghost2: { unread: true },
      ghost3: { unread: true }
    }
    expect(countKnownUnread(byId, known)).toBe(1)
  })

  it('counts a closed project’s nodes: closed is parked, not gone', () => {
    expect(countKnownUnread({ n3: { unread: true } }, known)).toBe(1)
  })

  it('counts only unread, and survives undefined slots', () => {
    expect(countKnownUnread({ n1: { unread: false }, n2: undefined, n3: {} }, known)).toBe(0)
  })

  it('an orphan counts again once its project loads (the table is never pruned)', () => {
    const byId = { late: { unread: true } }
    expect(countKnownUnread(byId, known)).toBe(0)
    const later = knownNodeIdsFromSig(knownNodeIdsSig([...projects, project('ssh', ['late'])]))
    expect(countKnownUnread(byId, later)).toBe(1)
  })

  it('no projects means nothing to count', () => {
    expect(knownNodeIdsFromSig(knownNodeIdsSig([])).size).toBe(0)
    expect(countKnownUnread({ x: { unread: true } }, knownNodeIdsFromSig(''))).toBe(0)
  })

  it('Canvas feeds the Dock badge through the known-node filter, never a bare byId count', () => {
    const src = fs
      .readFileSync(path.join(__dirname, '../canvas/Canvas.tsx'), 'utf8')
      .replace(/\r\n/g, '\n')
    const at = src.indexOf('window.nodeTerminal.setBadgeCount(unreadCount)')
    expect(at).toBeGreaterThan(0)
    const block = src.slice(Math.max(0, at - 1200), at)
    expect(block).toContain('countKnownUnread(s.byId, knownIds)')
    expect(block).toContain('knownNodeIdsSig(s.projects)')
    expect(block).not.toMatch(/for \(const st of Object\.values\(s\.byId\)\) if \(st\?\.unread\) count\+\+/)
  })
})
