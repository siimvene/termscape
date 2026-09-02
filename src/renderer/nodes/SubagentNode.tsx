import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import type { CanvasNode } from '../state/workspace'
import { useAgentNodes } from '../state/agentNodes'
import { parseActivitySegments } from '../lib/subagentActivity'
import { renderMarkdown } from '../lib/markdown'
import { type FanoutChild, fanoutCounts, fanoutElapsed } from '../lib/fanoutGroup'

/** Memoized markdown block (the ChatPanel `MarkdownText` pattern): marked+DOMPurify would
 *  otherwise re-run for EVERY prose segment on each streamed chunk. Segment text is stable
 *  once the stream has moved past it, so cache per text. */
const ProseBlock = memo(function ProseBlock({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text, { breaks: true }), [text])
  return <div className="subagent-node__prose term-chat__text" dangerouslySetInnerHTML={{ __html: html }} />
})

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** The expanded transcript body of ONE subagent, subscribed per-id so streaming chunks re-render
 *  only this block (never the whole canvas). Shared by the standalone card (`variant:'card'`, a
 *  flex-fill scroll pane) and each aggregate row (`variant:'row'`, a bounded scroll block). */
function SubagentBody({
  id,
  result,
  working,
  variant,
  header
}: {
  id: string
  result?: string
  working: boolean
  variant: 'card' | 'row'
  header?: ReactNode
}) {
  const activity = useAgentNodes((s) => s.activityById[id]) || ''
  const body = activity || result || ''
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [body])
  const cls = variant === 'card' ? 'subagent-node__term' : 'subagent-node__term subagent-node__term--row'
  return (
    <div className={`${cls} nodrag nowheel`} ref={ref}>
      {header}
      {body ? (
        parseActivitySegments(body).map((seg, i) =>
          seg.kind === 'prose' ? (
            <ProseBlock key={i} text={seg.text} />
          ) : seg.kind === 'thinking' ? (
            <div key={i} className="subagent-node__think">
              ✻ {seg.text}
            </div>
          ) : (
            <div key={i} className="subagent-node__tool">
              {seg.text}
            </div>
          )
        )
      ) : working ? (
        'Working… (live output appears here)'
      ) : (
        'No output.'
      )}
    </div>
  )
}

/**
 * Subagent node — a first-class canvas node (select/drag/resize) visualizing a subagent the
 * Claude session spawned. Shows type + task + live timer / duration-tokens; expand to read
 * its live transcript in a terminal-styled panel (subagents have no PTY). When a parent spawns
 * MORE THAN `FANOUT_COMPACT_THRESHOLD` live cards, Canvas renders ONE aggregate card instead
 * (`data.aggregate`) — see `AggregateNode` below.
 */
export function SubagentNode(props: NodeProps<CanvasNode>) {
  return props.data.aggregate ? <AggregateNode {...props} /> : <SingleSubagentNode {...props} />
}

function SingleSubagentNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const working = data.subagentState !== 'done'
  const startedAt = (data.subagentStartedAt as number) || 0
  const durationMs = data.subagentDurationMs as number | undefined
  const tokens = data.subagentTokens as number | undefined
  const toolUses = data.subagentToolUses as number | undefined
  const result = (data.subagentResult as string) || ''
  const expanded = !!data.ephExpanded
  const toggle = () => useAgentNodes.getState().toggleExpanded(id)

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!working) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [working])

  const elapsed = working && startedAt ? fmtDur(now - startedAt) : durationMs ? fmtDur(durationMs) : ''
  const meta = [
    elapsed,
    tokens != null ? `↓ ${fmtTokens(tokens)} tokens` : null,
    toolUses ? `${toolUses} tool${toolUses === 1 ? '' : 's'}` : null
  ]
    .filter(Boolean)
    .join(' · ')

  // The cards are `selectable: false` in React Flow (a rubber band must not sweep a fan-out
  // into the selection), so selecting one — which is what reveals its resize frame — is ours.
  const select = () => useAgentNodes.getState().select(id)

  return (
    <div onPointerDownCapture={select} className={`subagent-node${working ? ' working' : ' done'}`}>
      <NodeResizer isVisible={selected} minWidth={NODE_MIN_SIZES.subagent.width} minHeight={NODE_MIN_SIZES.subagent.height} color="#d97757" />
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="subagent-node__head nodrag" onClick={toggle} style={{ cursor: 'pointer' }}>
        <button
          className="subagent-node__expand"
          title={expanded ? 'Collapse' : 'Open output'}
          onClick={(e) => {
            e.stopPropagation()
            toggle()
          }}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <span className="subagent-node__dot" />
        <span className="subagent-node__type">{(data.subagentType as string) || 'subagent'}</span>
        <span className="subagent-node__state">{working ? 'working' : 'done'}</span>
      </div>
      {data.title && !expanded && <div className="subagent-node__task">{data.title as string}</div>}
      {meta && <div className="subagent-node__meta">{meta}</div>}
      {expanded && (
        <SubagentBody
          id={id}
          result={result}
          working={working}
          variant="card"
          header={data.title ? <div className="subagent-node__result-task">{data.title as string}</div> : null}
        />
      )}
    </div>
  )
}

/** One row in the aggregate's expanded list: a compact summary that toggles the child's own live
 *  transcript inline (no capability lost — the same body the standalone card renders). */
function AggregateRow({ child }: { child: FanoutChild }) {
  const [open, setOpen] = useState(false)
  const working = child.state === 'working'
  const dur = child.durationMs != null ? fmtDur(child.durationMs) : ''
  return (
    <div className={`subagent-row${working ? ' working' : ' done'}`}>
      <div className="subagent-row__head" onClick={() => setOpen((o) => !o)}>
        <span className="subagent-node__expand">{open ? '▾' : '▸'}</span>
        <span className="subagent-node__dot" />
        <span className="subagent-node__type">{child.type || 'subagent'}</span>
        {child.label ? <span className="subagent-row__task">{child.label}</span> : null}
        <span className="subagent-node__state">{dur || (working ? 'working' : 'done')}</span>
      </div>
      {open && <SubagentBody id={child.id} result={child.result} working={working} variant="row" />}
    </div>
  )
}

/**
 * Aggregate fan-out card — one card standing in for a parent's whole large fan-out (see
 * FANOUT_COMPACT_THRESHOLD). Collapsed: total + working/done/errored + elapsed. Expanded: a
 * scrollable list of the individual cards, each still openable to its live transcript. It is as
 * ephemeral as the cards it replaces — never persisted, never in undo, cleared on the same events.
 */
function AggregateNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const children = (data.children as FanoutChild[] | undefined) ?? []
  const counts = fanoutCounts(children)
  const working = counts.working > 0
  const expanded = !!data.ephExpanded
  const toggle = () => useAgentNodes.getState().toggleExpanded(id)
  const select = () => useAgentNodes.getState().select(id)

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!working) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [working])

  const elapsed = fmtDur(fanoutElapsed(children, now))
  const meta = [
    counts.working ? `${counts.working} working` : null,
    counts.done ? `${counts.done} done` : null,
    counts.errored ? `${counts.errored} errored` : null,
    elapsed
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div onPointerDownCapture={select} className={`subagent-node subagent-node--group${working ? ' working' : ' done'}`}>
      <NodeResizer isVisible={selected} minWidth={NODE_MIN_SIZES.subagent.width} minHeight={NODE_MIN_SIZES.subagent.height} color="#d97757" />
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="subagent-node__head nodrag" onClick={toggle} style={{ cursor: 'pointer' }}>
        <button
          className="subagent-node__expand"
          title={expanded ? 'Collapse' : 'Open agents'}
          onClick={(e) => {
            e.stopPropagation()
            toggle()
          }}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <span className="subagent-node__dot" />
        <span className="subagent-node__type">{counts.total} agents</span>
        <span className="subagent-node__state">{working ? 'working' : 'done'}</span>
      </div>
      {meta && <div className="subagent-node__meta">{meta}</div>}
      {expanded && (
        <div className="subagent-node__list nodrag nowheel">
          {children.map((c) => (
            <AggregateRow key={c.id} child={c} />
          ))}
        </div>
      )}
    </div>
  )
}
