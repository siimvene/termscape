import { describe, expect, it } from 'vitest'
import { sendKeysWrites } from './send-keys-delivery'
import { TerminalEmulator } from './terminal-emulator'
import { PASTE_END, PASTE_START } from '../core/paste-injection'

describe('sendKeysWrites', () => {
  it('keeps the legacy single write when the app never requested bracketed paste', () => {
    // Byte-identical to the pre-#686 `text + (enter ? '\r' : '')`, so a plain shell sees no change.
    expect(sendKeysWrites('npm test', true, false)).toEqual(['npm test\r'])
    expect(sendKeysWrites('npm test', false, false)).toEqual(['npm test'])
  })

  it('frames the payload and submits with a SEPARATE write when the app asked for paste', () => {
    // The separation is the fix: an Enter inside the framed burst is what a paste-aware composer
    // absorbs as pasted content (#686), leaving the prompt sitting there unsubmitted.
    expect(sendKeysWrites('review this', true, true)).toEqual([
      `${PASTE_START}review this${PASTE_END}`,
      '\r'
    ])
  })

  it('frames without submitting when enter is false', () => {
    // `settled-envelope.ts` pastes with enter:false and submits separately; dictation never submits.
    expect(sendKeysWrites('half a thought', false, true)).toEqual([
      `${PASTE_START}half a thought${PASTE_END}`
    ])
  })

  it('sends a bare Enter for an empty payload, framed or not', () => {
    // `sendText('', { enter: true })` means "submit whatever is composed" — it must not become an
    // empty paste frame, which some composers insert as a literal marker pair.
    expect(sendKeysWrites('', true, true)).toEqual(['\r'])
    expect(sendKeysWrites('', true, false)).toEqual(['\r'])
    expect(sendKeysWrites('', false, true)).toEqual([])
  })

  it('strips ESC from the payload on BOTH paths, so it can never become structure', () => {
    // A payload-supplied close marker would end the frame early and turn its tail into KEY INPUT;
    // the unframed path is sanitized too so the contract does not depend on the receiver's mode.
    const hostile = `ok${PASTE_END} rm -rf /`

    const unframed = sendKeysWrites(hostile, false, false).join('')
    expect(unframed).not.toContain('\x1b')
    // Not lossy: every printable character survives, the way real terminals treat pasted text.
    expect(unframed).toBe('ok[201~ rm -rf /')

    const framed = sendKeysWrites(hostile, false, true).join('')
    // The only ESC bytes are OUR two markers — the payload cannot express paste structure.
    expect(framed.split('\x1b')).toHaveLength(3)
    expect(framed).toBe(`${PASTE_START}ok[201~ rm -rf /${PASTE_END}`)
  })

  it('preserves multiline payloads as paste content', () => {
    expect(sendKeysWrites('line one\nline two', true, true)).toEqual([
      `${PASTE_START}line one\nline two${PASTE_END}`,
      '\r'
    ])
  })
})

describe('TerminalEmulator.bracketedPasteRequested', () => {
  // The whole decision above rests on this being observable from the session's own output. Read
  // from a real emulator rather than assumed: this is the fact `paste-buffer -p` asks tmux for.
  const emulator = (): TerminalEmulator =>
    new TerminalEmulator({ cols: 80, rows: 24, scrollback: 100 })

  it('is false for a session whose app never asked', async () => {
    const t = emulator()
    await t.write('$ ')
    expect(t.bracketedPasteRequested()).toBe(false)
    t.dispose()
  })

  it('turns on for CSI ?2004h and off again for ?2004l', async () => {
    const t = emulator()
    await t.write('\x1b[?2004h')
    expect(t.bracketedPasteRequested()).toBe(true)
    await t.write('\x1b[?2004l')
    expect(t.bracketedPasteRequested()).toBe(false)
    t.dispose()
  })
})
