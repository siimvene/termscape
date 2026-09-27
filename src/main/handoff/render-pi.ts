// Renders a pi session .jsonl (`<agentDir>/sessions/<encoded cwd>/<ts>_<id>.jsonl`) to full
// Markdown. No size cap, no summarization.
//
// Shape knowledge is NOT duplicated here. `linesFromPi` (core/pi-session.ts) already parses every
// measured record type from a real session (`__fixtures__/pi/session.jsonl`) into the same
// `role: text` / `  $ tool arg` / `  = result` shape every other renderer in this codebase emits —
// this module only turns those lines into Markdown headings, exactly like `render-grok.ts` does
// for `linesFromGrok`.
import { linesFromPi } from '../../core/pi-session'

/** `role: text` (and the `  $ `/`  = ` tool lines) as `linesFromPi` emits them. */
const ROLE_RE = /^(\w+): ([\s\S]*)$/

const HEADINGS: Record<string, string> = {
  user: 'User',
  assistant: 'Assistant'
}

export function renderPiTranscript(raw: string): string {
  const out: string[] = []
  for (const line of linesFromPi(raw)) {
    // Tool lines are indented continuations of the message above them, never messages of their
    // own, so they keep their `$`/`=` prefix and get no heading.
    if (line.startsWith('  ')) {
      out.push(line.trim())
      continue
    }
    const m = ROLE_RE.exec(line)
    if (!m) {
      out.push(line)
      continue
    }
    const [, role, text] = m
    out.push(`## ${HEADINGS[role] ?? `Message (${role})`}\n\n${text}`)
  }
  return out.join('\n\n')
}
