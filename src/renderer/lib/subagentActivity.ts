/**
 * Parse a subagent card's flat activity stream into typed segments so the expanded card can read
 * like a regular agent window instead of a raw text dump.
 *
 * The stream (core/subagent-tail.ts `formatLine`, shared by the Task and Workflow tails) already
 * types every line by prefix — that contract is what this parser keys on:
 *   `✻ `   a thinking block's head
 *   `$ `   a tool call (`$ Bash ls`)
 *   `  ↳ ` that tool's one-line result summary
 *   anything else — assistant prose, streamed verbatim (usually markdown)
 *
 * Consecutive prose lines are merged into ONE block (newlines kept), so paragraphs, lists and
 * code fences survive to the markdown renderer instead of being split line-by-line. Result lines
 * fold into the tool segment they follow — a result with no preceding tool (its `$` line scrolled
 * off the store's bounded tail) still renders, as its own tool segment.
 *
 * Torn head tolerance: the store keeps only the tail of the stream (`slice(-CAP)`), so the FIRST
 * line may be the middle of something. It classifies by whatever prefix it (doesn't) have — worst
 * case a torn thinking/tool line renders as one odd prose line at the top, which then scrolls off.
 */

export type ActivitySegmentKind = 'prose' | 'thinking' | 'tool'

export interface ActivitySegment {
  kind: ActivitySegmentKind
  /** Prose: the merged markdown block. Thinking: the head text (no `✻ `). Tool: the `$ …` line,
   *  plus any `↳ …` result lines that followed it, newline-joined. */
  text: string
}

export function parseActivitySegments(activity: string): ActivitySegment[] {
  const segments: ActivitySegment[] = []
  const push = (kind: ActivitySegmentKind, text: string): void => {
    segments.push({ kind, text })
  }
  for (const line of activity.split('\n')) {
    const last = segments[segments.length - 1]
    if (line.startsWith('✻ ')) {
      push('thinking', line.slice(2))
    } else if (line.startsWith('$ ')) {
      push('tool', line)
    } else if (line.trimStart().startsWith('↳ ')) {
      // A tool's result summary — attach to the tool it belongs to.
      if (last?.kind === 'tool') last.text += `\n${line.trim()}`
      else push('tool', line.trim())
    } else if (last?.kind === 'prose') {
      // Merge consecutive prose (blank lines included — they are markdown paragraph breaks).
      last.text += `\n${line}`
    } else if (line.trim()) {
      push('prose', line)
    }
    // A blank line with no open prose block separates nothing — drop it.
  }
  // Trim each prose block's edges (merging keeps interior blanks; edge blanks are just noise).
  for (const s of segments) if (s.kind === 'prose') s.text = s.text.replace(/^\n+|\n+$/g, '')
  return segments.filter((s) => s.text.trim())
}
