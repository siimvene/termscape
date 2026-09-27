import { describe, expect, it, vi } from 'vitest'
import { createReadRemotePage, forgetLocatedRef, rememberHookRef, type RemoteTranscriptRefCache } from './remote-transcript-page'
import type { RemoteFileRef } from './remote-ssh/remote-file'

const ref = (path: string): RemoteFileRef => ({
  conn: { host: 'h', user: 'u' } as RemoteFileRef['conn'],
  controlPath: '/cm',
  path
})
const cache = (): RemoteTranscriptRefCache => ({ bySession: new Map(), located: new Set() })
const q = { sessionId: 'sid', cwd: '/w', accountId: undefined, nodeId: 'nt-1' }
const PAGE = { before: null, maxBytes: 65536 }

describe('forgetLocatedRef', () => {
  it('drops a ref WE located, and only that', () => {
    const c = cache()
    c.bySession.set('located', ref('/a'))
    c.located.add('located')
    c.bySession.set('hooked', ref('/b'))
    expect(forgetLocatedRef(c, 'located')).toBe(true)
    expect(forgetLocatedRef(c, 'hooked')).toBe(false)
    expect([...c.bySession.keys()]).toEqual(['hooked'])
  })

  it('a hook event for a session we had located makes its ref hook-fed (no longer droppable)', () => {
    const c = cache()
    c.bySession.set('sid', ref('/located'))
    c.located.add('sid')
    rememberHookRef(c, 'sid', ref('/from-hook'))
    expect(forgetLocatedRef(c, 'sid')).toBe(false)
    expect(c.bySession.get('sid')?.path).toBe('/from-hook')
  })
})

describe('createReadRemotePage — the desktop remote leg of a paged chat read', () => {
  it('null when the session is not remote (core takes the local path)', async () => {
    const read = createReadRemotePage({ cache: cache(), refFor: async () => undefined, readPage: vi.fn() })
    expect(await read(q, PAGE)).toBeNull()
  })

  it('returns the ranged window it read', async () => {
    const readPage = vi.fn(async () => ({ data: Buffer.from('xy'), start: 7, end: 9, size: 9 }))
    const read = createReadRemotePage({ cache: cache(), refFor: async () => ref('/t.jsonl'), readPage })
    const r = await read(q, { before: 9, maxBytes: 70000 })
    expect(readPage).toHaveBeenCalledWith(ref('/t.jsonl'), 9, 70000)
    expect(r).toEqual({ ok: true, data: Buffer.from('xy'), start: 7 })
  })

  it('on a failed read: a HOOK-FED ref is kept (a master blip must not send the next read local)', async () => {
    const c = cache()
    c.bySession.set('sid', ref('/hooked'))
    const read = createReadRemotePage({
      cache: c,
      refFor: async () => c.bySession.get('sid'),
      readPage: async () => {
        throw new Error('master down')
      }
    })
    expect(await read(q, PAGE)).toEqual({ ok: false })
    expect(c.bySession.has('sid')).toBe(true)
  })

  it('on a failed read: a ref WE located is forgotten (so Retry locates again instead of replaying a dead path)', async () => {
    const c = cache()
    c.bySession.set('sid', ref('/located'))
    c.located.add('sid')
    const read = createReadRemotePage({
      cache: c,
      refFor: async () => c.bySession.get('sid'),
      readPage: async () => {
        throw new Error('gone')
      }
    })
    expect(await read(q, PAGE)).toEqual({ ok: false })
    expect(c.bySession.has('sid')).toBe(false)
    expect(c.located.has('sid')).toBe(false)
  })
})
