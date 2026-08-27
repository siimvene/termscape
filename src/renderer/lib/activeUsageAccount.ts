// Which Claude account the usage pill should LEAD with for the project at hand.
//
// The pill was system-account-first from before the account SWITCHER existed; once nodes rotate
// between identities per-session, "system" is just one account among several and the numbers that
// matter are the ones the project's sessions actually spend. The rule, in priority order:
//   1. the account of the project's most recently ACTIVE agent session (largest transient
//      `lastEventAt` from the agentStatus store — the session the user is actually driving);
//   2. else the project's default account (`defaultAccountId`, what a NEW node would get);
//   3. else the system `~/.claude` (undefined).
// Ties and absent clocks fall through in order, so a freshly-restarted app (no transient clocks)
// leads with the project default — deterministic, never a random node's account.
//
// Pure: takes plain snapshots, returns an account id (undefined = system). The caller subscribes
// with THIS function as a selector-derived primitive so hook-event churn only re-renders the pill
// when the ANSWER changes (the loopSig discipline from CLAUDE.md).

export interface ActiveAccountNode {
  id: string
  /** The node's stamped account (undefined = system). */
  accountId?: string
  /** Whether this node runs an agent CLI — plain terminals never spend Claude quota. */
  isAgent: boolean
}

export interface ActiveAccountStatusEntry {
  lastEventAt?: number
}

export function activeUsageAccountId(
  nodes: readonly ActiveAccountNode[],
  statusById: Readonly<Record<string, ActiveAccountStatusEntry>>,
  projectDefaultAccountId: string | undefined
): string | undefined {
  let best: { at: number; accountId: string | undefined } | null = null
  for (const n of nodes) {
    if (!n.isAgent) continue
    const at = statusById[n.id]?.lastEventAt
    if (typeof at !== 'number') continue
    if (!best || at > best.at) best = { at, accountId: n.accountId || undefined }
  }
  if (best) return best.accountId
  return projectDefaultAccountId || undefined
}
