import { TEXT_NOT_SUBMITTED } from '@shared/text-delivery'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { renderMarkdown } from '../lib/markdown'
import { useAgentStatus } from '../state/agentStatus'
import { useSession } from '../session/session'
import { chipFor } from '../lib/keybindingOverrides'
import { chatComposerPlaceholder, chatSendRefusal } from '../lib/chatSendGate'
import { chatAgentLabel, isNearBottom, shouldFollowOnLoad, toolCardTitle } from '../lib/chatPanel'
import { useSettings } from '../state/settings'
import {
  CHAT_OLDER_PAGE_BYTES,
  CHAT_TAIL_PAGE_BYTES,
  anchoredScrollTop,
  applyOlder,
  applyTail,
  emptyThread,
  shouldFetchOlder,
  type ChatThread
} from '../lib/chatPaging'
import { E_UNSUPPORTED } from '@shared/rpc'
import { Spinner } from '../components/Spinner'
import { CHAT_OPTIMISTIC_WORKING_MS, chatActivity, planLiveReload } from '../lib/chatLive'
import { ChatLoadingStatus } from './ChatPanelFallback'
import { activeAnswerCard } from '../lib/chatAnswer'
import { PlanAnswerControls, QuestionAnswerControls } from './ChatAnswerControls'
import type { PermissionAnswer } from '@shared/agents/permission-answer'
import { ChatComposer } from './ChatComposer'
import { ChatTurnActions } from './ChatTurnActions'
import { assistantTurnEnds } from '../lib/chatThread'

// Memoized bubble: marked+DOMPurify re-ran for EVERY message on each ChatPanel render (each
// turn-finish reload, each keystroke re-render). Text is stable per message, so cache per text.
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return <div className="term-chat__text" dangerouslySetInnerHTML={{ __html: html }} />
})

interface ChatPanelProps {
  nodeId: string
  sessionId?: string
  cwd?: string
  /** Managed Claude account this node runs under; resolves the transcript in the right root. */
  accountId?: string
  /** Which agent's reader to use. REQUIRED, and not cosmetic: claude's resolver falls back to the
   *  newest transcript for the cwd, so a non-claude node that arrives unlabelled is answered with
   *  another session's conversation. It was optional until 2026-09-02, defaulting to claude -- and
   *  deleting the single `agentId={agentId}` at the one mount site left the typecheck and 3767
   *  tests green while restoring that leak in full. Required makes the compiler the proof: the
   *  wiring cannot be dropped silently, with no render test needed to notice. */
  agentId: string
  /**
   * Read a transcript with no live session behind it (issue #531: a CLOSED node's conversation,
   * opened from "Recently closed"). Hides the composer — `pty.sendText` would be aimed at a node
   * id that no longer exists — and names the bar for what it is. Absent = the ⌘M panel on a live
   * node, byte-identical to before.
   */
  readOnly?: boolean
  /** Bar caption. Defaults to the ⌘M panel's own 'Chat'. */
  title?: string
  /** Rendered at the right of the bar in place of the ⌘M exit hint. */
  hint?: string
  /**
   * Resolve attached files (the composer's "+", a drop, a pasted file or screenshot) to the paths
   * the agent should read — the SAME resolution a drop onto the node's terminal uses
   * (`droppedPaths`), supplied by the mount site because only it knows the node's scope (an SSH
   * node uploads to its host over the master it runs on; a local one uses the local path, or the
   * uploads dir for clipboard bytes). Absent = no attach affordance.
   */
  pathsForFiles?: (files: File[]) => Promise<string[]>
  /**
   * Leave the ⌘M view for the node's terminal. The toolbar's model / effort labels type the
   * agent's own picker command (`/model`, `/effort`) into the pane and then call this, so the user
   * sees the picker they just opened. Absent = no labels (a label that opens a picker nobody can
   * see is worse than none).
   */
  onShowTerminal?: () => void
}

/**
 * Why the transcript isn't on screen. Every one of these used to render as "No conversation
 * yet.": a rejected read (this surface has no transcript reader at all) left `messages` at its
 * initial `[]` because nothing caught the rejection, and a failed resolution was indistinguishable
 * from a session nobody has spoken to. They need different words — and two of them are retryable.
 */
type LoadState = 'loading' | 'ok' | 'missing' | 'unsupported' | 'error'

const isUnsupported = (e: unknown): boolean =>
  !!e && typeof e === 'object' && (e as { code?: string }).code === E_UNSUPPORTED

/** One line each, in the user's terms: what is on screen and whether waiting will fix it.
 *  `missing` names the two causes that actually produce it — a transcript Claude has cleaned up
 *  (30 days by default), and a remote session whose host hasn't been reached yet — because the
 *  second one heals by itself the moment the session speaks, and the first one never will. */
const EMPTY_TEXT: Record<LoadState, { title: string; detail?: string }> = {
  loading: { title: 'Loading conversation…' },
  ok: { title: 'No conversation yet.' },
  missing: {
    title: 'No transcript found for this session.',
    detail: "It may have been cleaned up, or the agent's host isn't reachable yet."
  },
  unsupported: {
    title: "Transcripts can't be read on this surface.",
    detail: 'Open this session on the desktop app to read its conversation.'
  },
  error: { title: "Couldn't read the transcript." }
}

/**
 * Chat view for a chat-capable agent node (Cmd+M). Renders the session transcript as
 * markdown bubbles with collapsible tool calls, and sends new prompts into the running tmux
 * session via pty.sendText. While a turn runs, a status row closes the thread and the tail is
 * re-read (throttled) on every hook event, so the answer grows as it is written; the turn's end
 * (working -> idle) takes one final reload. Replaces the markdown-of-output overlay.
 */
export function ChatPanel({
  nodeId,
  sessionId,
  cwd,
  accountId,
  agentId,
  readOnly,
  title,
  hint,
  pathsForFiles,
  onShowTerminal
}: ChatPanelProps) {
  // This node's core api (stable for the session — the chat transcript and the tmux session
  // both live on the core this panel's project belongs to).
  const { api } = useSession()
  // Which transcript this panel reads. Keys are byte offsets into ONE file, so a thread is only
  // ever merged with a read of the same identity (see lib/chatPaging.ts).
  const identity = JSON.stringify([nodeId, sessionId ?? null, cwd ?? null, accountId ?? null, agentId])
  const [thread, setThread] = useState<ChatThread>(() => emptyThread(identity))
  const messages = thread.messages
  // Read by the async handlers, which must decide against the thread as it is NOW, not as it was
  // when the read was issued.
  const threadRef = useRef(thread)
  threadRef.current = thread
  const [loadState, setLoadState] = useState<LoadState>('loading')
  // Mirror for `attemptLive`, which runs from timers and settles, outside any render.
  const loadStateRef = useRef(loadState)
  loadStateRef.current = loadState
  // The older-page fetch (scroll-up paging): its own in-flight flag and token, and a failed page
  // gets a retry row instead of retrying on every scroll event.
  const [olderState, setOlderState] = useState<'idle' | 'loading' | 'error'>('idle')
  // A tail read in flight. Older paging waits for it: the tail can RESET the thread (see
  // applyTail), and an older page fetched against the pre-reload cursor would be thrown away. State,
  // not a ref, so the paging check re-runs when the tail lands.
  const [tailLoading, setTailLoading] = useState(false)
  // Mirror for `load`, which must not depend on it (its identity drives the initial-load effect).
  const olderStateRef = useRef(olderState)
  olderStateRef.current = olderState
  const [input, setInput] = useState('')
  const [readonly, setReadonly] = useState(false)
  const [optimistic, setOptimistic] = useState(false)
  const state = useAgentStatus((s) => s.byId[nodeId]?.state)
  // The shell-owned-pane flags, each as its own primitive selector (an object selector would
  // re-render on every hook event for every node). See lib/chatSendGate.ts for why they gate.
  const hibernated = useAgentStatus((s) => s.byId[nodeId]?.hibernated)
  const paused = useAgentStatus((s) => s.byId[nodeId]?.paused)
  const dropped = useAgentStatus((s) => s.byId[nodeId]?.dropped)
  const sessionEnded = useAgentStatus((s) => s.byId[nodeId]?.sessionEnded)
  // The request the node's managed hook is holding (plan / question / permission). The store keeps
  // the same object across same-ticket events, so this selector re-renders only on a new hold.
  const held = useAgentStatus((s) => s.byId[nodeId]?.held)
  const customAgents = useSettings((s) => s.settings.customAgents)
  // Not just `working`: a TUI dialog (`waiting`/`blocked`) would be ANSWERED by sendText's Enter,
  // and a pane whose CLI is gone (hibernated/paused/dropped/exited) is a SHELL that would execute it.
  const refusal = chatSendRefusal(agentId, { state, hibernated, paused, dropped, sessionEnded })
  const agentLabel = chatAgentLabel(agentId, customAgents)
  // What the row closing the thread says (lib/chatLive.ts). `optimistic` covers the gap between a
  // send and the first hook event: set by `send`, retired by the next state change (the real state
  // takes over) or, for an agent whose hooks never report, after a bounded timeout.
  const activity = chatActivity({ refusal, optimistic, readOnly: !!readOnly })
  // The one Plan / Question card that gets answer controls (lib/chatAnswer.ts): only while the pane
  // holds a TUI dialog (`dialog` — the CLI is in the pane and waiting) and only on the card the held
  // ticket belongs to. A host whose hook script predates structured answers never sends `held`, so
  // its cards stay read-only — the terminal path is then the only one, exactly as before.
  const answerCard = useMemo(
    () => (!readOnly && refusal === 'dialog' ? activeAnswerCard(messages, held) : null),
    [readOnly, refusal, messages, held]
  )
  const msgsRef = useRef<HTMLDivElement>(null)
  const prevState = useRef(state)
  // Request token: only the NEWEST readTranscript may land. An older read resolving late (the
  // sessionId changed underneath it, or a ↻ raced the turn-finish reload) would otherwise paint
  // another session's thread over the current one. Bumped on unmount too, so a read that resolves
  // after the panel closed is dropped rather than applied to a dead component.
  const reqRef = useRef(0)
  // Scroll-follow inputs, captured BEFORE a load changes the content: was the user following the
  // bottom (updated on every scroll), and did they just send (they expect to see it land).
  const nearBottomRef = useRef(true)
  const justSentRef = useRef(false)
  // Token for the older-page fetch. A TAIL load bumps it too: a tail read can reset the thread
  // (see applyTail), and an older page computed against the previous cursor must not land on it.
  const olderReqRef = useRef(0)
  const olderInFlightRef = useRef(false)
  // Geometry captured just BEFORE content is inserted above the viewport (an older page, or the
  // "Loading earlier messages…" row appearing); the layout effect shifts scrollTop by the height
  // that was added, so what the user is reading stays put.
  const anchorRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null)
  // Never on a panel with no layout box (collapsed node, `display:none`): every metric is 0 there,
  // and an "anchor" at 0 would pin the view to the top of whatever loads while hidden.
  const captureAnchor = () => {
    const el = msgsRef.current
    if (el && el.clientHeight > 0) anchorRef.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight }
  }
  // Live refresh bookkeeping (lib/chatLive.ts `planLiveReload`). Refs, not state: none of it is
  // rendered, and a hook event must not re-render the panel just to note that it arrived.
  // - a TAIL read is in flight (any: initial, ↻, turn-end or live) — live reads never overlap one
  //   (nor an older-page fetch, `olderInFlightRef`);
  // - when the last tail read started — the throttle's clock;
  // - a hook event not yet served by a read — the trailing call, retried on settle / timer /
  //   reveal / visibilitychange;
  // - the trailing timer.
  const tailInFlightRef = useRef(false)
  const lastTailStartRef = useRef<number | null>(null)
  const livePendingRef = useRef(false)
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attemptLiveRef = useRef<() => void>(() => {})

  // `live` = a read driven by a hook event while the agent works (see `attemptLive`), as opposed to
  // the first open, the turn-end reload and ↻. A live read is background refresh: it keeps
  // unconfirmed sends on screen (`carryUnconfirmed`), leaves a failed older page's retry row alone
  // (clearing it would re-arm a failing fetch every interval) and never flips the empty state to
  // "Loading…" (which would strobe on every hook event).
  const load = useCallback((live = false) => {
    const token = ++reqRef.current
    olderReqRef.current++
    olderInFlightRef.current = false
    if (!live) {
      // Cancelling an older fetch (or clearing its error) removes a row ABOVE the viewport: anchor
      // it like any other change up there, or the view jumps by the row's height.
      if (olderStateRef.current !== 'idle') captureAnchor()
      setOlderState('idle')
    }
    setTailLoading(true)
    tailInFlightRef.current = true
    lastTailStartRef.current = Date.now()
    if (!live) setLoadState((s) => (s === 'ok' ? s : 'loading')) // a reload never blanks a rendered thread
    // `nodeId` is what lets an SSH-project node resolve on its host; the rejection branch is what
    // keeps a surface that cannot read transcripts (Server Edition, relay tab) from silently
    // presenting itself as an empty conversation. Only the newest TAIL window is read — older
    // history pages in on scroll-up, and a reload merges by key instead of discarding it.
    void api.chat.readTranscript(sessionId, cwd, accountId, nodeId, agentId, {
      maxBytes: CHAT_TAIL_PAGE_BYTES
    }).then(
      (res) => {
        if (token !== reqRef.current) return
        setTailLoading(false)
        tailInFlightRef.current = false
        // A hook event held while this read was in flight gets its (trailing) read now.
        queueMicrotask(() => attemptLiveRef.current())
        if (!res.found) {
          // `missing` only when there is nothing of THIS transcript on screen. A reload that
          // failed to resolve (an SSH master blip) must not blank a thread the user is reading.
          const t = threadRef.current
          if (t.identity === identity && t.messages.length > 0) {
            // The thread on screen is still this transcript's: back to `ok`, or the `loading` this
            // reload set would stick and silently disable older paging (it waits for `ok`).
            setLoadState('ok')
            return
          }
          setThread(emptyThread(identity))
          setLoadState('missing')
          return
        }
        setThread((t) => applyTail(t, identity, res, { carryUnconfirmed: live }))
        setLoadState('ok')
      },
      (e: unknown) => {
        if (token !== reqRef.current) return
        setTailLoading(false)
        tailInFlightRef.current = false
        queueMicrotask(() => attemptLiveRef.current())
        // Same rule as a failed resolution: a rendered thread of this transcript stays usable.
        const t = threadRef.current
        if (t.identity === identity && t.messages.length > 0) {
          setLoadState('ok')
          return
        }
        // …and, as there, a thread of ANOTHER transcript (the session changed under the panel) is
        // cleared: the error message must not sit under the previous session's conversation.
        if (t.identity !== identity) setThread(emptyThread(identity))
        setLoadState(isUnsupported(e) ? 'unsupported' : 'error')
      }
    )
  }, [api, sessionId, cwd, accountId, nodeId, agentId, identity])

  // Fetch the next OLDER page and prepend it. One in flight at a time; a result that arrives
  // after a newer tail load (or unmount) is dropped by its token. A `found:false` here is a failed
  // older-page load, NOT a missing transcript: the rendered thread stays, and a retry row appears.
  const loadOlder = useCallback(() => {
    const before = thread.olderCursor
    if (before === null || olderInFlightRef.current || thread.identity !== identity) return
    const token = ++olderReqRef.current
    olderInFlightRef.current = true
    captureAnchor()
    setOlderState('loading')
    const settle = () => {
      olderInFlightRef.current = false
      // A hook event held behind this page gets its (trailing) tail read now.
      queueMicrotask(() => attemptLiveRef.current())
    }
    void api.chat.readTranscript(sessionId, cwd, accountId, nodeId, agentId, {
      before,
      maxBytes: CHAT_OLDER_PAGE_BYTES
    }).then(
      (res) => {
        if (token !== olderReqRef.current) return
        settle()
        captureAnchor()
        if (!res.found) {
          setOlderState('error')
          return
        }
        setThread((t) => (t.identity === identity && t.olderCursor === before ? applyOlder(t, res) : t))
        setOlderState('idle')
      },
      () => {
        if (token !== olderReqRef.current) return
        settle()
        captureAnchor()
        setOlderState('error')
      }
    )
  }, [api, sessionId, cwd, accountId, nodeId, agentId, identity, thread.olderCursor, thread.identity])

  // Initial load.
  useEffect(() => {
    load()
  }, [load])

  // Invalidate any in-flight read when the panel goes away.
  useEffect(
    () => () => {
      reqRef.current++
      olderReqRef.current++
      livePendingRef.current = false
      attemptLiveRef.current = () => {}
      if (liveTimerRef.current !== null) clearTimeout(liveTimerRef.current)
      liveTimerRef.current = null
    },
    []
  )

  // Serve a pending hook event if the plan allows it now; otherwise leave it pending for whichever
  // retry the plan waits on. Everything is read at call time (store, geometry, visibility): it
  // runs from timers and settles, long after the render that defined it.
  attemptLiveRef.current = () => {
    if (!livePendingRef.current) return
    // This surface cannot read transcripts at all (relay tab): every live read would be refused.
    if (loadStateRef.current === 'unsupported') {
      livePendingRef.current = false
      return
    }
    const el = msgsRef.current
    const plan = planLiveReload({
      working: useAgentStatus.getState().byId[nodeId]?.state === 'working',
      // No layout box (collapsed node, display:none) = the paging gate; a hidden document too.
      visible: !!el && el.clientHeight > 0 && !document.hidden,
      // An older page in flight counts too: `load` cancels it, and a live read every interval
      // would keep restarting the user's scroll-up paging for the whole turn.
      inFlight: tailInFlightRef.current || olderInFlightRef.current,
      now: Date.now(),
      lastStartAt: lastTailStartRef.current
    })
    switch (plan.kind) {
      case 'skip':
        livePendingRef.current = false
        return
      case 'hold':
        return
      case 'wait':
        if (liveTimerRef.current === null) {
          liveTimerRef.current = setTimeout(() => {
            liveTimerRef.current = null
            attemptLiveRef.current()
          }, plan.ms)
        }
        return
      case 'run':
        livePendingRef.current = false
        load(true)
    }
  }

  // Every hook event for this node — same-state ones included, which no zustand selector sees (the
  // store refreshes `stateAt` in place without notifying; see `onHookEvent`). While the agent is
  // working each one may have written to the transcript, so each asks for a tail refresh.
  useEffect(
    () =>
      useAgentStatus.getState().onHookEvent(nodeId, () => {
        livePendingRef.current = true
        attemptLiveRef.current()
      }),
    [nodeId]
  )

  // A tab that comes back into view serves what was held while it was hidden.
  useEffect(() => {
    const onVisibility = () => attemptLiveRef.current()
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  // Reload when a turn completes (working -> not working). Sessions whose hooks never report
  // `working` never take this path — the bar's ↻ is their reload.
  useEffect(() => {
    if (prevState.current === 'working' && state !== 'working') load()
    prevState.current = state
  }, [state, load])

  // Any state change retires the optimistic working row: from here the real state speaks.
  useEffect(() => {
    setOptimistic(false)
  }, [state])
  useEffect(() => {
    if (!optimistic) return
    const t = setTimeout(() => setOptimistic(false), CHAT_OPTIMISTIC_WORKING_MS)
    return () => clearTimeout(t)
  }, [optimistic])

  // Follow the newest message only when the user was already at the bottom or just sent; a user
  // scrolled up reading an earlier answer keeps their place. Layout effect: the jump lands before
  // paint, so a followed thread never flashes one frame short.
  //
  // Content inserted ABOVE the viewport (an older page, the loading row) is the other case: there
  // the anchor captured before the change wins, and the view is shifted by exactly the added
  // height — no jump, and no follow (the user is at the top, reading history).
  useLayoutEffect(() => {
    const el = msgsRef.current
    if (!el) return
    const anchor = anchorRef.current
    if (anchor) {
      anchorRef.current = null
      el.scrollTop = anchoredScrollTop(anchor, el.scrollHeight)
      return
    }
    if (shouldFollowOnLoad({ wasNearBottom: nearBottomRef.current, justSent: justSentRef.current })) {
      el.scrollTop = el.scrollHeight
      nearBottomRef.current = true
    }
    justSentRef.current = false
    // `activity`: the status row appearing at the end grows the thread like a message does.
  }, [messages, olderState, activity])

  const maybeLoadOlder = useCallback(() => {
    const el = msgsRef.current
    if (!el) return
    if (
      shouldFetchOlder({
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        olderCursor: thread.identity === identity ? thread.olderCursor : null,
        inFlight: olderInFlightRef.current || tailLoading,
        failed: olderState === 'error',
        loaded: loadState === 'ok'
      })
    ) {
      loadOlder()
    }
  }, [thread.identity, thread.olderCursor, identity, olderState, loadState, tailLoading, loadOlder])

  // After every thread change too, not only on scroll: a thread shorter than the viewport cannot
  // scroll, so without this its older history would be unreachable.
  useEffect(() => {
    maybeLoadOlder()
  }, [maybeLoadOlder])

  // The panel's box changing size — above all a collapsed node being EXPANDED (display:none → a
  // real box). Nothing else re-runs the checks then: while hidden, follow and anchor had zero
  // geometry to work with and paging was refused. So: a user who was following lands at the
  // bottom, and paging resumes (a short thread fetches older right away). Guarded: jsdom and old
  // engines have no ResizeObserver, and the panel works without it.
  const maybeLoadOlderRef = useRef(maybeLoadOlder)
  maybeLoadOlderRef.current = maybeLoadOlder
  useEffect(() => {
    const el = msgsRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let hadBox = el.clientHeight > 0
    const ro = new ResizeObserver(() => {
      const hasBox = el.clientHeight > 0
      if (hasBox && !hadBox && nearBottomRef.current) el.scrollTop = el.scrollHeight
      hadBox = hasBox
      maybeLoadOlderRef.current()
      attemptLiveRef.current() // a hook event held while the panel was hidden
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const onScroll = () => {
    const el = msgsRef.current
    if (el) nearBottomRef.current = isNearBottom(el)
    maybeLoadOlder()
  }

  const send = useCallback(async () => {
    const text = input.trim()
    // Read the store at SEND time, not the render-time values: a PermissionRequest (or an Eco
    // hibernation) that landed between the last render and this keypress must still block.
    if (!text || chatSendRefusal(agentId, useAgentStatus.getState().byId[nodeId] ?? {}) !== null) return
    const ok = await api.pty.sendText(nodeId, text)
    if (ok === 'pasted-not-submitted') {
      window.dispatchEvent(new CustomEvent('nodeterm:toast', { detail: { kind: 'error', message: TEXT_NOT_SUBMITTED } }))
      setInput('')
      return
    }
    if (!ok) {
      setReadonly(true)
      return
    }
    // Optimistic: show the prompt immediately. A live read keeps it until the transcript carries it
    // (`carryUnconfirmed`); the turn-end reload / ↻ reconcile from the transcript outright.
    justSentRef.current = true
    setThread((t) => ({ ...t, messages: [...t.messages, { role: 'user', parts: [{ kind: 'text', text }] }] }))
    setOptimistic(true)
    setInput('')
  }, [api, input, nodeId, agentId])

  const onWriteRefused = useCallback(() => setReadonly(true), [])

  // Answer the held request through core, which validates the answer against the pending request
  // file and builds what the hook prints. The ticket is re-checked against the store at SEND time:
  // a hold that ended (answered in the TUI, timed out, replaced) while the user was choosing must
  // not receive an answer meant for it — that reads as a refusal, and the card says to use the
  // terminal. `false` from core is the same (see ChatAnswerControls).
  const answerHeld = useCallback(
    async (pendingId: string, answer: PermissionAnswer): Promise<boolean> => {
      if (useAgentStatus.getState().byId[nodeId]?.held?.pendingId !== pendingId) return false
      return api.answerPermission({ nodeId, pendingId, answer })
    },
    [api, nodeId]
  )

  // Whatever the markdown/chat toggle is bound to; '' when unbound, in which case the bar names
  // the action instead of promising a chord that never fires.
  const mdChip = chipFor('node.toggleMarkdown')

  // The thread's claude.ai look (lib/chatThread.ts): one action row per assistant TURN, keyed by
  // the turn's last message. `now` is ONE clock for every row's relative time, ticked once a minute
  // (a per-row timer would be a timer per turn for a label that changes once a minute).
  const turnEnds = useMemo(() => assistantTurnEnds(messages), [messages])
  // The last key IS the latest turn end: `assistantTurnEnds` inserts in thread order.
  const latestTurnEnd = useMemo(() => {
    let last = -1
    for (const k of turnEnds.keys()) last = k
    return last
  }, [turnEnds])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  // A tail that yielded no message but has history behind it (all-metadata records, or a window a
  // single huge record filled) is STILL LOADING — the panel pages back by itself from here. Saying
  // "No conversation yet." there, until the older page landed, told the user a session with a
  // whole conversation had none. A failed older page gets the retry row instead (below).
  const historyPending = thread.identity === identity && thread.olderCursor !== null
  const initialLoading =
    messages.length === 0 &&
    (loadState === 'loading' || (loadState === 'ok' && historyPending && olderState !== 'error'))
  const showEmpty = messages.length === 0 && loadState !== 'loading' && !(loadState === 'ok' && historyPending)

  return (
    // `data-chat-node-id`: which node's chat view this is — the mics that name only a node ask it
    // (lib/chatComposerDictation.ts `dictationTargetForNode`) so a take never reaches the hidden pane.
    <div className="term-chat nodrag nowheel" data-chat-node-id={nodeId}>
      <div className="term-chat__bar">
        <span>{title ?? 'Chat'}</span>
        <span className="term-chat__bar-end">
          <button
            className="term-chat__refresh"
            onClick={() => load()}
            title="Reload conversation"
            aria-label="Reload conversation"
          >
            ↻
          </button>
          <span className="term-chat__hint">{hint ?? (mdChip ? `${mdChip} to exit` : 'Exit')}</span>
        </span>
      </div>
      <div className="term-chat__msgs" ref={msgsRef} onScroll={onScroll}>
        {initialLoading && (
          <ChatLoadingStatus text={EMPTY_TEXT.loading.title} />
        )}
        {messages.length > 0 && olderState === 'loading' && (
          <div className="term-chat__older" role="status">
            <Spinner />
            <span>Loading earlier messages…</span>
          </div>
        )}
        {olderState === 'error' && (
          <div className="term-chat__older term-chat__older--error">
            <span>Couldn't load earlier messages.</span>
            <button className="term-chat__retry" onClick={loadOlder}>
              Retry
            </button>
          </div>
        )}
        {/* Only a PAGED thread (keyed messages) can know it reached the start; grok's capped
            whole-file read says nothing about what lies before it. */}
        {olderState === 'idle' && thread.olderCursor === null && messages.some((m) => m.key !== undefined) && (
          <div className="term-chat__older term-chat__older--start">Beginning of conversation</div>
        )}
        {showEmpty && (
          <div className="term-chat__empty">
            <div>{EMPTY_TEXT[loadState].title}</div>
            {EMPTY_TEXT[loadState].detail && (
              <div className="term-chat__empty-detail">{EMPTY_TEXT[loadState].detail}</div>
            )}
            {loadState !== 'unsupported' && loadState !== 'ok' && (
              <button className="term-chat__retry" onClick={() => load()}>
                Retry
              </button>
            )}
          </div>
        )}
        {messages.map((m, i) => (
          // Keyed by the source line's byte offset: a prepended page does not re-key (and so does
          // not re-render) a single existing bubble. Unkeyed ones (grok, the optimistic sent
          // bubble) fall back to their position.
          <div
            key={m.key !== undefined ? `k${m.key}` : `i${i}`}
            className={`term-chat__msg term-chat__msg--${m.role}${m.role === 'user' ? ' term-chat__bubble' : ''}`}
          >
            {m.parts.map((p, j) =>
              p.kind === 'text' ? (
                <MarkdownText key={j} text={p.text} />
              ) : p.kind === 'thinking' ? (
                // Reasoning, not the answer: collapsed by default so it cannot be mistaken for it.
                <details key={j} className="term-chat__thinking">
                  <summary>Thinking</summary>
                  <MarkdownText text={p.text} />
                </details>
              ) : p.body ? (
                // A plan / question is the content itself, not plumbing: shown expanded, in full,
                // flowing with the thread (no inner scroll box). The answer stays under it.
                <div key={j} className="term-chat__tool-card">
                  <div className="term-chat__tool-card-title">{toolCardTitle(p.name)}</div>
                  <MarkdownText text={p.body} />
                  {p.result && <pre className="term-chat__tool-result">{p.result}</pre>}
                  {answerCard && held && answerCard.message === i && answerCard.part === j && (
                    // Keyed by the ticket: a new hold on the same card starts from a clean state.
                    p.name === 'AskUserQuestion' && p.questions ? (
                      <QuestionAnswerControls
                        key={held.pendingId}
                        questions={p.questions}
                        agentLabel={agentLabel}
                        chip={mdChip}
                        onSubmit={(a) => answerHeld(held.pendingId, a)}
                      />
                    ) : (
                      <PlanAnswerControls
                        key={held.pendingId}
                        agentLabel={agentLabel}
                        chip={mdChip}
                        onSubmit={(a) => answerHeld(held.pendingId, a)}
                      />
                    )
                  )}
                </div>
              ) : (
                <details key={j} className="term-chat__tool">
                  <summary>
                    <span className="term-chat__tool-name">{p.name}</span>
                    {p.arg && <span className="term-chat__tool-arg">{p.arg}</span>}
                  </summary>
                  {p.result && <pre className="term-chat__tool-result">{p.result}</pre>}
                </details>
              )
            )}
            {turnEnds.has(i) && (
              <ChatTurnActions
                copyText={turnEnds.get(i)!.copyText}
                at={turnEnds.get(i)!.at}
                now={now}
                latest={i === latestTurnEnd}
              />
            )}
          </div>
        ))}
        {activity && (
          // One live region for both sentences, so working → waiting changes its text instead of
          // remounting it (a remounted role=status is announced again). The words are the
          // composer placeholder's own (`chatComposerPlaceholder`), so the two never disagree.
          <div className="term-chat__activity" role="status" aria-live="polite">
            {activity === 'working' && <Spinner />}
            {chatComposerPlaceholder({
              readonly: false,
              refusal: activity,
              agentLabel,
              chip: mdChip,
              answerOnCard: answerCard !== null
            })}
          </div>
        )}
      </div>
      {!readOnly && (
        <ChatComposer
          nodeId={nodeId}
          sessionId={sessionId}
          agentId={agentId}
          agentLabel={agentLabel}
          value={input}
          onChange={setInput}
          onSend={() => void send()}
          placeholder={chatComposerPlaceholder({
            readonly,
            refusal,
            agentLabel,
            chip: mdChip,
            answerOnCard: answerCard !== null
          })}
          disabled={readonly || refusal !== null}
          onWriteRefused={onWriteRefused}
          sendUnconfirmed={optimistic}
          pathsForFiles={pathsForFiles}
          onShowTerminal={onShowTerminal}
        />
      )}
    </div>
  )
}
