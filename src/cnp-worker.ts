/**
 * CNP Worker — Contract Net Protocol worker agent.
 *
 * Evaluates incoming CFPs against own capacity/load,
 * computes a dynamic bid price, and submits a signed Bid.
 *
 * Dynamic pricing factors:
 *   - Current queue length (more work → higher price)
 *   - Historical average response time
 *   - Resource cost estimate (LLM tokens, compute)
 */

import { PrivateKey } from '@bsv/sdk'
import { A2AProtocol } from './a2a-protocol.js'
import { ReputationScorer } from './reputation.js'
import type { CFP, Bid } from './cnp-manager.js'

// ── WorkerConfig ──────────────────────────────────────────────────────────────

export interface WorkerConfig {
  id: string
  capabilities: string[]
  base_price_sats: number      // minimum price floor
  max_concurrent_tasks: number // capacity ceiling
  base_response_ms: number     // baseline processing time
  cost_per_token_sats?: number // LLM token cost
}

// ── CNPWorker ─────────────────────────────────────────────────────────────────

export class CNPWorker {
  private protocol: A2AProtocol
  private pubkey: string
  private address: string

  private queue: string[] = []               // active task IDs
  private response_times: number[] = []      // rolling history
  private total_tasks = 0
  private total_tokens_used = 0

  constructor(
    private identity: PrivateKey,
    private config: WorkerConfig,
    private reputation?: ReputationScorer,
    network: 'test' | 'main' = 'test',
  ) {
    this.protocol = new A2AProtocol(identity)
    this.pubkey = identity.toPublicKey().toString()
    this.address = identity.toAddress(network === 'test' ? 'testnet' : 'mainnet')
  }

  // ── Capacity ──────────────────────────────────────────────────────────────

  get queueLength(): number { return this.queue.length }

  get avgResponseMs(): number {
    if (this.response_times.length === 0) return this.config.base_response_ms
    const sum = this.response_times.reduce((a, b) => a + b, 0)
    return sum / this.response_times.length
  }

  get loadFactor(): number {
    return this.queue.length / Math.max(1, this.config.max_concurrent_tasks)
  }

  /** True when worker has remaining capacity. */
  canAccept(): boolean {
    return this.queue.length < this.config.max_concurrent_tasks
  }

  // ── Bid pricing ───────────────────────────────────────────────────────────

  /**
   * Compute dynamic bid price.
   *
   * price = base_price
   *       × (1 + load_factor)          — busier → more expensive
   *       × (1 + response_penalty)     — slow history → higher price
   *       + token_cost_estimate        — LLM cost pass-through
   */
  computePrice(estimatedTokens = 0): number {
    const responsePenalty = Math.max(0, (this.avgResponseMs - 500) / 5000)

    let price = this.config.base_price_sats
      * (1 + this.loadFactor)
      * (1 + responsePenalty)

    if (this.config.cost_per_token_sats && estimatedTokens > 0) {
      price += this.config.cost_per_token_sats * estimatedTokens
    }

    return Math.ceil(price)
  }

  /**
   * Compute estimated processing time in ms.
   * Base time × load factor (parallel degrades latency).
   */
  computeEstimatedMs(): number {
    return Math.ceil(this.avgResponseMs * (1 + this.loadFactor * 0.5))
  }

  // ── CFP handling ──────────────────────────────────────────────────────────

  /**
   * Evaluate a CFP and return a Bid if worker can and wants to participate,
   * or null if the task is outside capabilities / above capacity / underpriced.
   */
  evaluateCFP(cfp: CFP): Bid | null {
    // Check deadline
    if (Date.now() > cfp.deadline_ms) {
      console.log(`[CNPWorker:${this.config.id}] CFP ${cfp.cfp_id} deadline passed — skip`)
      return null
    }

    // Check capacity
    if (!this.canAccept()) {
      console.log(`[CNPWorker:${this.config.id}] At capacity (${this.queue.length}/${this.config.max_concurrent_tasks}) — skip`)
      return null
    }

    // Check capability match (must cover at least one required capability)
    const matched = cfp.requirements.filter(r => this.config.capabilities.includes(r))
    if (cfp.requirements.length > 0 && matched.length === 0) {
      console.log(`[CNPWorker:${this.config.id}] No capability match for ${cfp.task_type} — skip`)
      return null
    }

    const price = this.computePrice()
    if (price > cfp.max_price_sats) {
      console.log(`[CNPWorker:${this.config.id}] Price ${price} > max ${cfp.max_price_sats} — skip`)
      return null
    }

    const bid: Bid = {
      cfp_id: cfp.cfp_id,
      worker_id: this.config.id,
      worker_pubkey: this.pubkey,
      worker_address: this.address,
      price_sats: price,
      estimated_ms: this.computeEstimatedMs(),
      sla_guarantee: `${Math.round((1 - this.loadFactor) * 99 + 1)}% delivery, retry on failure`,
      capabilities: this.config.capabilities,
    }

    console.log(
      `[CNPWorker:${this.config.id}] Bid on ${cfp.cfp_id}: ` +
      `${bid.price_sats} sats, ~${bid.estimated_ms}ms, load ${(this.loadFactor * 100).toFixed(0)}%`,
    )
    return bid
  }

  // ── Task lifecycle ────────────────────────────────────────────────────────

  /** Called when manager delegates a task to this worker. */
  acceptTask(taskId: string): void {
    this.queue.push(taskId)
    console.log(`[CNPWorker:${this.config.id}] Accepted task ${taskId} (queue: ${this.queue.length})`)
  }

  /** Simulate task execution — records timing, updates queue. */
  async executeTask(taskId: string, work: () => Promise<string>): Promise<string> {
    const start = Date.now()
    try {
      const result = await work()
      const elapsed = Date.now() - start
      this.response_times.push(elapsed)
      if (this.response_times.length > 50) this.response_times.shift() // rolling window

      this.total_tasks++
      if (this.reputation) {
        await this.reputation.processEvent({
          agentId: this.config.id,
          type: 'completion',
          response_ms: elapsed,
          earned_satoshis: this.config.base_price_sats,
        })
      }
      return result
    } finally {
      this.queue = this.queue.filter(id => id !== taskId)
    }
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  stats() {
    return {
      id: this.config.id,
      capabilities: this.config.capabilities,
      queue_length: this.queueLength,
      load_factor: this.loadFactor,
      avg_response_ms: this.avgResponseMs,
      total_tasks: this.total_tasks,
      current_price_sats: this.computePrice(),
    }
  }
}
