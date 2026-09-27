import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installPiCanvasSkillsInto, piSkillPathIn, removePiCanvasSkillsFrom } from './pi-skills'
import { buildCanvasSkillBody } from '../../canvas-control-core'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-pi-skills-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('installPiCanvasSkillsInto', () => {
  it('writes the SAME body the Claude skill uses, at the pi-native path (no envelope fork)', () => {
    const body = buildCanvasSkillBody('/tmp/nodeterm.sh')
    installPiCanvasSkillsInto(tmp, body)
    const p = piSkillPathIn(tmp, 'manage-nodeterm-canvas')
    expect(p).toBe(path.join(tmp, 'skills', 'manage-nodeterm-canvas', 'SKILL.md'))
    expect(fs.readFileSync(p, 'utf8')).toBe(body)
  })

  it('is idempotent — a second install with a fresh shim path fully replaces the body', () => {
    installPiCanvasSkillsInto(tmp, buildCanvasSkillBody('/tmp/a.sh'))
    installPiCanvasSkillsInto(tmp, buildCanvasSkillBody('/tmp/b.sh'))
    const written = fs.readFileSync(piSkillPathIn(tmp, 'manage-nodeterm-canvas'), 'utf8')
    expect(written).toContain('/tmp/b.sh')
    expect(written).not.toContain('/tmp/a.sh')
  })

  it('remove deletes only the skill dir it owns', () => {
    installPiCanvasSkillsInto(tmp, buildCanvasSkillBody('/tmp/nodeterm.sh'))
    // A sibling file elsewhere under skills/ is untouched.
    fs.mkdirSync(path.join(tmp, 'skills', 'my-own-skill'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'skills', 'my-own-skill', 'SKILL.md'), '---\nname: my-own-skill\n---\n')
    removePiCanvasSkillsFrom(tmp)
    expect(fs.existsSync(piSkillPathIn(tmp, 'manage-nodeterm-canvas'))).toBe(false)
    expect(fs.existsSync(path.join(tmp, 'skills', 'my-own-skill', 'SKILL.md'))).toBe(true)
  })

  it('never throws when the directory cannot be created (fail-open, warns instead)', () => {
    // A path through a FILE (not a directory) can never be mkdir -p'd.
    const blocked = path.join(tmp, 'not-a-dir')
    fs.writeFileSync(blocked, 'x')
    expect(() => installPiCanvasSkillsInto(path.join(blocked, 'agent'), 'body')).not.toThrow()
  })
})
