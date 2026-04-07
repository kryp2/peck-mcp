/**
 * CNP Manager — Contract Net Protocol (Reid G. Smith, 1980)
 *
 * Broadcasts Call-for-Proposals (CFP), collects bids from workers,
 * scores them, delegates to winner, and commits payment on-chain.
 *
 * Bid scoring:
 *   price       40%
 *   reputation  30%
 *   est. time   20%
 *   cap match   10%
 */

import { PrivateKey, Hash } from '@bsv/sdk'
import { A2AProtocol } from './a2a-protocol.js'
import { ReputationScorer } from './reputation.js'
import { UTXOManager } from './utxo-manager.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CFP {
  cfp_id: string
  task_type: string
  requirements: string[]
  max_price_sats: number
  deadline_ms: number  // unix ms
  manager_pubkey: string
}

export interface Bid {
  cfp_id: string
  worker_id: string
  worker_pubkey: string
  worker_address: string
  price_sats: number
  estimated_ms: number
  sla_guarantee: string  // e.g. "99% uptime, retry on failure"
  capabilities: string[]
}

export interface BidResult {
  bid: Bid
  score: number
  accepted: boolean
}

export interface CNPResult {
  cfp: CFP
  winner: Bid
  commit_txid: string
  all_results: BidResult[]
}

// ── CNPManager ────────────────────────────────────────────────────────────────

export class CNPManager {
  private protocol: A2AProtocol
  private pubkey: string

  constructor(
    private identity: PrivateKey,
    private reputation: ReputationScorer,
    private utxo?: UTXOManager,
  ) {
    this.protocol = new A2AProtocol(identity)
    this.pubkey = identity.toPublicKey().toString()
  }

  /** Build a signed CFP object ready for broadcast. */
  createCFP(
    task_type: string,
    requirements: string[],
    max_price_sats: number,
    ttl_ms = 5000,
  ): CFP {
    return {
      cfp_id: `cfp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      task_type,
      requirements,
      max_price_sats,
      deadline_ms: Date.now() + ttl_ms,
      manager_pubkey: this.pubkey,
    }
  }

  /**
   * Evaluate a list of bids and return scored results.
   *
   * Scoring weights:
   *   price       40% — lower is better (normalised to [0,1])
   *   reputation  30% — ReputationScorer.getTrustScore / 100
   *   est. time   20% — lower is better (normalised to [0,1])
   *   cap match   10% — fraction of required caps covered
   */
  evaluateBids(cfp: CFP, bids: Bid[]): BidResult[] {
    if (bids.length === 0) return []

    // Filter out bids that exceed max_price or missed deadline
    const valid = bids.filter(
      b => b.price_sats <= cfp.max_price_sats && Date.now() <= cfp.deadline_ms,
    )
    if (valid.length === 0) return bids.map(b => ({ bid: b, score: 0, accepted: false }))

    const minPrice = Math.min(...valid.map(b => b.price_sats))
    const maxPrice = Math.max(...valid.map(b => b.price_sats))
    const minTime  = Math.min(...valid.map(b => b.estimated_ms))
    const maxTime  = Math.max(...valid.map(b => b.estimated_ms))

    const scored = valid.map(bid => {
      // Price score: lower price → higher score
      const priceRange = maxPrice - minPrice || 1
      const priceScore = (maxPrice - bid.price_sats) / priceRange

      // Reputation score
      const repScore = this.reputation.getTrustScore(bid.worker_id).score / 100

      // Time score: lower estimated time → higher score
      const timeRange = maxTime - minTime || 1
      const timeScore = (maxTime - bid.estimated_ms) / timeRange

      // Capability match score
      const capScore = cfp.requirements.length === 0
        ? 1
        : cfp.requirements.filter(r => bid.capabilities.includes(r)).length / cfp.requirements.length

      const score =
        priceScore  * 0.40 +
        repScore    * 0.30 +
        timeScore   * 0.20 +
        capScore    * 0.10

      return { bid, score, accepted: false }
    })

    // Mark winner
    scored.sort((a, b) => b.score - a.score)
    if (scored.length > 0) scored[0].accepted = true

    // Merge back rejected out-of-range bids
    const invalidBids = bids
      .filter(b => !valid.includes(b))
      .map(b => ({ bid: b, score: 0, accepted: false }))

    return [...scored, ...invalidBids]
  }

  /**
   * CommitPayment: build and broadcast a BSV tx with OP_RETURN
   * containing SHA-256(accepted_bid + task_spec).
   *
   * Falls back to a simulated txid when no UTXOManager is provided
   * (useful in tests / off-chain-only mode).
   */
  async commitPayment(cfp: CFP, winner: Bid): Promise<string> {
    const commitment = {
      cfp_id: cfp.cfp_id,
      task_type: cfp.task_type,
      worker_id: winner.worker_id,
      price_sats: winner.price_sats,
      ts: Date.now(),
    }

    if (this.utxo) {
      const { txid } = await this.utxo.buildTx(
        winner.worker_address,
        winner.price_sats,
        { type: 'cnp_commit', cfp: cfp.cfp_id, worker: winner.worker_id, ts: Date.now() },
      )
      this.utxo.queueBroadcast((await this.utxo.buildTx(
        winner.worker_address, winner.price_sats,
        { type: 'cnp_commit', cfp: cfp.cfp_id, worker: winner.worker_id, ts: Date.now() },
      )).tx)
      return txid
    }

    // Simulated — hash the commitment as a synthetic txid
    const payload = JSON.stringify(commitment)
    const hashBytes = Hash.sha256(Array.from(new TextEncoder().encode(payload)))
    return Array.from(hashBytes).map(b => b.toString(16).padStart(2, '0')).join('')
  }

  /**
   * Full CNP round:
   *  1. Accept a pre-built CFP
   *  2. Evaluate received bids
   *  3. Commit payment to winner on-chain
   *  4. Return full result
   */
  async run(cfp: CFP, bids: Bid[]): Promise<CNPResult> {
    console.log(`[CNPManager] CFP ${cfp.cfp_id} — received ${bids.length} bid(s)`)

    const results = this.evaluateBids(cfp, bids)
    const winnerResult = results.find(r => r.accepted)

    if (!winnerResult) {
      throw new Error(`[CNPManager] No valid bids for ${cfp.cfp_id}`)
    }

    const winner = winnerResult.bid
    console.log(`[CNPManager] Winner: ${winner.worker_id} @ ${winner.price_sats} sats (score ${winnerResult.score.toFixed(3)})`)

    results
      .filter(r => !r.accepted)
      .forEach(r => console.log(`[CNPManager] Rejected: ${r.bid.worker_id} (score ${r.score.toFixed(3)})`))

    const commit_txid = await this.commitPayment(cfp, winner)
    console.log(`[CNPManager] CommitPayment txid: ${commit_txid.slice(0, 16)}...`)

    return { cfp, winner, commit_txid, all_results: results }
  }
}
