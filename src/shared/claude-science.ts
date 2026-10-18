/** Science is a managed browser application, not a Claude Code terminal agent. */
export const SCIENCE_BASE_PATH = '/apps/claude-science'

export interface ClaudeScienceStatus {
  installed: boolean
  enabled?: boolean
  running: boolean
  version?: string
  port?: number
  sandboxActive?: boolean
  previewConfigured: boolean
  installable?: boolean
  installing?: boolean
  installUnavailableReason?: string
  error?: string
}

export interface ClaudeScienceApi {
  status(): Promise<ClaudeScienceStatus>
  /** Explicitly downloads and verifies the official runtime for this Termscape user. */
  install(): Promise<void>
  /** Starts/reuses this host's instance and mints a fresh, single-use login URL. Never persist it. */
  open(): Promise<string>
  /** Explicitly stops the shared instance, including work in other Science nodes. */
  stop(): Promise<void>
  logs(): Promise<string>
}
