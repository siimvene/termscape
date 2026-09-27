import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/types'
import type { ChatQuestion } from '@shared/agents/permission-answer'
import {
  PLAN_CHOICES,
  activeAnswerCard,
  emptySelection,
  CHAT_ANSWER_TEXT_MAX,
  answerTooLong,
  planReviseAnswer,
  questionAnswerFrom,
  toggleLabel
} from './chatAnswer'

const SINGLE: ChatQuestion = { question: 'Pick one?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }
const MULTI: ChatQuestion = {
  question: 'Which surfaces?',
  multiSelect: true,
  options: [{ label: 'Desktop' }, { label: 'Server' }, { label: 'Phone' }]
}
const FREE: ChatQuestion = { question: 'Name?', multiSelect: false, options: [] }

const plan = (key: number, result?: string): ChatMessage => ({
  role: 'assistant',
  key,
  parts: [{ kind: 'tool', name: 'ExitPlanMode', arg: '', body: '# plan', ...(result ? { result } : {}) }]
})
const ask = (key: number, questions: ChatQuestion[] | undefined, result?: string): ChatMessage => ({
  role: 'assistant',
  key,
  parts: [
    { kind: 'text', text: 'before' },
    {
      kind: 'tool',
      name: 'AskUserQuestion',
      arg: '',
      body: 'q',
      ...(questions ? { questions } : {}),
      ...(result ? { result } : {})
    }
  ]
})

describe('PLAN_CHOICES', () => {
  it('offers the three approve modes, restore first, and never auto', () => {
    expect(PLAN_CHOICES.map((c) => c.mode)).toEqual(['restore', 'acceptEdits', 'manual'])
    // The default names what it does: restore the mode that preceded plan mode.
    expect(PLAN_CHOICES[0].label.toLowerCase()).toContain('previous mode')
  })
})

describe('activeAnswerCard — only the card the held ticket belongs to gets controls', () => {
  const heldPlan = { pendingId: 'n-1', toolName: 'ExitPlanMode' }
  it('the LAST unanswered plan card matches a held plan; older cards stay read-only', () => {
    const msgs = [plan(0, 'User approved'), plan(10), { role: 'user', parts: [{ kind: 'text', text: 'x' }] } as ChatMessage]
    expect(activeAnswerCard(msgs, heldPlan)).toEqual({ message: 1, part: 0 })
    expect(activeAnswerCard([plan(0), plan(10)], heldPlan)).toEqual({ message: 1, part: 0 })
  })
  it('no controls when the newest plan card already has its result, or nothing is held', () => {
    expect(activeAnswerCard([plan(0), plan(10, 'User approved')], heldPlan)).toBeNull()
    expect(activeAnswerCard([plan(0)], undefined)).toBeNull()
    expect(activeAnswerCard([plan(0)], { pendingId: 'n-1', toolName: 'Bash' })).toBeNull()
  })
  it('a question card matches only when its question texts equal the held ones, in order', () => {
    const held = { pendingId: 'n-2', toolName: 'AskUserQuestion', questions: ['Pick one?', 'Which surfaces?'] }
    expect(activeAnswerCard([ask(0, [SINGLE, MULTI])], held)).toEqual({ message: 0, part: 1 })
    expect(activeAnswerCard([ask(0, [MULTI, SINGLE])], held)).toBeNull()
    expect(activeAnswerCard([ask(0, [SINGLE])], held)).toBeNull()
    // The texts match an OLDER card but the newest question card is another one: read-only.
    expect(activeAnswerCard([ask(0, [SINGLE, MULTI]), ask(10, [FREE])], held)).toBeNull()
  })
  it('a held question without texts, or a card without structured questions, gets no controls', () => {
    expect(activeAnswerCard([ask(0, [SINGLE])], { pendingId: 'n-2', toolName: 'AskUserQuestion' })).toBeNull()
    expect(
      activeAnswerCard([ask(0, undefined)], { pendingId: 'n-2', toolName: 'AskUserQuestion', questions: ['Pick one?'] })
    ).toBeNull()
  })
})

describe('questionAnswerFrom — UI selection → the structured answer core validates', () => {
  it('single choice → the label string', () => {
    const sel = emptySelection([SINGLE])
    sel[0].labels = ['B']
    expect(questionAnswerFrom([SINGLE], sel)).toEqual({ kind: 'question', answers: { 'Pick one?': 'B' } })
  })
  it('multi choice → labels in OPTION order, whatever order they were ticked', () => {
    const sel = emptySelection([MULTI])
    sel[0].labels = toggleLabel(toggleLabel([], 'Phone', true), 'Desktop', true)
    expect(questionAnswerFrom([MULTI], sel)).toEqual({ kind: 'question', answers: { 'Which surfaces?': ['Desktop', 'Phone'] } })
  })
  it('"Other" on a single choice → free text listed in freeText', () => {
    const sel = emptySelection([SINGLE])
    sel[0].other = true
    sel[0].otherText = '  neither  '
    expect(questionAnswerFrom([SINGLE], sel)).toEqual({
      kind: 'question',
      answers: { 'Pick one?': 'neither' },
      freeText: ['Pick one?']
    })
  })
  it('"Other" on a multi choice joins the ticked labels and the typed text the way the TUI does', () => {
    const sel = emptySelection([MULTI])
    sel[0].labels = ['Server']
    sel[0].other = true
    sel[0].otherText = 'Watch'
    expect(questionAnswerFrom([MULTI], sel)).toEqual({
      kind: 'question',
      answers: { 'Which surfaces?': 'Server, Watch' },
      freeText: ['Which surfaces?']
    })
  })
  it('a question with no options is answered by its text field alone', () => {
    const sel = emptySelection([FREE])
    sel[0].otherText = 'Ada'
    expect(questionAnswerFrom([FREE], sel)).toEqual({ kind: 'question', answers: { 'Name?': 'Ada' }, freeText: ['Name?'] })
  })
  it('several questions answer together; every one must be answered', () => {
    const sel = emptySelection([SINGLE, MULTI])
    sel[0].labels = ['A']
    expect(questionAnswerFrom([SINGLE, MULTI], sel)).toBeNull()
    sel[1].labels = ['Server']
    expect(questionAnswerFrom([SINGLE, MULTI], sel)).toEqual({
      kind: 'question',
      answers: { 'Pick one?': 'A', 'Which surfaces?': ['Server'] }
    })
  })
  it('incomplete selections produce nothing to send', () => {
    const sel = emptySelection([SINGLE])
    expect(questionAnswerFrom([SINGLE], sel)).toBeNull()
    sel[0].other = true
    sel[0].otherText = '   '
    expect(questionAnswerFrom([SINGLE], sel)).toBeNull()
    expect(questionAnswerFrom([FREE], emptySelection([FREE]))).toBeNull()
  })
  it('the JOINED multi-select + Other text is what the cap applies to (core refuses past it)', () => {
    const sel = emptySelection([MULTI])
    sel[0].labels = ['Desktop', 'Server']
    sel[0].other = true
    // The typed text alone fits; "Desktop, Server, " pushes the joined answer over the cap.
    sel[0].otherText = 'x'.repeat(CHAT_ANSWER_TEXT_MAX - 5)
    expect(questionAnswerFrom([MULTI], sel)).toBeNull()
    expect(answerTooLong([MULTI], sel)).toBe('Which surfaces?')
    // Just under: sent, and nothing is flagged.
    sel[0].otherText = 'x'.repeat(CHAT_ANSWER_TEXT_MAX - 'Desktop, Server, '.length)
    expect(questionAnswerFrom([MULTI], sel)).not.toBeNull()
    expect(answerTooLong([MULTI], sel)).toBeNull()
  })

  it('a single-choice "Other" over the cap is flagged too', () => {
    const sel = emptySelection([SINGLE])
    sel[0].other = true
    sel[0].otherText = 'y'.repeat(CHAT_ANSWER_TEXT_MAX + 1)
    expect(questionAnswerFrom([SINGLE], sel)).toBeNull()
    expect(answerTooLong([SINGLE], sel)).toBe('Pick one?')
  })

  it('a label that is not one of the question\'s options is never sent', () => {
    const sel = emptySelection([SINGLE])
    sel[0].labels = ['Z']
    expect(questionAnswerFrom([SINGLE], sel)).toBeNull()
  })
})

describe('planReviseAnswer', () => {
  it('trims, and refuses a blank message', () => {
    expect(planReviseAnswer('  add tests  ')).toEqual({ kind: 'plan-revise', message: 'add tests' })
    expect(planReviseAnswer('   ')).toBeNull()
  })
})

