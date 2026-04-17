/**
 * Reputation — derived from Like-ratio on function responses.
 *
 * Wright §5.4 implemented with ONLY Bitcoin Schema primitives:
 *   - Function Call tx (MAP type=function) = request
 *   - Reply tx (MAP type=post context=tx) = response
 *   - Like tx (MAP type=like tx=<response>) = positive signal
 *   - No Like after response = neutral/negative signal
 *
 * Reputation = likes / total_responses
 *
 * That's it. No custom audit protocol. No downvotes.
 * The on-chain history IS the audit trail. Likes ARE the votes.
 * Anyone can verify by reading the chain.
 *
 * Escrow forfeiture triggers when reputation drops below threshold
 * and someone posts on-chain proof (references to bad response txids).
 *
 * Reference: Wright 2025, §5.4 — but simpler than the paper,
 * because Bitcoin Schema already has the primitives.
 */
import { BankLocal } from '../clients/bank-local.js'

// ============================================================================
// Types
// ============================================================================

export interface FunctionCallRecord {
  call_txid: string
  response_txid: string | null
  caller: string          // pubkey
  provider: string        // pubkey
  function_name: string
  liked: boolean          // was the response liked by the caller?
  timestamp: number
}

export interface ReputationScore {
  provider: string
  total_responses: number
  likes: number
  ratio: number           // likes / total_responses (0-1)
  reputation: number      // smoothed score (0-1)
  escrow_sat: number
  status: 'good' | 'warning' | 'slashable'
}

// ============================================================================
// Thresholds
// ============================================================================

const WARNING_THRESHOLD = 0.70
const SLASH_THRESHOLD = 0.50
const DEFAULT_REPUTATION = 0.95  // new agents before any calls
const MIN_CALLS_FOR_SCORING = 3  // need at least 3 responses before scoring

// ============================================================================
// Reputation Engine
// ============================================================================

export class ReputationEngine {
  readonly bank: BankLocal
  private prefix: string

  constructor(bank?: BankLocal, prefix = 'rep:') {
    this.bank = bank ?? new BankLocal()
    this.prefix = prefix
  }

  /**
   * Record a function call + response pair.
   * Called after a function execution completes.
   */
  async recordCall(record: FunctionCallRecord): Promise<void> {
    // Store individual call record
    const callKey = `${this.prefix}call:${record.call_txid}`
    await this.bank.statePut(callKey, record)

    // Update provider's call list
    const providerKey = `${this.prefix}provider:${record.provider}`
    const calls = (await this.bank.stateGet<string[]>(providerKey)) ?? []
    calls.push(record.call_txid)
    await this.bank.statePut(providerKey, calls)
  }

  /**
   * Record a Like on a function response.
   * This is the ONLY reputation signal. Standard Bitcoin Schema Like.
   */
  async recordLike(responseTxid: string, likerPubkey: string): Promise<void> {
    // Find which call this response belongs to
    const responseKey = `${this.prefix}resp-to-call:${responseTxid}`
    const callTxid = await this.bank.stateGet<string>(responseKey)
    if (!callTxid) return

    // Mark the call as liked
    const callKey = `${this.prefix}call:${callTxid}`
    const record = await this.bank.stateGet<FunctionCallRecord>(callKey)
    if (record) {
      record.liked = true
      await this.bank.statePut(callKey, record)
    }
  }

  /**
   * Link a response txid back to its call txid.
   * Called when function executor posts a response.
   */
  async linkResponse(callTxid: string, responseTxid: string): Promise<void> {
    const responseKey = `${this.prefix}resp-to-call:${responseTxid}`
    await this.bank.statePut(responseKey, callTxid)
  }

  /**
   * Get reputation for a provider. DERIVED from call history, never stored.
   */
  async getReputation(providerPubkey: string): Promise<ReputationScore> {
    const providerKey = `${this.prefix}provider:${providerPubkey}`
    const callTxids = (await this.bank.stateGet<string[]>(providerKey)) ?? []

    let totalResponses = 0
    let likes = 0

    for (const txid of callTxids) {
      const record = await this.bank.stateGet<FunctionCallRecord>(`${this.prefix}call:${txid}`)
      if (!record || !record.response_txid) continue
      totalResponses++
      if (record.liked) likes++
    }

    // Calculate ratio
    const ratio = totalResponses === 0 ? 0 : likes / totalResponses

    // Smoothed reputation: blend with default for low sample sizes
    let reputation: number
    if (totalResponses < MIN_CALLS_FOR_SCORING) {
      // Not enough data — use default with slight pull toward observed ratio
      const weight = totalResponses / MIN_CALLS_FOR_SCORING
      reputation = DEFAULT_REPUTATION * (1 - weight) + ratio * weight
    } else {
      reputation = ratio
    }

    // Get escrow
    const escrowKey = `${this.prefix}escrow:${providerPubkey}`
    const escrowSat = (await this.bank.stateGet<number>(escrowKey)) ?? 0

    // Status
    let status: 'good' | 'warning' | 'slashable' = 'good'
    if (totalResponses >= MIN_CALLS_FOR_SCORING) {
      if (reputation < SLASH_THRESHOLD) status = 'slashable'
      else if (reputation < WARNING_THRESHOLD) status = 'warning'
    }

    return {
      provider: providerPubkey,
      total_responses: totalResponses,
      likes,
      ratio: Math.round(ratio * 10000) / 10000,
      reputation: Math.round(reputation * 10000) / 10000,
      escrow_sat: escrowSat,
      status,
    }
  }

  /**
   * Record escrow deposit for a provider.
   */
  async recordEscrow(providerPubkey: string, amountSat: number): Promise<void> {
    const escrowKey = `${this.prefix}escrow:${providerPubkey}`
    const current = (await this.bank.stateGet<number>(escrowKey)) ?? 0
    await this.bank.statePut(escrowKey, current + amountSat)
  }

  /**
   * Filter services by reputation. Used for discovery.
   * Services below threshold are hidden — de facto punishment.
   */
  async filterByReputation<T extends { provider: string }>(
    services: T[],
    minReputation = 0.70,
  ): Promise<Array<T & { reputation: ReputationScore }>> {
    const results: Array<T & { reputation: ReputationScore }> = []
    for (const svc of services) {
      const rep = await this.getReputation(svc.provider)
      if (rep.reputation >= minReputation) {
        results.push({ ...svc, reputation: rep })
      }
    }
    return results.sort((a, b) => b.reputation.reputation - a.reputation.reputation)
  }
}
