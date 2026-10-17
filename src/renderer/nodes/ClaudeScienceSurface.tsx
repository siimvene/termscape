import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClaudeScienceStatus } from '@shared/claude-science'
import { SCIENCE_BASE_PATH } from '@shared/claude-science'
import { isBrowserRuntime } from '../bridge/runtime'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { useSettings } from '../state/settings'
import { Button } from '../ui/Button'

/** Shared by the canvas and board modal. Credentials live only in this mounted view. */
export function ClaudeScienceSurface() {
  const [src, setSrc] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<ClaudeScienceStatus>()
  const [logs, setLogs] = useState<string>()
  const [confirmStop, setConfirmStop] = useState(false)
  const alive = useRef(true)
  const generation = useRef(0)
  const browser = isBrowserRuntime()
  const enabled = useSettings((s) => s.settings.claudeScienceEnabled)
  const open = useCallback(async () => {
    const request = ++generation.current
    const current = () => alive.current && request === generation.current
    if (!enabled) { setSrc(''); setBusy(false); setError(''); return }
    setBusy(true)
    setError('')
    setSrc('')
    try {
      await useSettings.getState().flush()
      if (!current()) return
      const url = await window.nodeTerminal.science.open()
      // The remote bridge must never navigate the viewer's localhost or an arbitrary website.
      if (browser && !url.startsWith(`${SCIENCE_BASE_PATH}/?nonce=`)) throw new Error('Science returned an unexpected URL.')
      const next = await window.nodeTerminal.science.status()
      if (current()) {
        setSrc(url)
        setStatus(next)
      }
    } catch (e) {
      if (current()) setError(e instanceof Error ? e.message : 'Could not open Claude Science.')
    } finally { if (current()) setBusy(false) }
  }, [browser, enabled])

  useEffect(() => {
    alive.current = true
    void open()
    const timer = setInterval(() => {
      void window.nodeTerminal.science.status().then((next) => {
        if (!alive.current) return
        setStatus(next)
        if (!next.running || next.enabled === false) setSrc('')
      }).catch(() => { /* The bridge owns the reconnect overlay. Keep the current view intact. */ })
    }, 15_000)
    return () => { alive.current = false; generation.current++; clearInterval(timer) }
  }, [open])

  const stop = async () => {
    setConfirmStop(false)
    setBusy(true)
    try {
      await window.nodeTerminal.science.stop()
      if (alive.current) { setSrc(''); setStatus(await window.nodeTerminal.science.status()) }
    } catch (e) { if (alive.current) setError((e as Error).message) }
    finally { if (alive.current) setBusy(false) }
  }

  const openTab = async () => {
    const tab = browser ? window.open('about:blank', '_blank') : null
    if (tab) tab.opener = null
    try {
      const url = await window.nodeTerminal.science.open()
      if (tab) tab.location.replace(url)
      else window.nodeTerminal.shell.openExternal(url)
    } catch (e) { tab?.close(); if (alive.current) setError((e as Error).message) }
  }

  return (
    <div className="science-surface nodrag nowheel">
      <div className="science-toolbar">
        <span role="status">{busy ? 'Connecting…' : status?.running ? `Science ${status.version ?? ''}` : 'Science stopped'}</span>
        <Button disabled={busy || !enabled} onClick={() => void open()}>Reconnect</Button>
        <Button disabled={busy || !src} onClick={() => void openTab()}>Open separately</Button>
        <Button disabled={busy} onClick={() => {
          if (logs !== undefined) { setLogs(undefined); return }
          void window.nodeTerminal.science.logs().then((value) => { if (alive.current) setLogs(value) })
            .catch((e) => { if (alive.current) setError(e.message) })
        }}>Logs</Button>
        <Button disabled={busy || !status?.running} onClick={() => setConfirmStop(true)}>Stop Science</Button>
      </div>
      {error && <div className="science-message" role="alert">{error}</div>}
      {browser && status?.running && !status.previewConfigured && (
        <div className="science-message">Remote interactive previews need a separate HTTPS preview endpoint. See the <a href="https://github.com/siimvene/nodeterm#claude-science" target="_blank" rel="noreferrer">Claude Science setup guide</a>.</div>
      )}
      {logs !== undefined && <pre className="science-logs">{logs || 'No logs yet.'}</pre>}
      {!enabled ? <div className="science-empty">
        <p>Allow Termscape to start Claude Science and display its interface here. You can revoke this in Settings → Agents.</p>
        <Button variant="primary" onClick={() => useSettings.getState().update({ claudeScienceEnabled: true })}>Allow Claude Science panels</Button>
      </div> : src ? browser ? (
        <iframe title="Claude Science" src={src} referrerPolicy="no-referrer" allow="clipboard-read; clipboard-write" />
      ) : (
        // A desktop webview is a top-level guest, so Science's native frame policy remains intact.
        <webview src={src} allowpopups={true} />
      ) : <div className="science-empty">{busy ? 'Starting Claude Science…' : 'Reconnect to open Claude Science. Sign in with your Claude account when prompted.'}</div>}
      {confirmStop && <ConfirmDialog
        message="Stop Claude Science? This stops analyses in every Science node on this host. Your saved work is kept."
        confirmLabel="Stop Science"
        onConfirm={() => void stop()}
        onCancel={() => setConfirmStop(false)}
      />}
    </div>
  )
}
