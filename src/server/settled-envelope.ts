/**
 * Server-only agent-message delivery sequencing.
 *
 * A fresh Claude composer can accept a bracketed paste asynchronously: tmux has written the close
 * marker, but an Enter queued in the same command list is consumed before the TUI has installed the
 * pasted block. The next key then submits both messages together. Paste first, observe the pane
 * render the unique envelope footer (or become stably different from its baseline), then submit in
 * a second write.
 *
 * The boolean deliberately means "the envelope reached the pane", not "Enter was observed". Once
 * the paste succeeds, a capture or submit failure returns true so the unchanged receipt watcher can
 * report `stalled`; returning false would misreport a partially delivered message as `targetGone`.
 */

export const ENVELOPE_SETTLE_POLL_MS = 40
export const ENVELOPE_SETTLE_POLLS = 15

export interface SettledEnvelopePty {
  captureSession(nodeId: string): Promise<string>
  sendText(nodeId: string, text: string, opts?: { enter?: boolean }): Promise<boolean>
}

export interface SettledEnvelopeOptions {
  wait?: (ms: number) => Promise<void>
  polls?: number
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function visibleSnapshot(value: string): string {
  return value.replace(/\r/g, '').replace(/[ \t]+$/gm, '').trimEnd()
}

function compact(value: string): string {
  return value.replace(/\s+/g, '')
}

async function capture(pty: SettledEnvelopePty, nodeId: string): Promise<string | null> {
  try {
    return visibleSnapshot(await pty.captureSession(nodeId))
  } catch {
    return null
  }
}

/** Paste one complete envelope and submit only after the target pane has visibly settled. */
export async function sendSettledEnvelope(
  pty: SettledEnvelopePty,
  nodeId: string,
  envelope: string,
  options: SettledEnvelopeOptions = {}
): Promise<boolean> {
  if (!envelope) return false
  const before = await capture(pty, nodeId)
  let pasted = false
  try {
    pasted = await pty.sendText(nodeId, envelope, { enter: false })
  } catch {
    return false
  }
  if (!pasted) return false

  const footer = compact(envelope.split('\n').at(-1) ?? '')
  const wait = options.wait ?? delay
  const polls = Math.max(1, options.polls ?? ENVELOPE_SETTLE_POLLS)
  let priorChanged: string | null = null
  let settled = false

  for (let i = 0; i < polls; i++) {
    if (i > 0) await wait(ENVELOPE_SETTLE_POLL_MS)
    const current = await capture(pty, nodeId)
    if (current === null) continue
    if (footer && compact(current).includes(footer)) {
      settled = true
      break
    }
    if (current && current !== before) {
      if (current === priorChanged) {
        settled = true
        break
      }
      priorChanged = current
    } else {
      priorChanged = null
    }
  }

  if (!settled) return true
  try {
    // False here is intentionally still a successful paste. No receipt follows, so shared
    // agent-messaging reports the existing non-retryable `stalled` outcome after its deadline.
    await pty.sendText(nodeId, '', { enter: true })
  } catch {
    // Same partial-delivery contract as a false return from the bare Enter.
  }
  return true
}
