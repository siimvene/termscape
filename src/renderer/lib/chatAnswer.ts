import type { ChatMessage } from '@shared/types'
import {
  ANSWER_TEXT_MAX_CHARS,
  ASK_USER_QUESTION_TOOL,
  EXIT_PLAN_MODE_TOOL,
  type ChatQuestion,
  type HeldPermission,
  type PermissionAnswer
} from '@shared/agents/permission-answer'

/**
 * Pure decisions behind the ⌘M panel's answer controls on a Plan / Question card
 * (`nodes/ChatAnswerControls.tsx`): which card the held request belongs to, and what a selection
 * turns into. The renderer only ever builds a `PermissionAnswer`; core validates every field against
 * the pending request file and builds the hook's JSON (`core/agents/permission-decision.ts`).
 */

/** The three ways to approve a plan, in button order. There is deliberately no `auto`
 *  (see `PermissionAnswer`), and the default names what it actually does. */
export const PLAN_CHOICES: ReadonlyArray<{ mode: 'restore' | 'acceptEdits' | 'manual'; label: string; hint: string }> = [
  { mode: 'restore', label: 'Approve · previous mode', hint: 'Continue in the mode you were in before plan mode' },
  { mode: 'acceptEdits', label: 'Approve · accept edits', hint: 'Continue with file edits auto-approved' },
  { mode: 'manual', label: 'Approve · ask before edits', hint: 'Continue, asking before each edit' }
]

/** Typed text limit for "Revise…" and "Other" — the shared limit core enforces. */
export const CHAT_ANSWER_TEXT_MAX = ANSWER_TEXT_MAX_CHARS

/** Where a card lives in the rendered thread. */
export interface AnswerCardRef {
  message: number
  part: number
}

/**
 * The ONE card the node's held request belongs to, or null (every card stays read-only).
 *
 * The candidate is the NEWEST tool part named like the held tool — an older plan or question is
 * history — and it must still be unanswered (no result). A question card must also carry the SAME
 * question texts, in order, as the held request (both come from `readQuestions`): a held ticket
 * whose texts are unknown, or a card whose questions could not be read, gets no controls.
 */
export function activeAnswerCard(messages: readonly ChatMessage[], held: HeldPermission | undefined): AnswerCardRef | null {
  if (!held || (held.toolName !== EXIT_PLAN_MODE_TOOL && held.toolName !== ASK_USER_QUESTION_TOOL)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i].parts
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j]
      if (p.kind !== 'tool' || p.name !== held.toolName) continue
      if (p.result !== undefined || !p.body) return null
      if (held.toolName === EXIT_PLAN_MODE_TOOL) return { message: i, part: j }
      const texts = held.questions
      const qs = p.questions
      if (!texts || !qs || texts.length !== qs.length || !qs.every((q, k) => q.question === texts[k])) return null
      return { message: i, part: j }
    }
  }
  return null
}

/** What the user has picked for one question. `labels` are option labels; `other` + `otherText`
 *  is the free-text "Other" (the only input on a question with no options). */
export interface QuestionSelection {
  labels: string[]
  other: boolean
  otherText: string
}

export const emptySelection = (questions: readonly ChatQuestion[]): QuestionSelection[] =>
  questions.map(() => ({ labels: [], other: false, otherText: '' }))

/** Add or remove one label (a checkbox). */
export function toggleLabel(labels: readonly string[], label: string, on: boolean): string[] {
  const rest = labels.filter((l) => l !== label)
  return on ? [...rest, label] : rest
}

/**
 * The free text a question's answer would carry, or null when it is not a free-text answer. ONE
 * definition, so the text that is capped is the text that is sent: on a multi choice with "Other" it
 * is the ticked labels (in option order) plus the typed text, joined with ", " — the TUI's own
 * multi-select format, and one string because core carries one free-text answer per question.
 * Core caps THAT string, so capping only the typed part let a long answer through to a refusal.
 */
function freeTextOf(q: ChatQuestion, sel: QuestionSelection): string | null {
  if (!sel.other && q.options.length > 0) return null
  const typed = sel.otherText.trim()
  const labels = q.options.map((o) => o.label).filter((l) => sel.labels.includes(l))
  return q.multiSelect && labels.length && typed ? [...labels, typed].join(', ') : typed
}

/** The first question whose free-text answer is over the shared cap (core would refuse it), or null.
 *  The controls name it instead of leaving Submit disabled without a reason. */
export function answerTooLong(
  questions: readonly ChatQuestion[],
  selections: readonly QuestionSelection[]
): string | null {
  for (let i = 0; i < questions.length && i < selections.length; i++) {
    const text = freeTextOf(questions[i], selections[i])
    if (text !== null && text.length > CHAT_ANSWER_TEXT_MAX) return questions[i].question
  }
  return null
}

/**
 * The structured answer for a set of selections, or null while any question is unanswered, a pick is
 * not one of that question's own options, or a free-text answer is over the cap (never sent — core
 * would refuse it anyway).
 *
 *  - single choice → the label; multi choice → its labels in OPTION order;
 *  - "Other" (or a question with no options) → `freeTextOf`, listed in `freeText`.
 */
export function questionAnswerFrom(
  questions: readonly ChatQuestion[],
  selections: readonly QuestionSelection[]
): Extract<PermissionAnswer, { kind: 'question' }> | null {
  if (questions.length === 0 || selections.length !== questions.length) return null
  const answers: Record<string, string | string[]> = {}
  const freeText: string[] = []
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    const sel = selections[i]
    const known = q.options.map((o) => o.label)
    if (!sel.labels.every((l) => known.includes(l))) return null
    const labels = known.filter((l) => sel.labels.includes(l))
    const text = freeTextOf(q, sel)
    if (text !== null) {
      if (!text || text.length > CHAT_ANSWER_TEXT_MAX) return null
      answers[q.question] = text
      freeText.push(q.question)
    } else if (q.multiSelect) {
      if (labels.length === 0) return null
      answers[q.question] = labels
    } else {
      if (labels.length !== 1) return null
      answers[q.question] = labels[0]
    }
  }
  return freeText.length ? { kind: 'question', answers, freeText } : { kind: 'question', answers }
}

/** "Revise…": the feedback message, or null while it is blank. */
export function planReviseAnswer(text: string): Extract<PermissionAnswer, { kind: 'plan-revise' }> | null {
  const message = text.trim()
  return message && message.length <= CHAT_ANSWER_TEXT_MAX ? { kind: 'plan-revise', message } : null
}
