import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// The #925 headless start saves its write-ahead claim for an OFF-screen project, but the save
// serializes the WHOLE projects store. A bare `writeDisk` there carried the on-screen project's
// stale store copy and cleared its dirty flag, so the on-screen canvas's unsaved edits never
// reached disk (consort review, 2026-10-09; upstream v0.4.2 wires the bare form). `persist`
// commits the live canvas first.
const SRC = fs.readFileSync(path.join(__dirname, 'Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')

describe('headless claim save', () => {
  it('goes through persist (live canvas committed first), never a bare writeDisk', () => {
    const start = SRC.indexOf('startNodesHeadlessRef.current = async')
    expect(start).toBeGreaterThan(0)
    const envEnd = SRC.indexOf('const deps = {', start)
    expect(envEnd).toBeGreaterThan(start)
    const env = SRC.slice(start, envEnd)
    expect(env).toContain('writeDisk: persist')
    expect(env).not.toMatch(/^\s*writeDisk,\s*$/m)
  })
})
