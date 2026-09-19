/**
 * The builtin agents that can own a MANAGED ACCOUNT — the one list behind both the binding rule
 * below and the add menus' decision about which agent rows stay out of the `New agent` submenu
 * (`renderer/lib/addMenuSpec`). Those two facts really are the same fact: an agent that can grow
 * an account picker is an agent whose row can become a SUBMENU, and `ContextMenu` renders a
 * submenu inside a submenu as NOTHING — so nesting such a row silently deletes its account picker
 * for exactly the users who have accounts. Written once here so a third agent gaining managed
 * accounts cannot light up one of the two and not the other.
 */
export const ACCOUNT_CAPABLE_AGENT_IDS: readonly string[] = ['claude', 'codex']

/**
 * Which managed account a node is actually BOUND to — the one rule behind both `data.accountId`
 * and the account's default node color.
 *
 * Managed accounts belong to the builtin **Claude and Codex** agents (S6). The id becomes a config
 * home path segment (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) and scopes every account-aware reader
 * (transcript, context meter, find-bar index, usage), none of which mean anything for another
 * agent. A custom agent inheriting one of those harnesses is still its own agent, so it does not
 * bind either — account binding stays with the builtin the account picker offered it for.
 *
 * **An UNSTATED agent keeps its binding.** The phone chooses `agentId` and `accountId`
 * independently over the relay (`projects.registerNode`), and whether it always sends the first
 * alongside the second is an open question — `docs/ios-protocol-migration.md` §6 lists exactly
 * that as unconfirmed. The two failure directions are not symmetric: dropping a real binding
 * resurrects the wrong-identity bug the field was added to fix (an off-LAN session under account X
 * comes back as the system account, every scoped reader resolves against the wrong root, and a
 * cold restore resumes it as the wrong identity), while keeping a stray binding on an agent-less
 * node only sets a config-home variable that nothing reads. So the gate refuses a KNOWN other
 * agent, not an unknown one. A non-string `agentId` reads as "no agent stated", the same way the
 * `agentConfig` lookup beside it has always treated one.
 *
 * On the canvas `agentId` is always stated (`createAgentNode` takes it as a required argument), so
 * that path is bit-for-bit what it was.
 */
export function boundAccountId(
  accountId: string | undefined,
  agentId: string | undefined
): string | undefined {
  if (!accountId) return undefined
  if (agentId !== undefined && !ACCOUNT_CAPABLE_AGENT_IDS.includes(agentId)) return undefined
  return accountId
}
