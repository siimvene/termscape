---
paths:
  - "src/shared/keybindings.ts"
  - "src/main/keydown-intercept.ts"
  - "src/main/index.ts"
  - "src/renderer/lib/keybindingOverrides.ts"
  - "src/renderer/lib/terminalFocusMirror.ts"
  - "src/renderer/state/terminalFocus.ts"
  - "src/renderer/components/ShortcutsPanel*.tsx"
  - "src/renderer/components/ShortcutCaptureBanner.tsx"
  - "src/renderer/components/settings/**"
  - "src/main/window-chrome.ts"
  - "src/renderer/lib/windowChrome.ts"
---
# Keybindings (registry, overrides, dispatch) and window chrome / menu stand-down

> Moved verbatim from the root `CLAUDE.md` on 2026-09-01 (see its "How this documentation is
> organized" section). Loads automatically when a file matching the `paths` above is read;
> when the root routing table points here, read this file before touching the subsystem.
<!-- moved-verbatim-from: CLAUDE.md -->

## Keybindings (registry, overrides, dispatch)

Every user-facing chord is a registry command, and the whole engine is **one module**:
`src/shared/keybindings.ts` holds the command registry, per-command validation
(`normalizeBindingForCommand`), effective-binding resolution, conflict detection, override
sanitization and the pure event→command resolver. **Do not split it** — main, the renderer and the
Server Edition bridge all import it, and a second copy of any of those five is how the dispatcher,
the Settings section and ShortcutsPanel start disagreeing about what a chord means.

- **Overrides live in `settings.keybindings`** (hand-editable JSON): an absent id = the registry
  default, `[]` = **disabled**, a list = exactly those chords. It is **sanitized at READ**
  (`sanitizeKeybindingOverrides` → `renderer/lib/keybindingOverrides.ts`, memoized on the raw
  object's identity), which is what makes a hand-edited file safe; the Settings section refuses a
  bad candidate BEFORE saving (`commitCandidate`) so the user learns which chord was refused
  instead of watching it vanish on the next launch. The write path is raw and the gates read the
  sanitized map, so a dropped hand-edit is invisible in the UI but still on disk until a UI write
  or Reset replaces the map.
- **Dispatch has exactly two owners.** The renderer's is ONE window `keydown` listener in
  `Canvas.tsx`, on the **bubble** phase — the Settings recorder's `stopPropagation` on an armed
  capture depends on that, and moving it to capture would let a recorded chord fire the command it
  is being bound to. The main process's is `src/main/keydown-intercept.ts`, a **closed allowlist**
  of chords it must steal back from the application menu before the page ever sees them.
- **Invariants**
  - **Never read `settings.speech.shortcut`.** The dictation chord is `dictationBinding()` (the
    first effective `speech.dictation` binding); the legacy field is a **downgrade mirror only**,
    written by `setKeybindingOverride` so an older build still finds the user's chord.
  - **`isHoldChord('')` is TRUE** (an all-false parse has a null key), and `''` is what a DISABLED
    dictation binding reads as — so every caller owes an explicit `=== ''` check first. Without it
    a disabled binding arms a modifier-less hold chord that fires on any keydown.
  - **`MAIN_INTERCEPTED_COMMAND_IDS` must mirror the registry-backed commands `keydown-intercept.ts`
    actually resolves** (`keydown-intercept.test.ts` pins it). The Settings UI's app-wide shadow
    warning reads that list and cannot derive it — main is not importable from the renderer. Note
    what the pin cannot cover: a HARDCODED intercept (the `Digit0` branch) has no command id, so it
    swallows its chord app-wide with the recorder reporting no conflict.
  - **Dictation has its own conflict bucket** (`conflictBucket` — `speech.dictation` is never in
    `global`), because it never competes at dispatch: the resolver skips it and its own keyed
    listener claims the chord FIRST **in plain app focus only**, which is precedence, not ambiguity.
    Overlap policy is deliberately asymmetric — the LOAD path PERMITS a shared chord (legacy
    settings.json files contain them and `sanitizeKeybindingOverrides` would otherwise strip the
    user's own binding with the migrated one), while the Settings UI REFUSES to create one
    (`commitCandidate`'s two dictation gates, both keyed-only — a modifier-only hold chord renders
    as `…:(hold)` and can never match a keyed identity).
  - **The terminal-first stand-down is `policyStandsDown(policy, terminalFocused)`, and both halves
    are refusals.** `settings.terminalShortcutPolicy` (`app-first` default, Settings → Keyboard
    Shortcuts, read everywhere through `normalizeTerminalShortcutPolicy` because it is
    hand-editable) never stands anything down under `app-first`, whatever the mirror reports — that
    is the byte-identical guarantee for a user who never touched it. Under `terminal-first` with a
    focused terminal, main stops claiming its chords AND disables the command-style menu items in
    `menuItemIdsToSuspend` — Minimize, Toggle Kanban Board (⌘⇧B) and Settings (⌘,) everywhere, plus
    Close off-mac, with **Reload deliberately excluded** (see **Window chrome**): not calling
    `preventDefault` alone would hand ⌘M straight to `{role:'minimize'}`, which is strictly worse
    than having no policy. **The MENU's state is the composed
    `menuStandsDown(shortcutRecording, policy, terminalFocused)`** — an armed shortcut recorder
    suspends the same items, so ⌘M / ⌘⇧B / ⌘, / off-mac Ctrl+W reach the recorder instead of the
    menu item that owns them; `menuStandsDown(false, …)` is `policyStandsDown(…)` by construction.
    The two INTERCEPT thunks stay independent parameters — only the menu ORs them.
    **The CLOSE leg has one extra, policy-independent stand-down** (issue #383, off-mac only):
    `closeStandsDownInTerminal(isMac, terminalFocused)` — off-mac `node.close`'s default chord is
    Ctrl+W, readline's kill-word, so while a terminal has focus the close intercept lets the chord
    fall through UNTOUCHED and `syncMenuForStandDown` disables the Close menu item on top of the
    shared list. mac's ⌘W is deliberately unaffected (not a shell key), and ⌘/Ctrl+M and ⌘/Ctrl+0
    keep firing — this is one chord whose terminal meaning outranks its app meaning, not a policy
    change. Falling through main is not enough: xterm's custom key handler runs before the Canvas
    dispatcher, whose main-intercepted command cases deliberately have no renderer handlers.
    `terminalChordBubbles` must therefore refuse every `MAIN_INTERCEPTED_COMMAND_IDS` command; if
    it returned true for `node.close`, xterm would withhold `^W` while the unclaimed event bubbled
    to Canvas. One predicate, two main-process consumers are pinned in `keydown-intercept.test.ts`
    (including a source-level wiring pin, since the menu leg lives against a real Menu in index.ts),
    and `keybindingOverrides.test.ts` pins the renderer-to-xterm hand-off through
    `terminalKeyAction`.
  - **ShortcutsPanel is DERIVED from the registry, never a hand-written list.**
    `buildShortcutSections` iterates `COMMAND_DEFINITIONS` — one section per `CommandGroup` in
    registry source order, the label from `def.title`, and EVERY one of the command's EFFECTIVE
    chords — and a command with no effective binding (ships unbound, or the user disabled it) is
    OMITTED rather than shown chord-less. All chords, not just the first: off-mac
    `terminal.copySelection` holds Ctrl+Shift+C AND Ctrl+Insert, and in the **Server Edition**
    Chromium reserves Ctrl+Shift+C for the inspector un-preventably — so a first-chord-only row
    advertised the one that cannot work there. The panel it replaced enumerated 24 ids by hand against a
    45-command registry, so ⌘⇧T (reopen last closed), ⌘⇧↵ (maximize node), the ⌃⌥arrow zone snaps
    and Copy terminal selection were live chords it never mentioned, and no ships-unbound command
    could ever appear even after the user assigned one. `ShortcutsPanel.test.tsx` is the watchdog:
    it binds every registry command and asserts a row per `def.title`, so a new command that fails
    to surface reds it. Same stale-doc rule as the canvas-control skill body (#269) — derive the
    text, don't retype it.
    Rows the registry does NOT own (mouse gestures, the two `zoomShortcut.ts` chords, the ⌘1-9
    project jump, tmux/xterm terminal behaviors) are literal, and still read from settings where
    the behavior does: the hover dwell prints `panHoverDelay` and the drag rows follow
    `canvasDragMode`, because the old fixed text claimed 0.6 s and a right-drag pan React Flow
    (`panOnDrag={[1]}`, middle button only) has never done.
    **One honest exception to "the chord shown is the chord that fires":** `terminal.copySelection`
    is a registry row whose matcher is still the hardcoded `isCopyShortcut`
    (`terminalKeyAction` keeps the copy chords and Shift+Enter "whatever the registry says"). Its
    registry defaults match that matcher on both platforms, so the row is accurate as shipped; a
    REMAP of it would not be, on this panel or in Settings. Wiring `isCopyShortcut` to the registry
    is the fix.
  - **`terminalFocused` is a MIRROR, and its fail-safe direction is `false` = not focused =
    intercepts ON.** `renderer/lib/terminalFocusMirror.ts` reports focus changes to main and is
    change-deduped (it never re-asserts), so a page that died mid-report, a reload, or a window that
    never had one all resolve to intercepts on — never to "off with nothing alive to turn them back
    on". Consequence: clear the bit ONLY where the renderer's DOCUMENT is ending (window `closed`,
    `render-process-gone`, main-frame navigation). Clearing it under a live page that is still
    focused on its terminal strands mirror and main out of sync with no event that can reconcile
    them, and the policy is dead until the user clicks away and back.


## Window chrome (menu, intercepted chords, stand-down) — bullet moved from the Canvas section

- **Window chrome**: macOS integrated title bar (`titleBarStyle: 'hiddenInset'`); the tab
  bar (`TabBar.tsx`) is the drag region with the `nodeterm` logo + a rounded pill of project
  tabs. Cmd+M is intercepted in `main/keydown-intercept.ts` (`before-input-event`, installed from
  `main/index.ts` — else macOS minimizes) and forwarded to the renderer via `app:toggle-markdown`;
  Cmd+W (`app:close-node`) and Cmd+0 (`app:zoom-actual-size`) are taken back the same way. **The
  application menu is OURS**: `buildAppMenu` (`main/index.ts`) calls `Menu.setApplicationMenu` and
  re-runs on every settings change. (This bullet used to claim we never call it — false since that
  function landed; check the template, not Electron's defaults.) **COMMAND-style accelerators are
  handled ABOVE the page on every platform** — Minimize, Close, Toggle Kanban Board, Settings,
  Reload — so a chord one of those owns never reaches the renderer, which is why those three are
  stolen in `before-input-event`. **This is not a blanket claim about the whole menu:** the Edit
  submenu's standard `{role:'cut'|'copy'|'paste'|'selectAll'|…}` items behave differently — Chromium
  routes them into the focused element, so ⌘C in a terminal or a text field does the ordinary thing
  and does not need stealing. Ask which kind an item is before reasoning from this bullet.
  That difference is also why the **stand-down has a menu leg**: while a terminal
  owns the keys under `terminal-first` **or while a shortcut recorder is armed**
  (`menuStandsDown(shortcutRecording, policy, terminalFocused)`), `syncMenuForStandDown` disables
  the command-style items
  named in `menuItemIdsToSuspend` — Minimize (`MENU_ITEM_ID_MINIMIZE`), **Toggle Kanban Board
  (`MENU_ITEM_ID_KANBAN`, ⌘⇧B)** and **Settings (`MENU_ITEM_ID_SETTINGS`, ⌘,)** on every platform,
  plus Close (`MENU_ITEM_ID_CLOSE`) on Windows/Linux — because a disabled item suppresses its
  accelerator and only then do those chords fall through to the terminal, or to the recorder.
  Off-mac the Close item is ALSO disabled whenever a terminal has focus, policy or no policy
  (`closeStandsDownInTerminal`, issue #383): its role owns the Ctrl+W accelerator, and that
  keystroke in a shell is readline's kill-word. The
  recorder leg is why ⌘M is bindable at all, and it fixed a live misfire: ⌘⇧B pressed into an armed
  recorder used to open the kanban board behind the Settings dialog, and ⌘, to re-open Settings.
  Kanban and Settings are
  the ones a reader gets wrong: they are **not** intercepted chords at all but ordinary registry
  commands (`view.kanbanToggle` / `app.settings`), so the renderer's dispatcher could never stand
  them down itself — under app-first the menu takes them before the keydown exists, which is also
  why their capture NOTICE is raised at the IPC receivers in `Canvas.tsx` rather than by the
  dispatcher. **Reload (⌘R / ⌘⇧R) is the named exception and stays live while stood down**: it is
  the crash-recovery lever (a wedged renderer is exactly when it is needed) and a main-frame
  navigation is one of the three sites that reset `terminalFocused` / `shortcutRecording`. **Of the
  items main suspends, Reload is therefore the deliberate exception** — the one it holds back from a
  shortcut recorder — which is what the Keyboard Shortcuts section's description now says.
  **KNOWN GAP, pre-existing and accepted:** the suspend list only ever covered the command-style
  items the terminal-first policy needed, so the always-on app roles — `quit` (⌘Q), `hide` /
  `hideOthers` (⌘H / ⌘⌥H), `toggleDevTools`, `togglefullscreen` — still act while a recorder is
  armed (⌘Q pressed into one QUITS the app). They are deliberately NOT added: ONE list drives both
  stand-downs, and making ⌘Q/⌘H unreachable for a terminal-first user is the worse trade — quit and
  hide must never be policy-gated. Splitting the list per stand-down is the change that would close
  it, and it has not been made.
  `keydown-intercept.test.ts` pins both the stolen chords and the suspended item ids (including
  that the list does not silently grow) — `getMenuItemById` answers `null` for a typo and the
  fail-safe is to do nothing, which is indistinguishable from the feature working.
