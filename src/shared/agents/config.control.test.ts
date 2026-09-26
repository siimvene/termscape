import { describe, it, expect } from 'vitest'
import { CANVAS_CONTROL_CAPABLE, canControlCanvas } from './config'

describe('canControlCanvas', () => {
  it('is true for every declared builtin, not a vanilla custom agent', () => {
    for (const id of CANVAS_CONTROL_CAPABLE) expect(canControlCanvas(id), id).toBe(true)
    expect(canControlCanvas('custom:abc')).toBe(false)
  })

  it('grok may drive the canvas', () => {
    // Discovery needs no new installer: grok scans `~/.claude/skills` by default (its shipped
    // docs, user-guide/08-skills.md — "Claude Code compatibility (configurable)", switched off
    // only by `[compat.claude] skills = false` / GROK_CLAUDE_SKILLS_ENABLED=false), which is where
    // nodeterm already writes manage-nodeterm-canvas — locally and, via
    // RemoteHooks.installCanvasControl, on an SSH host. This list is what sets
    // NODETERM_CANVAS_CONTROL in the session env, i.e. what makes the shim usable at all.
    expect(canControlCanvas('grok')).toBe(true)
  })

  it('pi may drive the canvas, from its OWN skills dir', () => {
    // Unlike grok, pi does NOT scan ~/.claude/skills (MEASURED on 0.84.1, docs/skills.md
    // "Locations": global discovery is `~/.pi/agent/skills/` + `~/.agents/skills/` only) — so it
    // needs its own installer (installPiCanvasSkillsInto, core/agents/hooks/pi-skills.ts), called
    // from the same sites (main/canvas-control.ts, server/canvas-control.ts) that write Claude's
    // copy. Same SKILL.md body either way: the Agent Skills envelope (name/description
    // frontmatter) is identical between pi and Claude, so nothing here forks the text.
    expect(canControlCanvas('pi')).toBe(true)
  })
})
