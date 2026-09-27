import { describe, expect, it } from 'vitest'
import type { MenuItem } from '../components/ContextMenu'
import {
  linkMenuItems,
  relativeInside,
  resolveLinkTarget,
  urlLinkMenuItems,
  type LinkMenuActions,
  type LinkMenuContext,
  type LinkMenuTarget
} from './link-menu'

/** Every action records its call, so a test can click a row and see what it did. */
function recorder(): { calls: string[]; act: LinkMenuActions } {
  const calls: string[] = []
  const act: LinkMenuActions = {
    openUrl: (u) => calls.push(`openUrl ${u}`),
    openUrlInNode: (u) => calls.push(`openUrlInNode ${u}`),
    copy: (t) => calls.push(`copy ${t}`),
    openFile: (p) => calls.push(`openFile ${p}`),
    revealInExplorer: (p) => calls.push(`revealInExplorer ${p}`),
    revealInOs: (p) => calls.push(`revealInOs ${p}`),
    openTerminal: (p) => calls.push(`openTerminal ${p}`),
    download: (p, dir, pick) => calls.push(`download ${p} dir=${dir} pick=${pick}`)
  }
  return { calls, act }
}

const LOCAL_DESKTOP: LinkMenuContext = {
  route: 'none',
  localShell: true,
  explorerRoot: '/home/me/proj',
  terminals: true,
  downloading: () => false
}

const SSH_DESKTOP: LinkMenuContext = {
  route: 'scp',
  localShell: false,
  explorerRoot: '~/proj',
  terminals: true,
  downloading: () => false
}

const labels = (items: MenuItem[]): string[] =>
  items.map((i) => (i.type === 'separator' ? '---' : 'label' in i ? i.label : `<${i.type}>`))

function click(items: MenuItem[], label: string): void {
  const item = items.find((i) => (i.type === undefined || i.type === 'item') && i.label === label)
  if (!item || (item.type !== undefined && item.type !== 'item')) throw new Error(`no row ${label}`)
  item.onClick()
}

describe('linkMenuItems — URL', () => {
  const url: LinkMenuTarget = { kind: 'url', url: 'https://example.com/a' }

  it('offers open, open-in-canvas and copy', () => {
    const { calls, act } = recorder()
    const items = linkMenuItems(url, LOCAL_DESKTOP, act)
    expect(labels(items)).toEqual(['Open in browser', 'Open in canvas browser', '---', 'Copy link'])
    click(items, 'Open in browser')
    click(items, 'Open in canvas browser')
    click(items, 'Copy link')
    expect(calls).toEqual([
      'openUrl https://example.com/a',
      'openUrlInNode https://example.com/a',
      'copy https://example.com/a'
    ])
  })

  it('offers no canvas-browser row when the host gives no way to open one (browser tab, card modal)', () => {
    const { calls, act } = recorder()
    const { openUrlInNode: _omitted, ...urlOnly } = act
    const items = urlLinkMenuItems('https://example.com/a', urlOnly)
    expect(labels(items)).toEqual(['Open in browser', '---', 'Copy link'])
    click(items, 'Copy link')
    expect(calls).toEqual(['copy https://example.com/a'])
  })
})

describe('linkMenuItems — file', () => {
  it('SSH project: a file under the project root can be opened, revealed, downloaded and copied', () => {
    const { calls, act } = recorder()
    const target: LinkMenuTarget = { kind: 'file', abs: '~/proj/out/report.csv', dir: false }
    const items = linkMenuItems(target, SSH_DESKTOP, act)
    expect(labels(items)).toEqual([
      'Open',
      'Reveal in Explorer',
      '---',
      'Download',
      'Download to…',
      '---',
      'Copy path',
      'Copy relative path'
    ])
    click(items, 'Download')
    click(items, 'Download to…')
    click(items, 'Copy relative path')
    click(items, 'Open')
    click(items, 'Reveal in Explorer')
    expect(calls).toEqual([
      'download ~/proj/out/report.csv dir=false pick=false',
      'download ~/proj/out/report.csv dir=false pick=true',
      'copy out/report.csv',
      'openFile ~/proj/out/report.csv',
      'revealInExplorer ~/proj/out/report.csv'
    ])
  })

  it('desktop local project: no Download (the file is already here), Reveal in Finder instead', () => {
    const target: LinkMenuTarget = { kind: 'file', abs: '/home/me/proj/a.csv', dir: false }
    const items = linkMenuItems(target, LOCAL_DESKTOP, recorder().act)
    expect(labels(items)).toEqual([
      'Open',
      'Reveal in Explorer',
      '---',
      'Copy path',
      'Copy relative path',
      'Reveal in Finder'
    ])
  })

  it('Server Edition: the HTTP route has no "Download to…" and no OS reveal', () => {
    const ctx: LinkMenuContext = { ...LOCAL_DESKTOP, route: 'http', localShell: false }
    const items = linkMenuItems({ kind: 'file', abs: '/home/me/proj/a.csv', dir: false }, ctx, recorder().act)
    expect(labels(items)).toContain('Download')
    expect(labels(items)).not.toContain('Download to…')
    expect(labels(items)).not.toContain('Reveal in Finder')
  })

  it('a path outside the Explorer root offers no Reveal in Explorer (it would open onto nothing)', () => {
    const items = linkMenuItems({ kind: 'file', abs: '/tmp/x.csv', dir: false }, SSH_DESKTOP, recorder().act)
    expect(labels(items)).toEqual(['Open', '---', 'Download', 'Download to…', '---', 'Copy path'])
  })

  it('disables Download while the same path is still downloading (a second start lands `name (2)`)', () => {
    const ctx: LinkMenuContext = { ...SSH_DESKTOP, downloading: (p) => p === '/tmp/x.csv' }
    const items = linkMenuItems({ kind: 'file', abs: '/tmp/x.csv', dir: false }, ctx, recorder().act)
    const dl = items.filter((i) => 'label' in i && i.label.startsWith('Download'))
    expect(dl).toHaveLength(2)
    for (const row of dl) expect(row).toMatchObject({ disabled: true, hint: 'Already downloading' })
  })
})

describe('linkMenuItems — folder', () => {
  it('reveals, opens a terminal there, downloads the folder', () => {
    const { calls, act } = recorder()
    const items = linkMenuItems({ kind: 'file', abs: '~/proj/out', dir: true }, SSH_DESKTOP, act)
    expect(labels(items)).toEqual([
      'Reveal in Explorer',
      'New terminal here',
      '---',
      'Download folder',
      'Download to…',
      '---',
      'Copy path',
      'Copy relative path'
    ])
    click(items, 'New terminal here')
    click(items, 'Download folder')
    expect(calls).toEqual(['openTerminal ~/proj/out', 'download ~/proj/out dir=true pick=false'])
  })

  it('names the archive on the HTTP route', () => {
    const ctx: LinkMenuContext = { ...LOCAL_DESKTOP, route: 'http' }
    const items = linkMenuItems({ kind: 'file', abs: '/home/me/proj/out', dir: true }, ctx, recorder().act)
    expect(labels(items)).toContain('Download folder (.tar.gz)')
  })

  it('never offers to download `/` (the HTTP route would archive the whole server)', () => {
    const ctx: LinkMenuContext = { ...LOCAL_DESKTOP, route: 'http', explorerRoot: undefined }
    const items = linkMenuItems({ kind: 'file', abs: '/', dir: true }, ctx, recorder().act)
    expect(labels(items).some((l) => l.startsWith('Download'))).toBe(false)
  })

  it('leaves no dangling rule when a whole block is withheld (relay: no terminal, outside root)', () => {
    const ctx: LinkMenuContext = { ...LOCAL_DESKTOP, localShell: false, terminals: false }
    const items = linkMenuItems({ kind: 'file', abs: '/tmp/out', dir: true }, ctx, recorder().act)
    expect(labels(items)).toEqual(['Copy path'])
  })
})

describe('linkMenuItems — a path that does not exist', () => {
  it('says so and still lets the text be copied (the right-click was swallowed — never a dead click)', () => {
    const { calls, act } = recorder()
    const items = linkMenuItems({ kind: 'missing', abs: '/home/me/proj/gone.csv' }, LOCAL_DESKTOP, act)
    expect(labels(items)).toEqual(['Not found', 'Copy path'])
    click(items, 'Copy path')
    expect(calls).toEqual(['copy /home/me/proj/gone.csv'])
  })
})

describe('relativeInside', () => {
  it('is the path below the root, or null', () => {
    expect(relativeInside('/a/b', '/a/b/c/d.ts')).toBe('c/d.ts')
    expect(relativeInside('/a/b/', '/a/b/c')).toBe('c')
    expect(relativeInside('~/proj', '~/proj/x.csv')).toBe('x.csv')
    expect(relativeInside('/a/b', '/a/bc/d')).toBeNull()
    expect(relativeInside('/a/b', '/a/b')).toBeNull()
    expect(relativeInside(undefined, '/a/b')).toBeNull()
  })

  it('compares Windows paths across separators', () => {
    expect(relativeInside('C:\\Users\\me\\proj', 'C:/Users/me/proj/src/a.ts')).toBe('src/a.ts')
  })
})

describe('resolveLinkTarget', () => {
  it('passes a URL through and resolves a path by existence', async () => {
    const lookup = async (abs: string) =>
      abs === '/d' ? { exists: true, dir: true } : abs === '/f' ? { exists: true, dir: false } : { exists: false, dir: false }
    expect(await resolveLinkTarget({ kind: 'url', url: 'https://x.io' }, lookup)).toEqual({ kind: 'url', url: 'https://x.io' })
    expect(await resolveLinkTarget({ kind: 'path', abs: '/d' }, lookup)).toEqual({ kind: 'file', abs: '/d', dir: true })
    expect(await resolveLinkTarget({ kind: 'path', abs: '/f' }, lookup)).toEqual({ kind: 'file', abs: '/f', dir: false })
    expect(await resolveLinkTarget({ kind: 'path', abs: '/nope' }, lookup)).toEqual({ kind: 'missing', abs: '/nope' })
  })

  it('reads a failed lookup (dead ControlMaster) as missing, never a throw', async () => {
    const lookup = async (): Promise<{ exists: boolean; dir: boolean }> => {
      throw new Error('ssh down')
    }
    expect(await resolveLinkTarget({ kind: 'path', abs: '/x' }, lookup)).toEqual({ kind: 'missing', abs: '/x' })
  })
})
