import { describe, it, expect } from 'vitest'
import {
  DEFAULT_LENSES,
  MAX_LENSES,
  parseLenses,
  verifyLensPrompt,
  verifySynthesisPrompt,
  verifyPanelOrigin,
  VERIFY_PANEL_GUTTER
} from './verifyPanel'

describe('parseLenses', () => {
  it('falls back to the default panel when nothing is given', () => {
    expect(parseLenses(undefined)).toEqual(DEFAULT_LENSES)
    expect(parseLenses('')).toEqual(DEFAULT_LENSES)
    expect(parseLenses('  ,  ,')).toEqual(DEFAULT_LENSES)
  })

  it('normalizes case and whitespace, and drops duplicates', () => {
    expect(parseLenses(' Security , security ,TESTS ')).toEqual(['security', 'tests'])
  })

  it('keeps lens words it does not know — an unanticipated angle is still a valid review', () => {
    expect(parseLenses('accessibility,i18n')).toEqual(['accessibility', 'i18n'])
  })

  it('caps the panel size', () => {
    const many = parseLenses('a,b,c,d,e,f,g,h')
    expect(many).toHaveLength(MAX_LENSES)
  })
})

describe('verifyLensPrompt', () => {
  const base = { targetTitle: 'Migration', targetId: 'term-7', shimPath: '/x/nodeterm.sh' }

  it('names the lens, the target, and a known lens brief', () => {
    const p = verifyLensPrompt({ ...base, lens: 'security', agentId: 'claude' })
    expect(p).toContain('single lens: security')
    expect(p).toContain('"Migration" (term-7)')
    expect(p).toContain('injection')
  })

  it('points claude at the skill and other agents at the CLI shim', () => {
    expect(verifyLensPrompt({ ...base, lens: 'tests', agentId: 'claude' })).toContain(
      'get-linked-context skill'
    )
    const codex = verifyLensPrompt({ ...base, lens: 'tests', agentId: 'codex' })
    expect(codex).toContain('/x/nodeterm.sh')
    expect(codex).not.toContain('get-linked-context skill')
  })

  it('gives an unknown lens a generic brief instead of dropping it', () => {
    expect(verifyLensPrompt({ ...base, lens: 'accessibility' })).toContain(
      'problems of this kind: accessibility'
    )
  })

  it('always forbids editing — a panel shares one checkout', () => {
    for (const lens of ['correctness', 'security', 'whatever']) {
      expect(verifyLensPrompt({ ...base, lens })).toMatch(/Do NOT change any files/)
    }
  })

  it('always licenses an empty finding, so reviewers do not invent one', () => {
    expect(verifyLensPrompt({ ...base, lens: 'correctness' })).toContain('nothing found')
  })

  it('folds in --focus when given, and omits the clause when not', () => {
    expect(verifyLensPrompt({ ...base, lens: 'tests', focus: 'the SSH retry path' })).toContain(
      'specifically about: the SSH retry path'
    )
    expect(verifyLensPrompt({ ...base, lens: 'tests' })).not.toContain('specifically about')
    expect(verifyLensPrompt({ ...base, lens: 'tests', focus: '   ' })).not.toContain(
      'specifically about'
    )
  })
})

describe('verifyPanelOrigin', () => {
  const panel = { w: 500, h: 400 }

  it('places a loose target’s panel immediately right of the node', () => {
    const node = { x: 100, y: 200, w: 600, h: 400 }
    const o = verifyPanelOrigin({ node, panel, obstacles: [] })
    expect(o).toEqual({ x: 100 + 600 + VERIFY_PANEL_GUTTER, y: 200 })
  })

  it('places a framed target’s panel right of the FRAME, not the node', () => {
    const node = { x: 140, y: 260, w: 600, h: 400 }
    const frame = { x: 100, y: 200, w: 700, h: 520 }
    const o = verifyPanelOrigin({ node, frame, panel, obstacles: [] })
    expect(o).toEqual({ x: 100 + 700 + VERIFY_PANEL_GUTTER, y: 200 })
  })

  it('pushes the panel off an occupied spot instead of overlapping', () => {
    const node = { x: 0, y: 0, w: 600, h: 400 }
    const preferred = { x: 600 + VERIFY_PANEL_GUTTER, y: 0 }
    // A node sitting exactly where the panel wants to go.
    const blocker = { ...preferred, w: panel.w, h: panel.h }
    const o = verifyPanelOrigin({ node, panel, obstacles: [blocker] })
    const moved = o.x !== preferred.x || o.y !== preferred.y
    expect(moved).toBe(true)
    // And the result no longer overlaps the blocker.
    const overlaps =
      o.x < blocker.x + blocker.w && o.x + panel.w > blocker.x &&
      o.y < blocker.y + blocker.h && o.y + panel.h > blocker.y
    expect(overlaps).toBe(false)
  })

  it('anchors OUTSIDE the frame — the panel is a sibling beside it, never inside', () => {
    const node = { x: 140, y: 260, w: 600, h: 400 }
    const frame = { x: 100, y: 200, w: 700, h: 520 }
    const o = verifyPanelOrigin({ node, frame, panel, obstacles: [] })
    // Left edge of the panel is right of the frame's right edge → it cannot be nested in it.
    expect(o.x).toBeGreaterThanOrEqual(frame.x + frame.w)
  })
})

describe('verifySynthesisPrompt', () => {
  const base = { targetTitle: 'Migration', shimPath: '/x/nodeterm.sh' }

  it('names every lens on the panel and the count', () => {
    const p = verifySynthesisPrompt({ ...base, lenses: ['correctness', 'security'] })
    expect(p).toContain('2 reviewers')
    expect(p).toContain('correctness, security')
  })

  it('makes an empty verdict an acceptable outcome', () => {
    expect(verifySynthesisPrompt({ ...base, lenses: ['correctness'] })).toContain(
      'an empty verdict is a real result'
    )
  })
})
