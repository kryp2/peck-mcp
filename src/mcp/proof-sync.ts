/**
 * Keep the agent wallet's merkle proofs current.
 *
 * wallet-toolbox records a proof for a transaction only when its Monitor runs
 * the CheckForProofs task, and bitcoin-agent-wallet never starts the Monitor.
 * Without proofs every write spends change from unproven parents, so the BEEF
 * for the next write carries one more ancestor level per chained post. At depth
 * 12 createAction fails with "Maximum BEEF depth exceeded", and the wallet can
 * no longer write at all even though every ancestor is mined.
 *
 * Only CheckForProofs is run. The Monitor also has TaskSendWaiting registered,
 * which would broadcast queued delayed transactions (for example PeerPay
 * payments created with the default acceptDelayedBroadcast). Sending money must
 * stay an explicit decision, never a side effect of starting the MCP server.
 */

export const PROOF_TASK = 'CheckForProofs'

/** The slice of wallet-toolbox's Monitor that proof sync needs. */
export interface ProofSyncMonitor {
  runTask(name: string): Promise<string>
  lastNewHeader?: unknown
  services: { getHeight(): Promise<number> }
}

/**
 * The toolbox Monitor behind a BitcoinAgentWallet. bitcoin-agent-wallet keeps
 * its Setup private, so this reaches in at runtime (as it does itself for the
 * fee model). Returns null if the layout changed; callers then skip proof sync.
 */
export function monitorOf(wallet: unknown): ProofSyncMonitor | null {
  const m = (wallet as any)?.setup?.monitor
  if (m && typeof m.runTask === 'function' && typeof m.services?.getHeight === 'function') return m
  return null
}

/**
 * Ask the configured proof services for merkle paths of this wallet's mined but
 * unproven transactions and store the ones that verify against the header chain.
 * Makes no network calls beyond a chain-height lookup when nothing is pending.
 * Returns the task log.
 */
export async function syncProofs(monitor: ProofSyncMonitor): Promise<string> {
  // CheckForProofs does nothing without lastNewHeader and ignores proofs from
  // blocks above its height; the scheduler's TaskNewHeader normally sets it.
  const height = await monitor.services.getHeight()
  monitor.lastNewHeader = { height }
  return await monitor.runTask(PROOF_TASK)
}
