import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  promises as fs,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { IPC } from '../shared/ipc'
import { sanitizeKeybindingOverrides } from '../shared/keybindings'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import {
  SettingsStore,
  SettingsCorruptError,
  SettingsUnreadableError,
  SettingsWriteConflictError
} from './settings-store'
import { DEFAULT_SETTINGS, type Settings } from '../shared/types'

describe('SettingsStore nested-default merge', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'nodeterm-settings-store-'))
    initPlatform(fakePlatform({ userDataDir: dir }))
  })

  afterEach(() => {
    resetPlatformForTests()
    rmSync(dir, { recursive: true, force: true })
  })

  it('fills a missing nested speech.shortcut from an OLD settings.json (speech present, shortcut absent)', () => {
    writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ fontSize: 15, speech: { engine: 'whisper', model: 'tiny', language: 'auto' } }),
      'utf-8'
    )
    const store = new SettingsStore()
    store.init()
    const s = store.get()
    expect(s.speech.shortcut).toBe(DEFAULT_SETTINGS.speech.shortcut)
    // Sibling nested fields the old file DID set must survive the merge untouched.
    expect(s.speech.engine).toBe('whisper')
    expect(s.speech.model).toBe('tiny')
    // Top-level fields the old file set must survive too (shallow-merge path unaffected).
    expect(s.fontSize).toBe(15)
  })

  it('turns pty shadow clients ON for an existing settings.json that predates the flag', () => {
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ tmuxEnabled: true }), 'utf-8')
    const store = new SettingsStore()
    store.init()
    // Every install that upgrades into this release has a settings.json without the key. If the
    // shallow merge did not carry the default through, the feature would be off for exactly the
    // population it needs its soak release from.
    expect(store.get().ptyShadowClients).toBe(true)
  })

  it('keeps an explicit ptyShadowClients:false — the kill switch survives a load', () => {
    writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ ptyShadowClients: false }),
      'utf-8'
    )
    const store = new SettingsStore()
    store.init()
    expect(store.get().ptyShadowClients).toBe(false)
  })

  it('turns markdown auto-preview ON for a settings.json that predates the key', () => {
    // Every pre-v0.3.3 install upgrades with no `openMarkdownPreview` in its file: the shallow
    // merge plus the one-shot migration deliver the flipped default (#495) to that population.
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ fontSize: 15 }), 'utf-8')
    const store = new SettingsStore()
    store.init()
    expect(store.get().openMarkdownPreview).toBe(true)
    expect(store.get().openMarkdownPreviewMigrated).toBe(true)
  })

  it('migrates a v0.3.3-materialized openMarkdownPreview:false to ON, exactly once', () => {
    // v0.3.3 (the sole release that defaulted off) materialized `false` into every file it
    // saved, indistinguishable from an explicit opt-out — the maintainer call on #495 is that
    // everyone sees ON at least once, so the un-stamped file is force-flipped and stamped.
    writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ openMarkdownPreview: false }),
      'utf-8'
    )
    const store = new SettingsStore()
    store.init()
    expect(store.get().openMarkdownPreview).toBe(true)
    expect(store.get().openMarkdownPreviewMigrated).toBe(true)
  })

  it('keeps a post-migration opt-out — a stamped openMarkdownPreview:false is permanent', () => {
    writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ openMarkdownPreview: false, openMarkdownPreviewMigrated: true }),
      'utf-8'
    )
    const store = new SettingsStore()
    store.init()
    expect(store.get().openMarkdownPreview).toBe(false)
  })

  it('leaves an already-modern speech object alone', () => {
    writeFileSync(
      path.join(dir, 'settings.json'),
      // Deliberately a different combo than DEFAULT_SETTINGS.speech.shortcut, so this test can't
      // pass by accident if the merge ever silently fell back to the default instead of preserving
      // the file's explicit value.
      JSON.stringify({ speech: { engine: 'cloud', model: 'base', language: 'tr', shortcut: 'Cmd+Shift+D' } }),
      'utf-8'
    )
    const store = new SettingsStore()
    store.init()
    expect(store.get().speech).toEqual({
      engine: 'cloud',
      model: 'base',
      language: 'tr',
      shortcut: 'Cmd+Shift+D'
    })
  })

  it('defaults speech entirely when settings.json has no speech object at all', () => {
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ fontSize: 15 }), 'utf-8')
    const store = new SettingsStore()
    store.init()
    expect(store.get().speech).toEqual(DEFAULT_SETTINGS.speech)
  })

  it('fills missing model-gateway fields without losing a saved endpoint', () => {
    writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ modelGateway: { baseUrl: 'https://bifrost.example.test' } }),
      'utf-8'
    )
    const store = new SettingsStore()
    store.init()
    expect(store.get().modelGateway).toEqual({
      baseUrl: 'https://bifrost.example.test',
      apiKey: ''
    })
  })

  it("defaults everything when settings.json does not exist", () => {
    const store = new SettingsStore()
    store.init()
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
  })

  describe('legacy terminalGpuRendering boolean migration', () => {
    const load = (value: unknown): SettingsStore => {
      writeFileSync(
        path.join(dir, 'settings.json'),
        JSON.stringify({ terminalGpuRendering: value }),
        'utf-8'
      )
      const store = new SettingsStore()
      store.init()
      return store
    }

    it("migrates an explicit legacy false (escape-hatch choice) to 'off'", () => {
      expect(load(false).get().terminalGpuRendering).toBe('off')
    })

    it("migrates a legacy true (indistinguishable from the old merged default) to 'auto'", () => {
      expect(load(true).get().terminalGpuRendering).toBe('auto')
    })

    it('keeps modern string values as-is', () => {
      expect(load('on').get().terminalGpuRendering).toBe('on')
      expect(load('off').get().terminalGpuRendering).toBe('off')
      expect(load('auto').get().terminalGpuRendering).toBe('auto')
    })

    it("round-trips the experimental 'shared' mode", () => {
      // The shared-canvas renderer is a real stored choice, not garbage: normalizing it away would
      // silently put the user back on the per-terminal renderer at every launch.
      expect(load('shared').get().terminalGpuRendering).toBe('shared')
    })

    it("normalizes garbage to 'auto'", () => {
      expect(load('warp-speed').get().terminalGpuRendering).toBe('auto')
      expect(load(42).get().terminalGpuRendering).toBe('auto')
      expect(load(null).get().terminalGpuRendering).toBe('auto')
      expect(load({ mode: 'shared' }).get().terminalGpuRendering).toBe('auto')
    })
  })

  describe('dictation chord seed (one-shot migration)', () => {
    // Same disk fixture as the sibling describes: write a settings.json, load it through the real
    // store, read the merged result back.
    const loadWith = (saved: Record<string, unknown>): Settings => {
      writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(saved), 'utf-8')
      const store = new SettingsStore()
      store.init()
      return store.get()
    }

    it('a customized legacy speech.shortcut becomes the speech.dictation override', () => {
      // The whole point of the migration: a user who had rebound dictation before the keybinding
      // registry existed keeps their chord, because every consumer now reads the override.
      const s = loadWith({
        speech: { engine: 'whisper', model: '', language: 'auto', shortcut: 'Cmd+Shift+D' }
      })
      expect(s.keybindings?.['speech.dictation']).toEqual(['Cmd+Shift+D'])
      // The legacy field lives on as the downgrade mirror — the seed must not consume it.
      expect(s.speech.shortcut).toBe('Cmd+Shift+D')
    })

    it('a default shortcut seeds nothing', () => {
      // Seeding the default would write an override that says exactly what the registry already
      // says, and would then pin that chord forever against any future default change.
      const s = loadWith({})
      expect(s.keybindings?.['speech.dictation']).toBeUndefined()
    })

    it('an existing speech.dictation key wins over the legacy field — including disabled', () => {
      // `[]` is a deliberate "dictation has no chord". Re-seeding it from the legacy field would
      // hand the user back the shortcut they explicitly turned off, on every single load.
      const s = loadWith({
        speech: { engine: 'whisper', model: '', language: 'auto', shortcut: 'Cmd+Shift+D' },
        keybindings: { 'speech.dictation': [] }
      })
      expect(s.keybindings?.['speech.dictation']).toEqual([])
    })

    it('seeding does not disturb other overrides', () => {
      const s = loadWith({
        speech: { engine: 'whisper', model: '', language: 'auto', shortcut: 'Cmd+Alt+D' },
        keybindings: { 'canvas.undo': [] }
      })
      expect(s.keybindings).toEqual({ 'canvas.undo': [], 'speech.dictation': ['Cmd+Alt+D'] })
    })

    it('is idempotent — a seeded file re-loaded seeds nothing new', () => {
      // Load 1 seeds; load 2 sees the key and leaves it alone. Without the key check the seed
      // would keep overwriting a chord the user changed AFTER the migration, every launch.
      const once = loadWith({
        speech: { engine: 'whisper', model: '', language: 'auto', shortcut: 'Cmd+Shift+D' }
      })
      const twice = loadWith({ ...once, keybindings: { 'speech.dictation': ['Cmd+Alt+K'] } })
      expect(twice.keybindings?.['speech.dictation']).toEqual(['Cmd+Alt+K'])
    })

    it('a legacy chord colliding with another command now survives load end-to-end', () => {
      // The PR3-era hole, measured then: Cmd+K was seeded and then stripped by the sanitizer.
      const s = loadWith({ speech: { engine: 'whisper', model: '', language: 'auto', shortcut: 'Cmd+K' } })
      expect(s.keybindings?.['speech.dictation']).toEqual(['Cmd+K'])
      // The read path is the renderer's sanitizer; assert its verdict here too so the
      // end-to-end claim is one test, not an inference across two files.
      expect(sanitizeKeybindingOverrides(s.keybindings, true).overrides['speech.dictation'])
        .toEqual(['Cmd+K'])
    })
  })
})

describe('settings:save atomic write', () => {
  let dir: string
  let fake: ReturnType<typeof fakePlatform>

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'nodeterm-settings-race-'))
    fake = fakePlatform({ userDataDir: dir })
    initPlatform(fake)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetPlatformForTests()
    rmSync(dir, { recursive: true, force: true })
  })

  const tmpsLeft = async (): Promise<string[]> =>
    (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))

  // Nothing serializes the settings:save handler, and it has overlapping callers in both builds:
  // on the desktop the renderer's coalesced timer save, the `beforeunload` flush that fires
  // outside that window, and any still-in-flight earlier save are all fire-and-forget
  // (src/renderer/state/settings.ts); on the Server Edition every WS frame is dispatched
  // concurrently (src/server/ws.ts). One fixed `${file}.tmp` name means two of them share a single
  // tmp file: one writer's rename publishes the other's half-written bytes, or moves the file out
  // from under it entirely and the loser's rename fails.
  it('overlapping saves never reuse a tmp name (no torn write, no leftovers)', async () => {
    const settingsPath = path.join(dir, 'settings.json')
    // save() calls are serialized by the store's saveChain, so their writes arrive one after the
    // other — uniqueness is carried by the `<pid>.<seq>` name alone. That name is what protects
    // writers that bypass the chain (a second `nodeterm-server --data-dir X` process on the same
    // dir) and the crash window between tmp-write and rename, so it stays pinned here.
    const tmps: string[] = []
    const realWriteFile = fs.writeFile
    vi.spyOn(fs, 'writeFile').mockImplementation((async (p: any, ...rest: any[]) => {
      if (String(p).startsWith(settingsPath)) tmps.push(String(p))
      return (realWriteFile as any)(p, ...rest)
    }) as any)

    new SettingsStore().registerIpc()
    // Payloads that differ in LENGTH, not just one byte: a spliced result then keeps a tail of the
    // longer write and fails JSON.parse, instead of quietly parsing as the shorter one.
    const save = (fontSize: number): Promise<void> =>
      fake.handlers[IPC.settingsSave]({ ...DEFAULT_SETTINGS, fontSize }) as Promise<void>
    await Promise.all([save(9), save(100)])
    vi.restoreAllMocks()

    expect(new Set(tmps).size).toBe(2) // each write owned its own tmp file
    const final = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    expect(final.fontSize).toBe(100) // one COMPLETE snapshot won — and FIFO makes it the last call
    // …and nothing is left for the next writer to inherit.
    expect(await tmpsLeft()).toEqual([])
  })

  it('overlapping saves land in call order — the disk and the cache agree afterwards', async () => {
    const settingsPath = path.join(dir, 'settings.json')
    // Slow down only the FIRST settings write: unserialized, the second save completes and renames
    // first, and the delayed first rename lands LAST — the disk says 9 while the cache (and every
    // listener) says 100, and they disagree until the next boot re-reads the file. Serialized,
    // the second save waits its turn and the last CALL wins both.
    const realWriteFile = fs.writeFile
    let delayed = false
    vi.spyOn(fs, 'writeFile').mockImplementation((async (p: any, ...rest: any[]) => {
      if (String(p).startsWith(settingsPath) && !delayed) {
        delayed = true
        await new Promise((r) => setTimeout(r, 50))
      }
      return (realWriteFile as any)(p, ...rest)
    }) as any)

    const store = new SettingsStore()
    store.registerIpc()
    const save = (fontSize: number): Promise<void> =>
      fake.handlers[IPC.settingsSave]({ ...DEFAULT_SETTINGS, fontSize }) as Promise<void>
    await Promise.all([save(9), save(100)])
    vi.restoreAllMocks()

    const final = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    expect(final.fontSize).toBe(100) // the LAST save wins the disk…
    expect(store.get().fontSize).toBe(100) // …and memory agrees with it
  })

  it('a failed rename removes its own temp, rejects the save, and fires no listener', async () => {
    const store = new SettingsStore()
    const fired: number[] = []
    store.onChange((s) => fired.push(s.fontSize))
    store.registerIpc()
    // EXDEV is the realistic one: /tmp on another filesystem than the target.
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('EXDEV: cross-device link not permitted, rename'), { code: 'EXDEV' })
    )

    await expect(
      fake.handlers[IPC.settingsSave]({ ...DEFAULT_SETTINGS, fontSize: 21 })
    ).rejects.toThrow(/EXDEV/)
    // A unique tmp name is never reused, so the failed write has to have cleaned up after itself.
    expect(await tmpsLeft()).toEqual([])
    // …and the save's observers must not be told about a save that never landed.
    expect(fired).toEqual([])
  })

  it('writes settings.json owner-only, like every other store this app persists', async () => {
    // The temp is created with an explicit restrictive mode BEFORE any bytes land, and the rename
    // carries that mode onto settings.json. Without it the file lands at the umask default (0644):
    // group/world-readable, and created under a predictable `<file>.<pid>.<seq>.tmp` name that a
    // same-uid process could pre-create as a symlink for the write to follow. Every other writer
    // in this store family already passes 0o600; this one was the outlier.
    const store = new SettingsStore()
    store.registerIpc()

    await fake.handlers[IPC.settingsSave]({ ...DEFAULT_SETTINGS, fontSize: 19 })

    const mode = (await fs.stat(path.join(dir, 'settings.json'))).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

// The renderer's `settings:save` is a full snapshot of whatever THAT tab hydrated. With two Server
// Edition tabs the later save replaced the earlier one's rows, so an account tab A added (whose
// credential home tab A's `add` had already minted) vanished when tab B saved a label edit from
// the older snapshot — an authenticated `auth.json` nothing could list, switch to, or remove.
// Membership of `codexAccounts` is therefore the shell's: `mutate` is the only writer that adds or
// removes a row, and a snapshot save can only edit rows the cache already has.
//
// MUTATIONS:
//  - make `saveNow` take `settings.codexAccounts` verbatim ⇒ the "stale snapshot cannot drop" and
//    "cannot resurrect" cases redden.
//  - union by id instead of cache-membership ⇒ the resurrection case reddens.
//  - drop the monotonic-resolution guard ⇒ the "cannot un-resolve" case reddens.
describe('SettingsStore — shell-owned codexAccounts membership', () => {
  let dir: string
  let fake: ReturnType<typeof fakePlatform>

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'nodeterm-settings-rows-'))
    fake = fakePlatform({ userDataDir: dir })
    initPlatform(fake)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetPlatformForTests()
    rmSync(dir, { recursive: true, force: true })
  })

  const row = (id: string, extra: Partial<Settings['codexAccounts'][number]> = {}) => ({
    id,
    label: `acct ${id}`,
    pending: true,
    ...extra
  })
  const addRow = (store: SettingsStore, id: string) =>
    store.mutate((s) => ({ ...s, codexAccounts: [...s.codexAccounts, row(id)] }))
  const ids = (store: SettingsStore): string[] => store.get().codexAccounts.map((a) => a.id)
  const onDisk = async (): Promise<string[]> =>
    (JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf-8')) as Settings)
      .codexAccounts.map((a) => a.id)

  it('two concurrent mutate adds both survive — each sees the other\'s row', async () => {
    const store = new SettingsStore()
    store.init()
    await Promise.all([addRow(store, 'a'), addRow(store, 'b')])
    expect(ids(store).sort()).toEqual(['a', 'b'])
    expect((await onDisk()).sort()).toEqual(['a', 'b'])
  })

  it('a stale renderer snapshot cannot drop a row the shell added after the snapshot was taken', async () => {
    const store = new SettingsStore()
    store.init()
    store.registerIpc()
    await addRow(store, 'a')
    const stale = store.get() // tab B hydrated here: knows a, not b
    await addRow(store, 'b')
    // Tab B edits a's label and full-saves its snapshot (no b in it).
    await fake.handlers[IPC.settingsSave]({
      ...stale,
      codexAccounts: stale.codexAccounts.map((x) => (x.id === 'a' ? { ...x, label: 'renamed' } : x))
    })
    expect(ids(store)).toEqual(['a', 'b'])
    expect(store.get().codexAccounts[0].label).toBe('renamed') // the edit landed…
    expect(await onDisk()).toEqual(['a', 'b']) // …and the concurrent add survived it
  })

  it('a stale renderer snapshot cannot resurrect a row the shell removed, nor add one of its own', async () => {
    const store = new SettingsStore()
    store.init()
    store.registerIpc()
    await addRow(store, 'a')
    await addRow(store, 'gone')
    const stale = store.get()
    await store.mutate((s) => ({ ...s, codexAccounts: s.codexAccounts.filter((x) => x.id !== 'gone') }))
    await fake.handlers[IPC.settingsSave]({
      ...stale,
      codexAccounts: [...stale.codexAccounts, row('renderer-minted')]
    })
    expect(ids(store)).toEqual(['a'])
    expect(await onDisk()).toEqual(['a'])
  })

  it('a snapshot that still says pending cannot un-resolve a row the shell already resolved', async () => {
    const store = new SettingsStore()
    store.init()
    store.registerIpc()
    // Minted with the placeholder label, as `codex-accounts:add` mints it.
    const minted = row('a', { label: 'New Codex account' })
    await store.mutate((s) => ({ ...s, codexAccounts: [...s.codexAccounts, minted] }))
    const stale = store.get()
    // Another tab's reconcile captured the login.
    await fake.handlers[IPC.settingsSave]({
      ...store.get(),
      codexAccounts: [{ ...minted, pending: false, email: 'me@example.com', label: 'me@example.com' }]
    })
    // The stale tab now saves — its row predates the capture: still pending, still the
    // placeholder. Neither is an edit; resolution and the captured label both stand. (A label the
    // stale tab actually typed IS taken — see the field-level describe below.)
    await fake.handlers[IPC.settingsSave](stale)
    expect(store.get().codexAccounts).toEqual([
      { ...minted, pending: false, email: 'me@example.com', label: 'me@example.com' }
    ])
  })

  it('a snapshot still edits label and color of a row both sides know', async () => {
    const store = new SettingsStore()
    store.init()
    store.registerIpc()
    await addRow(store, 'a')
    await fake.handlers[IPC.settingsSave]({
      ...store.get(),
      codexAccounts: [{ ...row('a'), label: 'work', color: '#123456' }]
    })
    expect(store.get().codexAccounts).toEqual([{ ...row('a'), label: 'work', color: '#123456' }])
  })

  it('every other key of the snapshot is still taken as sent', async () => {
    const store = new SettingsStore()
    store.init()
    store.registerIpc()
    await fake.handlers[IPC.settingsSave]({ ...store.get(), fontSize: 23 })
    expect(store.get().fontSize).toBe(23)
  })

  it('a mutate whose write fails changes neither the cache nor the disk, and the chain survives', async () => {
    const store = new SettingsStore()
    store.init()
    await addRow(store, 'a')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('EXDEV: cross-device link not permitted, rename'), { code: 'EXDEV' })
    )
    await expect(addRow(store, 'b')).rejects.toThrow(/EXDEV/)
    expect(ids(store)).toEqual(['a'])
    expect(await onDisk()).toEqual(['a'])
    vi.restoreAllMocks()
    await addRow(store, 'c')
    expect(ids(store)).toEqual(['a', 'c'])
  })

  it('a mutate whose fn throws rejects that caller only', async () => {
    const store = new SettingsStore()
    store.init()
    await expect(
      store.mutate(() => {
        throw new Error('nope')
      })
    ).rejects.toThrow(/nope/)
    await addRow(store, 'a')
    expect(ids(store)).toEqual(['a'])
  })

  it('mutate composes with the FIFO save chain — a queued snapshot save sees the mutated cache', async () => {
    const store = new SettingsStore()
    store.init()
    store.registerIpc()
    const stale = store.get()
    // Queue order: mutate (adds a), then a stale snapshot save that never heard of a.
    const m = addRow(store, 'a')
    const s = fake.handlers[IPC.settingsSave]({ ...stale, fontSize: 31 }) as Promise<void>
    await Promise.all([m, s])
    expect(ids(store)).toEqual(['a'])
    expect(store.get().fontSize).toBe(31)
    expect(await onDisk()).toEqual(['a'])
  })

  it('DEFAULT_SETTINGS carries an empty list, so the reconcile has a cache to keep from on a fresh install', () => {
    expect(DEFAULT_SETTINGS.codexAccounts).toEqual([])
  })
})

// Field-level reconcile: a snapshot row edits only what the renderer owns. `host` is the one that
// bites — `settings:save` is reachable by a paired relay peer (not in HOST_ONLY_CHANNELS), and the
// remove verbs read `host` to decide whether the credential home is local (deleted) or on an SSH
// host (left alone). A row that took the snapshot wholesale let a peer turn a local account into
// one whose home is never deleted while the UI reports the removal complete.
//
// MUTATIONS:
//  - take the snapshot row wholesale again ⇒ the host cases redden.
//  - drop the placeholder exception ⇒ the "placeholder from a stale tab" case reddens.
//  - reconcile only codexAccounts in saveNow ⇒ every claudeAccounts case reddens.
describe('SettingsStore — shell-owned fields survive a snapshot (host, createdAt); display fields do not', () => {
  let dir: string
  let fake: ReturnType<typeof fakePlatform>

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'nodeterm-settings-fields-'))
    fake = fakePlatform({ userDataDir: dir })
    initPlatform(fake)
  })

  afterEach(() => {
    resetPlatformForTests()
    rmSync(dir, { recursive: true, force: true })
  })

  const codexRow = { id: 'c1', label: 'New Codex account', pending: true }
  const claudeRow = { id: 'k1', label: 'New account', pending: true, createdAt: 1234 }
  const boot = async (): Promise<SettingsStore> => {
    const store = new SettingsStore()
    store.init()
    store.registerIpc()
    await store.mutate((s) => ({
      ...s,
      codexAccounts: [...s.codexAccounts, codexRow],
      claudeAccounts: [...s.claudeAccounts, claudeRow]
    }))
    return store
  }
  const save = (store: SettingsStore, patch: Partial<Settings>): Promise<void> =>
    fake.handlers[IPC.settingsSave]({ ...store.get(), ...patch }) as Promise<void>

  it('a snapshot cannot change host on a codex row', async () => {
    const store = await boot()
    await save(store, { codexAccounts: [{ ...codexRow, host: 'me@box' }] })
    expect(store.get().codexAccounts).toEqual([codexRow])
  })

  it('a snapshot cannot change host on a claude row, nor createdAt', async () => {
    const store = await boot()
    await save(store, { claudeAccounts: [{ ...claudeRow, host: 'me@box', createdAt: 9 }] })
    expect(store.get().claudeAccounts).toEqual([claudeRow])
  })

  it('a snapshot cannot strip host off a remote row either', async () => {
    const store = await boot()
    await store.mutate((s) => ({
      ...s,
      claudeAccounts: [{ ...claudeRow, id: 'k2', host: 'me@box' }]
    }))
    const { host: _h, ...withoutHost } = { ...claudeRow, id: 'k2', host: 'me@box' }
    await save(store, { claudeAccounts: [withoutHost] })
    expect(store.get().claudeAccounts[0].host).toBe('me@box')
  })

  it('a label edit from a stale-pending tab is preserved while resolution stays resolved', async () => {
    const store = await boot()
    const stale = store.get() // tab B hydrated: k1 and c1 still pending
    // Tab A's capture resolves both rows.
    await save(store, {
      claudeAccounts: [{ ...claudeRow, pending: false, email: 'me@example.com', label: 'me@example.com' }],
      codexAccounts: [{ ...codexRow, pending: false, email: 'me@example.com', label: 'me@example.com' }]
    })
    // Tab B renames both rows off its stale (still-pending) view.
    await save(store, {
      claudeAccounts: stale.claudeAccounts.map((a) => ({ ...a, label: 'work' })),
      codexAccounts: stale.codexAccounts.map((a) => ({ ...a, label: 'work' }))
    })
    expect(store.get().claudeAccounts).toEqual([
      { ...claudeRow, pending: false, email: 'me@example.com', label: 'work' }
    ])
    expect(store.get().codexAccounts).toEqual([
      { ...codexRow, pending: false, email: 'me@example.com', label: 'work' }
    ])
  })

  it('a stale-pending tab that still carries the placeholder label does not re-label a resolved row', async () => {
    const store = await boot()
    const stale = store.get()
    await save(store, {
      claudeAccounts: [{ ...claudeRow, pending: false, email: 'me@example.com', label: 'me@example.com' }]
    })
    await save(store, { claudeAccounts: stale.claudeAccounts, fontSize: 19 })
    expect(store.get().claudeAccounts[0]).toMatchObject({
      pending: false,
      email: 'me@example.com',
      label: 'me@example.com'
    })
    expect(store.get().fontSize).toBe(19)
  })

  it('a snapshot still resolves a pending row (the capture is the renderer\'s) and clears a color', async () => {
    const store = await boot()
    await save(store, {
      claudeAccounts: [{ ...claudeRow, pending: false, email: 'a@b.c', label: 'a@b.c', color: '#111111' }]
    })
    expect(store.get().claudeAccounts[0]).toEqual({
      ...claudeRow, pending: false, email: 'a@b.c', label: 'a@b.c', color: '#111111'
    })
    // A present-but-undefined color is the swatch's "clear" and lands; JSON drops the key.
    await save(store, {
      claudeAccounts: [{ ...store.get().claudeAccounts[0], color: undefined }]
    })
    expect(store.get().claudeAccounts[0].color).toBeUndefined()
    const disk = JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf-8')) as Settings
    expect('color' in disk.claudeAccounts[0]).toBe(false)
  })

  // MINOR: "unedited" must not be inferred from the label STRING. A user who deliberately names an
  // account exactly the mint placeholder flags the row `labelEdited`, and that edit is taken like
  // any other rather than being discarded as an un-touched placeholder (which is what re-labels a
  // resolved account back to the placeholder for as long as a stale tab lives).
  it('a placeholder-string label the user actually typed (labelEdited) survives a concurrent resolution', async () => {
    const store = await boot()
    const stale = store.get() // k1/c1 still pending, placeholder labels
    // Tab A captures the login and resolves both rows with the email.
    await save(store, {
      claudeAccounts: [{ ...claudeRow, pending: false, email: 'me@example.com', label: 'me@example.com' }],
      codexAccounts: [{ ...codexRow, pending: false, email: 'me@example.com', label: 'me@example.com' }]
    })
    // Tab B (stale-pending) deliberately renamed each account TO the placeholder string — a real
    // edit, so it carries `labelEdited`.
    await save(store, {
      claudeAccounts: stale.claudeAccounts.map((a) => ({ ...a, label: 'New account', labelEdited: true })),
      codexAccounts: stale.codexAccounts.map((a) => ({ ...a, label: 'New Codex account', labelEdited: true }))
    })
    expect(store.get().claudeAccounts[0].label).toBe('New account')
    expect(store.get().codexAccounts[0].label).toBe('New Codex account')
    // The hint itself is transient — never written to disk.
    const disk = JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf-8')) as Settings
    expect('labelEdited' in disk.claudeAccounts[0]).toBe(false)
    expect('labelEdited' in disk.codexAccounts[0]).toBe(false)
  })

  it('claudeAccounts membership is the shell\'s too: a stale snapshot neither drops an add nor resurrects a remove', async () => {
    const store = await boot()
    const stale = store.get()
    await store.mutate((s) => ({
      ...s,
      claudeAccounts: [...s.claudeAccounts.filter((a) => a.id !== 'k1'), { ...claudeRow, id: 'k2' }]
    }))
    await save(store, { claudeAccounts: [...stale.claudeAccounts, { ...claudeRow, id: 'renderer-minted' }] })
    expect(store.get().claudeAccounts.map((a) => a.id)).toEqual(['k2'])
  })
})

// Two PROCESSES on one settings.json (two Server Edition instances on one --data-dir, or a desktop
// sharing it — docs/atomic-writes.md). Each has its own cache and its own FIFO chain, so the chain
// alone serializes nothing between them: a mutate applied to a cache the other process has since
// overtaken publishes that process's add straight out of existence. Every write re-reads the file
// first and applies itself to what is on disk, and re-applies if the file changed underneath.
//
// MUTATIONS:
//  - apply `fn` to `this.cache` instead of the disk read ⇒ the first two cases redden (P1's row
//    is gone from disk after P2 writes).
//  - drop the stamp re-check in readModifyWrite ⇒ the in-window case reddens (fn runs once and
//    the externally landed row is lost).
describe('SettingsStore — two instances on one file (cross-process read-modify-write)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'nodeterm-settings-multi-'))
    initPlatform(fakePlatform({ userDataDir: dir }))
  })

  afterEach(() => {
    resetPlatformForTests()
    rmSync(dir, { recursive: true, force: true })
  })

  const row = (id: string) => ({ id, label: `acct ${id}`, pending: true })
  const addCodex = (store: SettingsStore, id: string) =>
    store.mutate((s) => ({ ...s, codexAccounts: [...s.codexAccounts, row(id)] }))
  const addClaude = (store: SettingsStore, id: string) =>
    store.mutate((s) => ({ ...s, claudeAccounts: [...s.claudeAccounts, { ...row(id), createdAt: 1 }] }))
  const onDisk = async (key: 'codexAccounts' | 'claudeAccounts'): Promise<string[]> =>
    (JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf-8')) as Settings)[key].map(
      (a) => a.id
    )
  const boot = (): SettingsStore => {
    const s = new SettingsStore()
    s.init()
    return s
  }

  it('a mutate in P2 (stale cache) sees the row P1 added — neither add is lost', async () => {
    const p1 = boot()
    const p2 = boot() // both hydrated from the same (empty) file
    await addCodex(p1, 'a')
    await addClaude(p1, 'ka')
    expect(p2.get().codexAccounts).toEqual([]) // P2's cache is stale, by construction
    await addCodex(p2, 'b')
    await addClaude(p2, 'kb')
    expect(await onDisk('codexAccounts')).toEqual(['a', 'b'])
    expect(await onDisk('claudeAccounts')).toEqual(['ka', 'kb'])
    // P2's cache now reflects the file it wrote, so its own later reads are right too.
    expect(p2.get().codexAccounts.map((a) => a.id)).toEqual(['a', 'b'])
  })

  it('a snapshot save from P2 (stale cache) keeps the row P1 added, and still carries P2\'s edit', async () => {
    const p1 = boot()
    const p2 = boot()
    await addCodex(p1, 'a')
    await p2.save({ ...p2.get(), fontSize: 27 })
    expect(await onDisk('codexAccounts')).toEqual(['a'])
    expect(p2.get().fontSize).toBe(27)
    expect(p1.get().codexAccounts.map((a) => a.id)).toEqual(['a'])
  })

  it('a write that lands between the read and the write is detected: fn re-runs against it', async () => {
    const p1 = boot()
    const p2 = boot()
    await addCodex(p1, 'a')
    let runs = 0
    await p2.mutate((s) => {
      runs++
      if (runs === 1) {
        // "Another process" lands a write while this mutate is between its read and its write.
        // Synchronous and out of band on purpose: it is not on p2's chain.
        writeFileSync(
          path.join(dir, 'settings.json'),
          JSON.stringify({ ...s, codexAccounts: [...s.codexAccounts, row('landed-meanwhile')] })
        )
      }
      return { ...s, codexAccounts: [...s.codexAccounts, row('b')] }
    })
    expect(runs).toBe(2)
    expect(await onDisk('codexAccounts')).toEqual(['a', 'landed-meanwhile', 'b'])
  })

  it('a missing file is not a reason to wipe the cache: the mutate applies to what this process knows', async () => {
    const p1 = boot()
    await addCodex(p1, 'a')
    rmSync(path.join(dir, 'settings.json'))
    await addCodex(p1, 'b')
    expect(await onDisk('codexAccounts')).toEqual(['a', 'b'])
  })

  // CRITICAL: the cross-process read-modify-write is now serialized by an O_EXCL lockfile
  // (settings.json.lock) held across read + write. Two instances persisting TRULY concurrently
  // (Promise.all, so their awaits interleave) must both land — a check-then-act alone could let the
  // later rename clobber the earlier one inside the check→rename gap.
  it('two instances persisting truly concurrently lose no row (the lock serializes them)', async () => {
    const p1 = boot()
    const p2 = boot()
    await Promise.all([
      addCodex(p1, 'a'),
      addCodex(p2, 'b'),
      addClaude(p1, 'ka'),
      addClaude(p2, 'kb')
    ])
    expect((await onDisk('codexAccounts')).sort()).toEqual(['a', 'b'])
    expect((await onDisk('claudeAccounts')).sort()).toEqual(['ka', 'kb'])
    // The lockfile is released, not stranded.
    expect(existsSync(path.join(dir, 'settings.json.lock'))).toBe(false)
  })

  // CRITICAL: a base that keeps changing under a non-cooperating writer must, past the bounded
  // retries, ABANDON the write with a throw — never persist its stale result over the base it never
  // saw. A failed save stays failed (the rollback contract in codex-accounts:add depends on it).
  it('a base that keeps changing exhausts the retries and THROWS rather than clobbering', async () => {
    const store = boot()
    await addCodex(store, 'seed')
    const settingsPath = path.join(dir, 'settings.json')
    let n = 0
    await expect(
      store.mutate((s) => {
        n++
        // A non-cooperating external writer lands a different file every time fn runs, so the stamp
        // never stabilizes and the bounded re-read never converges.
        writeFileSync(
          settingsPath,
          JSON.stringify({ ...s, codexAccounts: [...s.codexAccounts, row(`ext${n}`)] })
        )
        return { ...s, codexAccounts: [...s.codexAccounts, row('mine')] }
      })
    ).rejects.toThrow(SettingsWriteConflictError)
    const disk = await onDisk('codexAccounts')
    expect(disk).not.toContain('mine') // the stale write never landed
    expect(disk).toContain(`ext${n}`) // the last external write stands
  })

  // CRITICAL: a settings.json that EXISTS but does not parse may be a recoverable hand-edit. A
  // mutate/save must THROW rather than publish defaults over it — never wipe a corrupt-but-nonempty
  // file (which is what orphaned every account dir it stopped listing).
  it('a mutate against a corrupt-but-nonempty settings.json throws and leaves the file untouched', async () => {
    const settingsPath = path.join(dir, 'settings.json')
    writeFileSync(settingsPath, '{ "fontSize": 15,, not valid json ', 'utf-8')
    const store = boot() // init swallows the parse error → cache = defaults
    const before = readFileSync(settingsPath, 'utf-8')
    await expect(store.mutate((s) => ({ ...s, fontSize: 42 }))).rejects.toThrow(SettingsCorruptError)
    expect(readFileSync(settingsPath, 'utf-8')).toBe(before) // untouched
  })

  // The counterpart: an EMPTY (0-byte) file carries nothing recoverable, so it is treated as
  // defaults and the write proceeds — the corrupt refusal is for files with bytes we could not parse.
  it('a mutate against an EMPTY settings.json writes (nothing to lose), unlike a corrupt one', async () => {
    writeFileSync(path.join(dir, 'settings.json'), '', 'utf-8')
    const store = boot()
    await addCodex(store, 'a')
    expect(await onDisk('codexAccounts')).toEqual(['a'])
  })

  // CRITICAL: a TRANSIENT read failure (EACCES/EPERM/EIO) on a settings.json that EXISTS is not
  // evidence the file is gone. Only ENOENT counts as "missing"; any other error must THROW rather
  // than publish defaults over a file we merely could not read this instant — same data-loss class
  // as the corrupt-file bug, other trigger. (win32 ignores POSIX perms, so the denial can't be
  // staged there — the code path is platform-neutral and exercised on POSIX.)
  it.skipIf(process.platform === 'win32')(
    'a mutate whose disk READ is denied refuses (SettingsUnreadableError), file untouched',
    async () => {
      const store = boot()
      await addCodex(store, 'keep') // a real, populated settings.json on disk
      const settingsPath = path.join(dir, 'settings.json')
      const before = readFileSync(settingsPath, 'utf-8')
      // The file stat's fine (it is still there) but the READ is denied — the very case the old
      // code mis-read as "missing" and would have overwritten with defaults.
      chmodSync(settingsPath, 0o000)
      try {
        await expect(store.mutate((s) => ({ ...s, fontSize: 99 }))).rejects.toBeInstanceOf(
          SettingsUnreadableError
        )
      } finally {
        chmodSync(settingsPath, 0o600)
      }
      expect(readFileSync(settingsPath, 'utf-8')).toBe(before) // untouched
    }
  )
})
