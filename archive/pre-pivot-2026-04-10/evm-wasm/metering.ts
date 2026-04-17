/**
 * AP4E — Real-Time Metering & Billing engine.
 *
 * Append-only ring buffer of usage events. Periodic Merkle root
 * computation, root anchored to BSV via OP_RETURN. The append-only
 * + on-chain anchor combo means: any party can audit usage and
 * verify it hasn't been tampered with after the fact.
 *
 * This is the core of "neutral third-party metering" — Stripe can't
 * do it because their database is mutable; we can because BSV anchors
 * are immutable.
 */
import { Hash } from '@bsv/sdk'

export interface MeterEvent {
  id: number              // monotonic, set by record()
  ts: number              // ms since epoch
  service: string         // worker id
  capability: string
  caller: string          // caller identity (BSV address or 'anonymous')
  amount_sat: number
  request_hash: string    // sha256 of request body
  response_hash: string   // sha256 of response body
}

export interface MerkleAnchor {
  root: string            // hex
  start_id: number
  end_id: number
  count: number
  ts: number
  txid?: string           // BSV anchor txid (optional, set after broadcast)
}

const MAX_EVENTS = 100_000  // ring buffer cap

class MeteringEngine {
  private events: MeterEvent[] = []
  private nextId = 1
  private anchors: MerkleAnchor[] = []
  private lastAnchoredId = 0

  record(e: Omit<MeterEvent, 'id' | 'ts'>): MeterEvent {
    const event: MeterEvent = { id: this.nextId++, ts: Date.now(), ...e }
    this.events.push(event)
    if (this.events.length > MAX_EVENTS) this.events.shift()
    return event
  }

  recent(limit = 50): MeterEvent[] {
    return this.events.slice(-limit).reverse()
  }

  totalSpentBy(caller: string): number {
    return this.events.filter(e => e.caller === caller).reduce((a, e) => a + e.amount_sat, 0)
  }

  totalEarnedBy(service: string): number {
    return this.events.filter(e => e.service === service).reduce((a, e) => a + e.amount_sat, 0)
  }

  /**
   * Compute a Merkle root over a contiguous range of events.
   * Each leaf = sha256(JSON.stringify(event)).
   */
  computeMerkleRoot(startId: number, endId: number): { root: string; count: number } {
    const slice = this.events.filter(e => e.id >= startId && e.id <= endId)
    if (slice.length === 0) return { root: '0'.repeat(64), count: 0 }

    let layer = slice.map(e => {
      const bytes = Hash.sha256(Array.from(new TextEncoder().encode(JSON.stringify(e))))
      return Array.from(bytes)
    })

    while (layer.length > 1) {
      const next: number[][] = []
      for (let i = 0; i < layer.length; i += 2) {
        const a = layer[i]
        const b = layer[i + 1] ?? layer[i]  // duplicate last if odd
        next.push(Array.from(Hash.sha256(a.concat(b))))
      }
      layer = next
    }

    const root = layer[0].map(b => b.toString(16).padStart(2, '0')).join('')
    return { root, count: slice.length }
  }

  /**
   * Compute root over all events not yet anchored. Returns the
   * anchor record without broadcasting. Caller broadcasts and
   * passes back the txid via attachAnchorTxid().
   */
  prepareAnchor(): MerkleAnchor | null {
    const startId = this.lastAnchoredId + 1
    const endId = this.nextId - 1
    if (endId < startId) return null

    const { root, count } = this.computeMerkleRoot(startId, endId)
    const anchor: MerkleAnchor = {
      root,
      start_id: startId,
      end_id: endId,
      count,
      ts: Date.now(),
    }
    return anchor
  }

  recordAnchor(anchor: MerkleAnchor, txid: string): void {
    anchor.txid = txid
    this.anchors.push(anchor)
    this.lastAnchoredId = anchor.end_id
  }

  /**
   * Verify that an event is contained in an anchor by re-computing
   * the root over the original range.
   */
  verifyEventInAnchor(eventId: number, anchorIdx: number): boolean {
    const anchor = this.anchors[anchorIdx]
    if (!anchor) return false
    if (eventId < anchor.start_id || eventId > anchor.end_id) return false
    const { root } = this.computeMerkleRoot(anchor.start_id, anchor.end_id)
    return root === anchor.root
  }

  stats() {
    return {
      total_events: this.events.length,
      next_id: this.nextId,
      last_anchored_id: this.lastAnchoredId,
      anchors_count: this.anchors.length,
      latest_anchor: this.anchors[this.anchors.length - 1] || null,
    }
  }

  listAnchors(): MerkleAnchor[] {
    return [...this.anchors]
  }
}

// Process-wide singleton — services share the same metering engine.
// In a multi-process deployment this would be a DB or a dedicated
// metering service.
export const metering = new MeteringEngine()
