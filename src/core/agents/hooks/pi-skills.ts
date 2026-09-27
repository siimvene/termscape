// Canvas-control skill installer for pi. pi implements the Agent Skills standard the same way
// Claude Code does — a directory containing `SKILL.md` (name/description frontmatter) under
// `<agentDir>/skills/` — so the envelope needs NO adaptation: the exact SKILL.md body Claude
// gets is byte-identical for pi.
//
// MEASURED on pi 0.84.1 (2026-09-26, temp PI_CODING_AGENT_DIR seeded with a read-only copy of a
// real logged-in `~/.pi/agent/auth.json`, never the real home): writing Claude's
// `buildCanvasSkillBody(shim)` output verbatim to `<agentDir>/skills/manage-nodeterm-canvas/SKILL.md`
// and asking pi (`-p`, `--no-session`) "List every skill you have loaded" answered exactly
// `manage-nodeterm-canvas` — discovered, named correctly, loaded with zero changes to the body.
// The generated description is 1029 chars, over pi's documented 1024-char soft limit
// (docs/skills.md "Validation"); pi's own docs say that only warns and still loads the skill,
// which the same run confirms (no error, correct name, no `--no-skills`-style silent drop).
//
// So this file owns only the WRITE (path + fs), never the text: it takes the already-built body
// from the SAME builder canvas-control-core.ts uses for Claude (`buildCanvasSkillBody`), so the
// two skills can never drift into two different sets of verbs. Callers (main/canvas-control.ts,
// server/canvas-control.ts) already compute the machine's shim path and pass the finished body in.
import fs from 'fs'
import path from 'path'

export const PI_CANVAS_SKILL_NAME = 'manage-nodeterm-canvas'

export function piSkillPathIn(agentDir: string, skillName: string): string {
  return path.join(agentDir, 'skills', skillName, 'SKILL.md')
}

/**
 * Write (or refresh) the manage-nodeterm-canvas skill into a pi agent dir's `skills/`.
 *
 * `agentDir` is whatever the caller resolved as pi's config root for the session in question —
 * the system dir (`piAgentDir()`, `~/.pi/agent` unless `$PI_CODING_AGENT_DIR` overrides it) today,
 * and — per `docs/pi-agent.md`'s managed-account design — a managed pi account's own dir later
 * (mirrors how `installCanvasSkillInto` in main/canvas-control.ts serves both the system Claude
 * dir and every managed Claude account dir with the same call). `skillBody` is the caller's
 * `buildCanvasSkillBody(shimPath)` output — never rebuilt here, so pi's copy can't fork from
 * Claude's.
 *
 * Unlike the pi status extension (`hooks/pi.ts`), this file is not marker-gated: a SKILL.md is
 * inert prose an agent reads on request, never code pi executes on every launch, so there is
 * nothing unsafe about unconditionally overwriting nodeterm's OWN skill directory (a user's own
 * skill would live under a different name and is never touched).
 */
export function installPiCanvasSkillsInto(agentDir: string, skillBody: string): void {
  const p = piSkillPathIn(agentDir, PI_CANVAS_SKILL_NAME)
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, skillBody, 'utf8')
  } catch (e) {
    console.warn('[pi-skills] skill install failed', p, e)
  }
}

export function removePiCanvasSkillsFrom(agentDir: string): void {
  try {
    fs.rmSync(path.join(agentDir, 'skills', PI_CANVAS_SKILL_NAME), { recursive: true, force: true })
  } catch {
    /* absent — nothing to remove */
  }
}
