import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error The field scanner intentionally runs as dependency-free native ESM.
import { auditSession, classifyProcesses, cleanScreen, extractModelArg, loadWorkspaceNodes, parseCliArgs, parsePaneList, parseProcessList, parseScreenContextWindow, reportLogLines, screenSignals } from '../../scripts/agent-session-scan.mjs'

describe('agent session scanner', () => {
  it('keeps the pane shell pid separate from the foreground agent pid', () => {
    const rows = parseProcessList(`
      79108 79108 Ss   -zsh -zsh
      79141 79141 S+   claude claude --resume session --model vllm/glm[1m]
      79407 79141 S+   uv uv run server.py
    `)
    expect(classifyProcesses(rows, 79108, 'claude')).toEqual({
      state: 'agent-running',
      shellPid: 79108,
      agentPid: 79141,
      foregroundPgid: 79141,
      foreground: [
        { pid: 79141, command: 'claude' },
        { pid: 79407, command: 'uv' }
      ]
    })
  })

  it('calls a live pane with only its root shell an exited agent', () => {
    const rows = parseProcessList('79108 79108 Ss+ -zsh -zsh')
    expect(classifyProcesses(rows, 79108, 'claude')).toMatchObject({
      state: 'shell-only',
      shellPid: 79108,
      agentPid: undefined
    })
  })

  it('does not mistake an unrelated command argument for the expected agent', () => {
    const rows = parseProcessList(`
      79108 79108 Ss   -zsh -zsh
      79141 79141 S+   rg rg claude README.md
    `)
    expect(classifyProcesses(rows, 79108, 'claude')).toMatchObject({
      state: 'unexpected-foreground',
      agentPid: undefined
    })
  })

  it('recognizes an agent launched through an interpreter wrapper', () => {
    const rows = parseProcessList(`
      79108 79108 Ss   -zsh -zsh
      79141 79141 S+   node node /opt/homebrew/bin/claude --resume session
    `)
    expect(classifyProcesses(rows, 79108, 'claude')).toMatchObject({
      state: 'agent-running',
      agentPid: 79141
    })
  })

  it('parses pane records without conflating the session id and node id', () => {
    const sep = '\u001f'
    expect(
      parsePaneList(`nt-term-1${sep}42${sep}/dev/ttys001${sep}zsh${sep}/repo\n`)
    ).toEqual([
      {
        session: 'nt-term-1',
        nodeId: 'term-1',
        shellPid: 42,
        tty: '/dev/ttys001',
        paneCommand: 'zsh',
        cwd: '/repo'
      }
    ])
  })

  it('extracts both long and short model flags from live argv', () => {
    expect(extractModelArg('claude --resume x --model vllm/glm[1m]')).toBe('vllm/glm[1m]')
    expect(extractModelArg('codex resume x -m gpt-5.6')).toBe('gpt-5.6')
    expect(extractModelArg('claude --model="model with spaces"')).toBe('model with spaces')
  })

  it('loads an inline project from its authoritative data file instead of the compatibility cache', () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-agent-scan-'))
    try {
      fs.mkdirSync(path.join(userDataDir, 'inline-projects'))
      fs.writeFileSync(
        path.join(userDataDir, 'workspace.json'),
        JSON.stringify({
          version: 3,
          entries: [{
            id: 'project-inline-1',
            name: 'Inline',
            dataFile: true,
            project: { nodes: [{ id: 'stale-node', agentId: 'claude' }] }
          }]
        })
      )
      fs.writeFileSync(
        path.join(userDataDir, 'inline-projects', 'project-inline-1.json'),
        JSON.stringify({
          version: 1,
          nodes: [{ id: 'fresh-node', agentId: 'codex', agentLaunchModel: 'gpt-5.6' }]
        })
      )

      const workspace = loadWorkspaceNodes(userDataDir)
      expect([...workspace.nodes.keys()]).toEqual(['fresh-node'])
      expect(workspace.nodes.get('fresh-node')).toMatchObject({
        agentId: 'codex',
        agentLaunchModel: 'gpt-5.6',
        source: path.join(userDataDir, 'inline-projects', 'project-inline-1.json')
      })
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  it('jails inline data-file ids and falls back to the compatibility cache', () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-agent-scan-'))
    try {
      fs.writeFileSync(
        path.join(userDataDir, 'workspace.json'),
        JSON.stringify({
          version: 3,
          entries: [{
            id: '../outside',
            name: 'Unsafe inline id',
            dataFile: true,
            project: { nodes: [{ id: 'cached-node', agentId: 'claude' }] }
          }]
        })
      )

      const workspace = loadWorkspaceNodes(userDataDir)
      expect([...workspace.nodes.keys()]).toEqual(['cached-node'])
      expect(workspace.nodes.get('cached-node')?.source).toBe(path.join(userDataDir, 'workspace.json'))
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  it('falls back to the compatibility cache when an authoritative inline data file is unreadable', () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-agent-scan-'))
    try {
      fs.writeFileSync(
        path.join(userDataDir, 'workspace.json'),
        JSON.stringify({
          version: 3,
          entries: [{
            id: 'project-inline-1',
            name: 'Inline fallback',
            dataFile: true,
            project: { nodes: [{ id: 'cached-node', agentId: 'claude' }] }
          }]
        })
      )

      const workspace = loadWorkspaceNodes(userDataDir)
      expect([...workspace.nodes.keys()]).toEqual(['cached-node'])
      expect(workspace.nodes.get('cached-node')?.source).toBe(path.join(userDataDir, 'workspace.json'))
      expect(workspace.errors[0]).toContain(
        path.join(userDataDir, 'inline-projects', 'project-inline-1.json')
      )
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  it('flags the shell-only and stale autocompact cases independently', () => {
    const audited = auditSession({
      pane: { nodeId: 'term-1' },
      node: {
        agentId: 'claude',
        agentLaunchModel: 'vllm/glm[1m]',
        agentLaunchContextWindow: 400_000
      },
      env: {
        NODETERM_NODE_ID: 'term-1',
        NODETERM_AGENT_ID: 'claude',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000'
      },
      process: { state: 'shell-only' },
      processModel: undefined
    })
    expect(audited.findings.map((finding: { code: string }) => finding.code)).toEqual([
      'agent-not-running',
      'context-window-mismatch'
    ])
  })

  it('does not invent a mismatch when process, env and launch record agree', () => {
    const audited = auditSession({
      pane: { nodeId: 'term-1' },
      node: {
        agentId: 'claude',
        agentLaunchModel: 'vllm/glm[1m]',
        agentLaunchContextWindow: 400_000
      },
      env: {
        NODETERM_NODE_ID: 'term-1',
        NODETERM_AGENT_ID: 'claude',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000'
      },
      process: { state: 'agent-running' },
      processModel: 'vllm/glm[1m]',
      screenWindow: 400_000
    })
    expect(audited.findings).toEqual([])
  })

  it('recognizes actionable TUI failures and strips terminal escapes', () => {
    const screen = cleanScreen('\u001b[31mNo conversation found for session abc\u001b[0m\n')
    expect(screen).toBe('No conversation found for session abc')
    expect(screenSignals(screen)).toContain('resume-error')
  })

  it('reads the latest visible TUI context denominator and audits it separately from the env', () => {
    const screen = 'Ctx 20k/400k 5%\nold\nCtx █░░ 88.0k/1.0M 9%'
    expect(parseScreenContextWindow(screen)).toBe(1_000_000)
    const audited = auditSession({
      pane: { nodeId: 'term-1' },
      node: { agentId: 'claude', agentLaunchContextWindow: 400_000 },
      env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' },
      process: { state: 'agent-running' },
      screenWindow: 1_000_000
    })
    expect(audited.findings.map((finding: { code: string }) => finding.code)).toEqual([
      'screen-context-window-mismatch'
    ])
  })

  it('rejects invalid numeric limits instead of silently falling back or watching forever', () => {
    expect(() => parseCliArgs(['--screen-lines', 'nope'])).toThrow(
      '--screen-lines must be a positive integer'
    )
    expect(() => parseCliArgs(['--count', '0'])).toThrow('--count must be a positive integer')
  })

  it('never puts captured screen or foreground argv text into durable log records', () => {
    const lines = reportLogLines({
      scannedAt: '2026-09-03T12:00:00.000Z',
      ok: true,
      socket: 'node-terminal',
      workspaceProjects: 1,
      workspaceAgents: 1,
      errors: [],
      sessions: [
        {
          nodeId: 'term-1',
          screen: 'private conversation text',
          foreground: [{ pid: 42, command: 'claude', args: '--secret private-argv' }],
          findings: []
        }
      ]
    })
    const durable = lines.join('\n')
    expect(durable).not.toContain('private conversation text')
    expect(durable).not.toContain('private-argv')
    expect(durable).toContain('"foregroundCount":1')
  })
})
