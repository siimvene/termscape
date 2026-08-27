import { describe, expect, it } from 'vitest'
import { activeUsageAccountId } from './activeUsageAccount'

const agent = (id: string, accountId?: string) => ({ id, accountId, isAgent: true })

describe('activeUsageAccountId', () => {
  it('leads with the most recently ACTIVE agent session account', () => {
    const nodes = [agent('a', undefined), agent('b', 'taltech'), agent('c', 'plg')]
    const status = { a: { lastEventAt: 100 }, b: { lastEventAt: 300 }, c: { lastEventAt: 200 } }
    expect(activeUsageAccountId(nodes, status, undefined)).toBe('taltech')
  })

  it('a system-account session can be the active one (undefined wins on recency)', () => {
    const nodes = [agent('a', undefined), agent('b', 'taltech')]
    const status = { a: { lastEventAt: 500 }, b: { lastEventAt: 300 } }
    expect(activeUsageAccountId(nodes, status, 'plg')).toBeUndefined()
  })

  it('no transient clocks (fresh app relaunch) → the project default', () => {
    const nodes = [agent('a', 'taltech'), agent('b', 'plg')]
    expect(activeUsageAccountId(nodes, {}, 'plg')).toBe('plg')
  })

  it('no clocks, no default → system (undefined)', () => {
    expect(activeUsageAccountId([agent('a', 'taltech')], {}, undefined)).toBeUndefined()
  })

  it('plain terminals never vote — they spend no Claude quota', () => {
    const nodes = [
      { id: 't', accountId: 'plg', isAgent: false },
      agent('b', 'taltech')
    ]
    const status = { t: { lastEventAt: 900 }, b: { lastEventAt: 100 } }
    expect(activeUsageAccountId(nodes, status, undefined)).toBe('taltech')
  })

  it('empty accountId string reads as system', () => {
    const nodes = [agent('a', '')]
    expect(activeUsageAccountId(nodes, { a: { lastEventAt: 1 } }, undefined)).toBeUndefined()
  })
})
