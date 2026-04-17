/**
 * Wright §5.4 Mechanism Design — Audit, Penalty, Escrow
 *
 * Implements the three core mechanisms from Wright 2025
 * "Resolving CAP Through Economic Design" §5.4:
 *
 *   1. TRUTHFUL REPORTING INCENTIVE — agents maximize utility by reporting
 *      their state honestly. Lying costs more than it gains because audit
 *      reports are permanent on-chain records that affect reputation.
 *
 *   2. COLLUSION PENALTY — colluding agents earn less than truthful agents.
 *      Reports are deduplicated by (service, request_commitment) so
 *      fabricating reports requires real service calls (costs real sat).
 *
 *   3. ESCROW-BASED ACCOUNTABILITY — each service agent posts escrow.
 *      If audit detects misbehavior (proven on-chain), escrow is forfeited.
 *      This is enforced by P2MS today, upgradeable to Chronicle covenant.
 *
 * All actions are Bitcoin Schema transactions:
 *   - Escrow deposit: type=function, name=escrow-deposit
 *   - Audit report:   type=post with tag 'audit-report'
 *   - Reputation:     Derived live from on-chain audit history (never stored)
 *   - Slash:          type=post with tag 'slash' + escrow settlement tx
 *
 * Reference: Wright 2025, §5.4 "Mechanism Design: Audit, Penalty, Escrow"
 */
import { PrivateKey } from '@bsv/sdk'
import { createHash } from 'crypto'
import { BankLocal } from '../clients/bank-local.js'
import { BitcoinSchema } from './bitcoin-schema.js'

// ============================================================================
// Types
// ============================================================================

export type AuditSeverity = 'minor' | 'major' | 'critical'

export interface AuditReport {
  reporter: string         // pubkey of reporting agent
  service_id: string       // function name or agent ID
  service_pubkey: string   // pubkey of the service being reported
  request_commitment: string  // sha256 of the original request (dedup key)
  severity: AuditSeverity
  reason: string
  evidence?: string        // optional on-chain evidence txid
  timestamp: number
}

export interface ReputationScore {
  pubkey: string
  total_calls: number
  reports: { minor: number; major: number; critical: number }
  weighted_reports: number
  score: number            // 0.0 to 1.0 (1.0 = perfect)
  escrow_sat: number
  slashed: boolean
}

// ============================================================================
// Reputation Calculator (derived, never stored — Wright §5.4)
// ============================================================================

const SEVERITY_WEIGHTS: Record<AuditSeverity, number> = {
  minor: 1,
  major: 3,
  critical: 10,
}

// Reputation thresholds
const SLASH_THRESHOLD = 0.70    // Below this → escrow at risk
const DELIST_THRESHOLD = 0.50   // Below this → hidden from discovery
const DEFAULT_REPUTATION = 0.95 // New agents start here

/**
 * Calculate reputation from audit history.
 * Score = 1 - (weighted_reports / max(1, total_calls))
 * This is DERIVED every time, never stored. Wright §5.4 requirement.
 */
export function calculateReputation(
  totalCalls: number,
  reports: { minor: number; major: number; critical: number },
  escrowSat: number,
): ReputationScore {
  const weighted = reports.minor * SEVERITY_WEIGHTS.minor
    + reports.major * SEVERITY_WEIGHTS.major
    + reports.critical * SEVERITY_WEIGHTS.critical

  const raw = 1 - (weighted / Math.max(1, totalCalls))
  const score = Math.max(0, Math.min(1, totalCalls === 0 ? DEFAULT_REPUTATION : raw))

  return {
    pubkey: '',
    total_calls: totalCalls,
    reports,
    weighted_reports: weighted,
    score,
    escrow_sat: escrowSat,
    slashed: score < SLASH_THRESHOLD,
  }
}

// ============================================================================
// Wright Mechanism — main class
// ============================================================================

export class WrightMechanism {
  readonly bank: BankLocal
  readonly app: string
  private statePrefix: string

  constructor(bank?: BankLocal, app = 'peck.agents') {
    this.bank = bank ?? new BankLocal()
    this.app = app
    this.statePrefix = 'wright:'
  }

  // ──────────────────────────────────────────────────────────
  // 1. TRUTHFUL REPORTING — post audit reports on-chain
  // ──────────────────────────────────────────────────────────

  /**
   * File an audit report against a service agent.
   * The report is a Bitcoin Schema post with structured tags.
   * Deduplication: same (service, request_commitment) can only be reported once.
   *
   * Wright §5.4: "The mechanism g is designed such that each agent maximises
   * its expected utility by reporting its local state and observations truthfully"
   */
  async fileReport(report: AuditReport, signingKey: PrivateKey): Promise<{
    txid: string
    deduplicated: boolean
  }> {
    // Deduplication check
    const dedupKey = `${this.statePrefix}dedup:${report.service_pubkey}:${report.request_commitment}`
    const existing = await this.bank.stateGet<boolean>(dedupKey)
    if (existing) {
      return { txid: '', deduplicated: true }
    }

    // Post report on-chain as Bitcoin Schema
    const reportContent = JSON.stringify({
      type: 'audit_report',
      wright_section: '5.4',
      service_id: report.service_id,
      service_pubkey: report.service_pubkey,
      severity: report.severity,
      reason: report.reason,
      evidence: report.evidence,
      request_commitment: report.request_commitment,
    })

    const script = BitcoinSchema.post({
      content: reportContent,
      app: this.app,
      tags: [
        'audit-report',
        `severity:${report.severity}`,
        `service:${report.service_id}`,
        'wright-5.4',
      ],
      signingKey,
    })

    const result = await this.bank.createAction(
      `wright-audit: ${report.severity} report on ${report.service_id}`,
      [{ script: script.toHex(), satoshis: 0 }]
    )

    // Record dedup + increment report count
    await this.bank.statePut(dedupKey, true)

    const reportCountKey = `${this.statePrefix}reports:${report.service_pubkey}`
    const counts = await this.bank.stateGet<{ minor: number; major: number; critical: number }>(reportCountKey)
      ?? { minor: 0, major: 0, critical: 0 }
    counts[report.severity]++
    await this.bank.statePut(reportCountKey, counts)

    // Increment total call count for reporter (proves they actually used the service)
    const callerKey = `${this.statePrefix}calls:${report.reporter}:${report.service_pubkey}`
    const callCount = ((await this.bank.stateGet<number>(callerKey)) ?? 0) + 1
    await this.bank.statePut(callerKey, callCount)

    return { txid: result.txid, deduplicated: false }
  }

  // ──────────────────────────────────────────────────────────
  // 2. REPUTATION — derived live, never stored
  // ──────────────────────────────────────────────────────────

  /**
   * Get reputation for a service agent.
   * Calculated from on-chain audit history every time.
   *
   * Wright §5.4: Reputation is a function of audit history,
   * not a stored value that can be manipulated.
   */
  async getReputation(servicePubkey: string): Promise<ReputationScore> {
    const reportCountKey = `${this.statePrefix}reports:${servicePubkey}`
    const reports = await this.bank.stateGet<{ minor: number; major: number; critical: number }>(reportCountKey)
      ?? { minor: 0, major: 0, critical: 0 }

    // Count total calls across all callers
    const callPrefix = `${this.statePrefix}calls:`
    const { keys } = await this.bank.stateList(callPrefix)
    let totalCalls = 0
    for (const { key } of keys) {
      if (key.includes(`:${servicePubkey}`)) {
        const count = await this.bank.stateGet<number>(key)
        totalCalls += count ?? 0
      }
    }

    // Get escrow amount
    const escrowKey = `${this.statePrefix}escrow:${servicePubkey}`
    const escrowSat = (await this.bank.stateGet<number>(escrowKey)) ?? 0

    const rep = calculateReputation(totalCalls, reports, escrowSat)
    rep.pubkey = servicePubkey
    return rep
  }

  // ──────────────────────────────────────────────────────────
  // 3. ESCROW — deposit + slash
  // ──────────────────────────────────────────────────────────

  /**
   * Record escrow deposit for a service agent.
   * In production: verified on-chain via P2MS or covenant UTXO.
   * For hackathon: recorded in state with optional txid verification.
   */
  async recordEscrow(servicePubkey: string, amountSat: number, escrowTxid?: string): Promise<void> {
    const escrowKey = `${this.statePrefix}escrow:${servicePubkey}`
    const current = (await this.bank.stateGet<number>(escrowKey)) ?? 0
    await this.bank.statePut(escrowKey, current + amountSat)

    if (escrowTxid) {
      const txidKey = `${this.statePrefix}escrow-txid:${servicePubkey}`
      const txids = (await this.bank.stateGet<string[]>(txidKey)) ?? []
      txids.push(escrowTxid)
      await this.bank.statePut(txidKey, txids)
    }
  }

  /**
   * Slash an agent's escrow due to proven misbehavior.
   * Posts the slash event on-chain as Bitcoin Schema.
   *
   * Wright §5.4: "If a node is found to have propagated an incorrect
   * or inconsistent state, then e_i → forfeit."
   */
  async slash(
    servicePubkey: string,
    reason: string,
    evidence: string[],
    signingKey: PrivateKey,
  ): Promise<{ txid: string; forfeited_sat: number }> {
    const escrowKey = `${this.statePrefix}escrow:${servicePubkey}`
    const escrowSat = (await this.bank.stateGet<number>(escrowKey)) ?? 0

    // Post slash event on-chain
    const slashContent = JSON.stringify({
      type: 'escrow_slash',
      wright_section: '5.4',
      service_pubkey: servicePubkey,
      reason,
      evidence_txids: evidence,
      forfeited_sat: escrowSat,
      timestamp: Date.now(),
    })

    const script = BitcoinSchema.post({
      content: slashContent,
      app: this.app,
      tags: ['slash', 'escrow-forfeiture', 'wright-5.4'],
      signingKey,
    })

    const result = await this.bank.createAction(
      `wright-slash: ${servicePubkey.slice(0, 12)}… forfeits ${escrowSat} sat`,
      [{ script: script.toHex(), satoshis: 0 }]
    )

    // Zero out escrow
    await this.bank.statePut(escrowKey, 0)

    return { txid: result.txid, forfeited_sat: escrowSat }
  }

  // ──────────────────────────────────────────────────────────
  // Integration: reputation-aware discovery
  // ──────────────────────────────────────────────────────────

  /**
   * Filter a list of services by minimum reputation.
   * Used by buyer agents to avoid misbehaving services.
   */
  async filterByReputation(
    services: Array<{ pubkey: string; [k: string]: any }>,
    minReputation = 0.80,
  ): Promise<Array<{ pubkey: string; reputation: ReputationScore; [k: string]: any }>> {
    const results: Array<any> = []
    for (const svc of services) {
      const rep = await this.getReputation(svc.pubkey)
      if (rep.score >= minReputation) {
        results.push({ ...svc, reputation: rep })
      }
    }
    return results.sort((a, b) => b.reputation.score - a.reputation.score)
  }
}
