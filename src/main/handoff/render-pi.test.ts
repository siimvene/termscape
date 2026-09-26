import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { renderPiTranscript } from './render-pi'

// The fixture is a REAL pi session (see core/__fixtures__/pi/session.jsonl's provenance note in
// core/pi-session.test.ts): a user turn, one `bash` tool call and its result, and a final
// assistant text — pinned verbatim.
const RAW = fs.readFileSync(path.join(__dirname, '../../core/__fixtures__/pi/session.jsonl'), 'utf8')

describe('renderPiTranscript', () => {
  it('renders each turn under its own heading', () => {
    const md = renderPiTranscript(RAW)
    expect(md).toContain('## User')
    expect(md).toContain('## Assistant')
  })

  it('keeps tool calls and results attached to the message above, not as speakers of their own', () => {
    const md = renderPiTranscript(RAW)
    expect(md).toContain('$ bash ls')
    expect(md).toContain('= sessions')
    expect(md).not.toContain('## $')
  })

  it('never renders the session/session_info/model_change/thinking_level_change bookkeeping lines', () => {
    const md = renderPiTranscript(RAW)
    expect(md).not.toContain('Fixture title')
    expect(md).not.toContain('thinkingLevel')
  })

  it('returns an empty document rather than throwing on junk', () => {
    expect(renderPiTranscript('')).toBe('')
    expect(renderPiTranscript('{not json\n\n')).toBe('')
  })
})
