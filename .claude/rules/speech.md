---
paths:
  - "src/core/speech/**"
  - "src/renderer/components/DictationOverlay.tsx"
  - "src/renderer/lib/pcm-*.ts"
  - "src/shared/speech.ts"
  - "src/renderer/lib/speechLanguage*.ts"
  - "src/renderer/components/settings/SpeechLanguageSelect.tsx"
---
# Speech / dictation (desktop + server)

> Moved verbatim from the root `CLAUDE.md` on 2026-09-01 (see its "How this documentation is
> organized" section). Loads automatically when a file matching the `paths` above is read;
> when the root routing table points here, read this file before touching the subsystem.
<!-- moved-verbatim-from: CLAUDE.md -->

## Speech / dictation (desktop + server)

Voice-to-text input captured via microphone, turned into terminal text via on-device Whisper. Works on desktop (Electron) and Server Edition (browser); iOS support is separate (`nodeterm-ios`, private — see the three-surfaces entry under Conventions in the root `CLAUDE.md`).

- **Service seam** (`src/core/speech/`) — `SpeechService` (core) + `PlatformSpeechProvider` interface + shell implementations (`PlatformElectron` / `PlatformServer`). Models are stored under `${dataDir}/speech-models/`, with fenced downloads + orphan sweep (`removeUnusedModels`). Core validates license: **tiny** free (always); **base·small·large-v3-turbo** Pro (via `isPremium()`). One model loaded at a time (FIFO memory management), lazy smart-whisper import degrades to a friendly error if the native dep is unavailable (`"Local whisper is unavailable…"`).
- **Cloud contract (iOS parity)** — `/v1/transcribe` multipart endpoint (not built yet; SDK `transcribe()` call matches iOS byte-for-byte) for future remote transcription. IPC channels `speech:*` (in `src/shared/ipc.ts`) wired in **both** Electron and Server: `speech:transcribe` (returns `Promise<{text}>`), `speech:models`, `speech:model-download`, `speech:model-delete`, `speech:progress` (main/server → renderer download-progress broadcast), and `speech:mic-consent` (Electron mic-prompt only, server always true). There is no `speech:synthesize` / `speech:cancel` and no audio in the reply.
- **Renderer capture** — `PcmCapture` AudioWorklet (16kHz single-channel PCM, WebAudio or fallback SPN) + DictationOverlay (⌘⇧D dock mic / Cmd key; Settings → Speech section for model choice + progress). **Send** appends text + Enter to the terminal; **Insert** sends text-only via `sendText(…, {enter: false})`. **Nothing auto-submits** (user always decides when to send).
- **Language** — `SPEECH_LANGUAGES` (`src/shared/speech.ts`) is whisper's own `LANGUAGES` table
  (tokenizer.py) verbatim: 100 entries carrying the code, CLDR's English name, the endonym and the
  alternate spellings people type (whisper's own name where it differs, plus its documented alias
  table); Cantonese is flagged `sinceV3`, the one entry the pre-large-v3 models have no token for.
  It replaced a **7-entry array inside `SpeechSection`** which was the ONLY limit in the whole
  stack (issue #586): `SpeechSettings.language` is a free string nothing validates on the way to
  disk and whisper.cpp takes any code, so `"language": "pl"` hand-edited into settings.json
  transcribed Polish correctly while the dropdown rendered **blank** and overwrote it on the next
  click in the row. Three rules come out of that:
  - The control is the app's **searchable menu idiom** (`SpeechLanguageSelect` — `.bind-select`
    trigger + portaled `.tab-menu` with a pinned filter over a scrolling list, the Source Control
    branch quick-pick's shape), never a `<select>`: 101 rows with no search, unreachable by typing
    "polski", is not a picker. Rows are the pure `renderer/lib/speechLanguageRows.ts`.
  - **A code we cannot name is still the user's setting.** `speechLanguageLabel` returns an unknown
    code AS-IS (not `''`) and the picker gives it its own row, so a display gap can never become
    data loss the way the `<select>` made it.
  - **The cloud `locale` is passed through unchanged, `auto` included.** `register-ipc.ts` used to
    send `language === 'auto' ? 'en' : language`, so on the Cloud engine "Auto-detect" was a hard,
    silent English — on the one engine where a missing language could not be worked around at all.
    `/v1/transcribe` does not exist yet, so `auto` = detect is our contract to write.
  Deliberately NOT done here: seeding the initial value from the system locale (issue #586 §3) —
  the default is still `auto`. **Mobile** keeps its own list, tracked separately as issue #591.
- **Browser constraints** — `getUserMedia` requires HTTPS or `localhost`; mic permission prompt is the browser's own (not handled by nodeterm). Model downloads land on the **server's data dir** (accessible across sessions).
- **Electron + native dep** — smart-whisper is externalized + `asarUnpack`'d (not bundled); `postinstall` rebuilds it against Electron's ABI. Device verification of the ABI rebuild is not yet exercised on a dev machine — test paths exist but have not been run in CI.
