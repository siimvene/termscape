import { grokRawFields } from '../shared/agents/normalize'
import { grokSessionDir, grokSessionsDir } from './agents/grok-paths'
import { forgetGrokSession, rememberGrokSessionDir } from './grok-session'

export interface GrokHookSessionPlan {
  event: string
  sessionId: string | undefined
  cwd: string | undefined
  forgetSessionId: string | undefined
}

export interface GrokHookSessionDeps {
  sessionsDir: string
  rememberSessionDir: (sessionId: string, dir: string) => void
  forgetSession: (sessionId: string | undefined) => void
}

/**
 * Decode the two Grok hook dialects and decide the session-map transition once for both shells.
 * SessionEnd is the only event that retires an id, and it retires the one the event itself carries.
 * Measured on grok 1.0.13: compaction does NOT mint a new id (see the note in the body).
 */
export function planGrokHookSession(
  payload: Record<string, unknown>,
  previousSessionId: string | undefined
): GrokHookSessionPlan {
  const { event, sessionId, cwd } = grokRawFields(payload)
  // SessionEnd is the only event that retires an id.
  //
  // There used to be a PostCompact branch here, retiring the PREVIOUS id on the belief that grok
  // mints a new one when it compacts. Measured: it does not. The captured pair carries the same
  // `sessionId` in `pre_compact` and `post_compact`, so the branch could not fire — and the belief
  // came from a comment, not from data. Removed rather than kept as a defensive guard: a branch
  // that cannot be exercised is one nobody can prove or disprove, and in six months it reads as a
  // measurement again. This one already did — it was cited as evidence in a rebase decision.
  const forgetSessionId = event === 'sessionend' ? sessionId : undefined

  return { event, sessionId, cwd, forgetSessionId }
}

/** Apply the complete Grok raw-listener session behavior shared by desktop and Server Edition. */
export function applyGrokHookSession(
  nodeId: string,
  payload: Record<string, unknown>,
  nodeContextSession: Map<string, string>,
  deps?: GrokHookSessionDeps
): GrokHookSessionPlan {
  const previousSessionId = nodeId ? nodeContextSession.get(nodeId) : undefined
  const plan = planGrokHookSession(payload, previousSessionId)
  const sessionsDir = deps?.sessionsDir ?? grokSessionsDir()
  const remember = deps?.rememberSessionDir ?? rememberGrokSessionDir
  const forget = deps?.forgetSession ?? forgetGrokSession

  if (nodeId && plan.sessionId) nodeContextSession.set(nodeId, plan.sessionId)
  if (plan.sessionId && plan.cwd) {
    const dir = grokSessionDir({ sessionsDir, cwd: plan.cwd, sessionId: plan.sessionId })
    if (dir) remember(plan.sessionId, dir)
  }
  if (plan.forgetSessionId) forget(plan.forgetSessionId)

  return plan
}
