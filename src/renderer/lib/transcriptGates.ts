import { readsClaudeShapedTranscript, type AgentId } from '@shared/agents/config'

/**
 * Does this node's conversation live in a file **claude's** transcript readers can locate and parse?
 *
 * This is the gate for every feature that goes through `core/transcript-ipc.ts`'s
 * `resolveTranscript` — today the find bar's transcript index (`claude.readTranscript`). It is
 * deliberately NOT `hasUsage`.
 *
 * That reader, and the meter's mount-time rehydration beside it, used to share `hasUsage` with the
 * context METER, back when all three were claude-only and the distinction cost nothing. Then codex and gemini joined `USAGE_CAPABLE` (their own
 * transcripts state the numbers a meter needs) and the shared gate turned into a bug in both
 * features at once, because `resolveTranscript` has a **cwd fallback**: when the sessionId leg
 * misses — which it always does for a codex/gemini id, since no `<that id>.jsonl` exists under
 * `~/.claude/projects` — it returns *the newest claude transcript for that cwd*. So a codex node
 * would rehydrate its meter from a stranger's claude session (wrong numerator AND wrong
 * denominator, then flapping against the correct codex tail) and its find bar would present that
 * session's messages as its own hits. Even wired to the right file the reader would be wrong: it
 * parses claude's JSONL shape, which a codex rollout is not.
 *
 * `context.ensure` LEFT this gate in 2026-09 (issue #813) and is now gated on `hasUsage` at its call
 * site. Nothing about the danger above changed — what changed is that its handler stopped BEING
 * claude's resolver. `core/context-ensure.ts` routes on the agent id to that agent's OWN locator
 * (`locateCodex` / `locateGemini`, both keyed strictly by session id, with no cwd fallback) and its
 * own tail, so the resolver this function names is now reached only by an agent whose transcript it
 * can actually read. The find bar's index has no such routing and therefore has not moved. If you
 * are about to widen a THIRD consumer: route it, do not widen this.
 *
 * This used to read `CHAT_CAPABLE`, on the reasoning that it "already states exactly the fact being
 * asked for" and a separate list "would mean the same thing". That was true only while claude was
 * CHAT_CAPABLE's only member. Grok joined it in 2026-09 — we render grok's conversation ourselves
 * with `linesFromGrok` — while grok's file is neither shaped like claude's nor under claude's tree,
 * so the two facts came apart and the shared list became the very bug described above, pointed at a
 * new agent. The gate now reads `CLAUDE_TRANSCRIPT_READABLE`, which asks the narrower question this
 * function's name has always asked.
 *
 * The meter itself stays on `hasUsage`: it is fed by the per-agent context tails in the shells
 * (`geminiContextParse` / `codexContextParse` / `grokContextParse`), which need no resolver because
 * the hook envelope hands them the path.
 *
 * The follow-up this note used to carry — per-agent rehydration, so a codex/gemini meter fills at
 * MOUNT instead of only on its next turn — is DONE (`core/context-ensure.ts`). Grok is the one agent
 * still without it, and that is structural rather than pending: its meter reads a `signals.json`
 * whose directory is learned from a hook event, so after a restart there is no path to rehydrate
 * from at all.
 */
export function readsClaudeTranscript(agentId: AgentId | undefined): boolean {
  return !!agentId && readsClaudeShapedTranscript(agentId)
}
