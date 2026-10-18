// Installs the outbound canvas-control CLI (nodeterm.sh) under userData. A self-contained POSIX-sh
// CLI POSTs to the hook server's /control/* routes; it no-ops unless NODETERM_CANVAS_CONTROL is set.
//
// Discovery (the manage-nodeterm-canvas skill in each agent's skills dir) is NOT written here: it is
// the consent lifecycle's (`core/agent-integrations.ts`, issue #744), the one place that decides what
// nodeterm may write into user-owned agent configuration.
//
// The SSH counterpart is RemoteHooks.installCanvasControl. Both use the same machine-neutral body,
// but the LOCAL shim prepends the shared-Codex thread resolver with this machine's ownership-record
// path; a desktop path must never be baked into the remote copy.
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { buildCanvasSkillBody, buildControlShimScript } from '../core/canvas-control-core'
import { codexThreadIdentityRoot } from '../core/codex-identity-proxy'
import { syncWindowsShLauncher, writeManagedHookFileAtomic } from '../core/agents/hooks/install-helper'
import { installPiCanvasSkillsInto } from '../core/agents/hooks/pi-skills'
import { shimDialectFor } from '@shared/agents/shim-invocation'

function dir(): string {
  return path.join(app.getPath('userData'), 'canvas-control')
}

/** The shim the canvas skill points at. */
export function canvasControlShimPath(): string {
  return path.join(dir(), 'nodeterm.sh')
}

function writeCliFiles(): void {
  const d = dir()
  fs.mkdirSync(d, { recursive: true })
  // Temp + rename, never a truncating write: agents execute this file, and a shim caught half
  // written is a canvas call that exits 0 having done nothing.
  writeManagedHookFileAtomic(canvasControlShimPath(), buildControlShimScript(codexThreadIdentityRoot()), undefined, 0o755)
  // Windows: `nodeterm.cmd` beside it, which PowerShell-run agents are told to call (it runs this
  // same script through Git for Windows' sh.exe). Elsewhere a stray copy is removed.
  syncWindowsShLauncher(d, 'nodeterm.sh')
  // Sweep the retired Electron-as-Node CLI off upgraders' disks — the shim no longer execs it,
  // so it would sit there forever pointing at a binary path that moves with every app update.
  try {
    fs.rmSync(path.join(d, 'canvas-control-cli.mjs'), { force: true })
  } catch {
    /* fail open */
  }
}

/**
 * Fork (Termscape): the per-account pi leg. A managed pi account is its own agent dir
 * (`PI_CODING_AGENT_DIR`) and pi discovers skills only from `<agentDir>/skills`, so each account needs
 * its own copy. The consent lifecycle owns the SYSTEM dir (`skillRootsFor('pi')`); the shells'
 * per-account loop calls this only while pi's integration is enabled. Same builder and dialect the
 * lifecycle uses (`skillsFor`), so an account can never carry different verbs from the system dir.
 */
export function installPiCanvasSkillInto(agentDir: string): void {
  installPiCanvasSkillsInto(agentDir, buildCanvasSkillBody(canvasControlShimPath(), shimDialectFor('pi', process.platform)))
}

export function initCanvasControl(): void {
  try {
    writeCliFiles()
  } catch (e) {
    console.error('[canvas-control] setup failed', e)
  }
}
