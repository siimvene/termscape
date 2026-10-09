// Polls the backend /v1/check feed from the main process (so the renderer CSP stays 'self').
// Successor to the static announcements.json: returns targeted messages for the announcement
// banner AND the mandatory-update policy for the Update Card. It also carries the anonymous
// install id (deviceId + os/arch/version), which the backend upserts into `devices` as a
// passive active-install counter — so the version distribution reflects EVERY install, not only
// the (few) that also opt into the telemetry ping. Nothing personal is sent and the client IP is
// never stored server-side; a hard opt-out is still DO_NOT_TRACK / NODETERM_TELEMETRY_DISABLED.
import { platform } from './platform'
import { getDeviceId } from './device-id'
import type { Announcement, UpdatePolicy } from '../shared/types'

const API_BASE = process.env.NODETERM_API_BASE || 'https://api.nodeterm.dev'
const CACHE_MS = 5 * 60 * 1000

export interface CheckResult {
  messages: Announcement[]
  update: UpdatePolicy
}

const EMPTY: CheckResult = { messages: [], update: { minSupported: null, mandatory: false } }

// Same build + DO_NOT_TRACK gate as telemetry: dev never hits the prod API unless a local
// server is targeted explicitly. Deliberately NOT gated on the in-app telemetry toggle: this
// call always runs (content delivery + the anonymous install count), so an install still counts
// even if the user never opts into the detailed telemetry ping. The env kill-switches above are
// the hard off.
//
// TERMSCAPE FORK: never. The feed belongs to upstream's backend and judges UPSTREAM's version line,
// so for this fork it can only misfire: on 2026-10-09 it answered `{minSupported:'0.4.2',
// mandatory:true}` to v0.3.16-selfhost.3 and pinned a non-dismissible "Update required" card that
// the fork's own updater could never clear. Its banners are upstream's announcements, and the call
// also counts the install in upstream's `devices` table. Kept as a dead switch (not deleted) so an
// upstream merge touches one function body; `no-upstream-feed.guard.test.ts` pins it.
function allowed(): boolean {
  return false
}

function sanitize(data: unknown): CheckResult {
  if (!data || typeof data !== 'object') return EMPTY
  const d = data as Record<string, unknown>
  const rawMessages = Array.isArray(d.messages) ? d.messages : []
  const messages: Announcement[] = rawMessages
    .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
    .filter((m) => typeof m.id === 'string' && typeof m.title === 'string')
    .map((m) => ({
      id: m.id as string,
      title: m.title as string,
      body: typeof m.body === 'string' ? m.body : undefined,
      url: typeof m.url === 'string' && /^https?:\/\//.test(m.url) ? m.url : undefined,
      level: m.level === 'success' || m.level === 'warning' ? m.level : 'info'
    }))
  const u = (d.update ?? {}) as Record<string, unknown>
  const update: UpdatePolicy = {
    minSupported: typeof u.minSupported === 'string' ? u.minSupported : null,
    mandatory: u.mandatory === true
  }
  return { messages, update }
}

let cache: { at: number; data: CheckResult } | null = null

export async function fetchCheck(): Promise<CheckResult> {
  if (!allowed()) return EMPTY
  const now = Date.now()
  if (cache && now - cache.at < CACHE_MS) return cache.data
  try {
    const q = new URLSearchParams({
      deviceId: getDeviceId(),
      version: platform().appVersion,
      os: process.platform,
      arch: process.arch,
      channel: 'stable'
    })
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(`${API_BASE}/v1/check?${q.toString()}`, {
      signal: ctrl.signal,
      cache: 'no-cache'
    }).finally(() => clearTimeout(t))
    if (!res.ok) return cache?.data ?? EMPTY
    const data = sanitize(await res.json())
    cache = { at: now, data }
    return data
  } catch {
    return cache?.data ?? EMPTY
  }
}
