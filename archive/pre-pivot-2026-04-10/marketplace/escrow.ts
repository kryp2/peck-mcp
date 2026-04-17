/**
 * Escrow & Audit System — game-theoretic trust for compute marketplace.
 *
 * OP_RETURN format: "agentic-pay" prefix + SHA-256 hash of structured data.
 * No plaintext on chain — only commitments that can be verified.
 *
 * Broadcast via ARC (not WoC).
 */

import { Hash } from '@bsv/sdk'
import { UTXOManager } from './utxo-manager.js'

export interface EscrowRecord {
  workerId: string
  workerAddress: string
  escrowTxid: string
  escrowAmount: number
  status: 'active' | 'slashed' | 'returned'
  stakedAt: number
}

export interface AuditResult {
  workerId: string
  prompt: string
  match: boolean
  timestamp: number
}

export interface AuditStats {
  totalJobs: number
  totalPaid: number
  audited: number
  passed: number
  failed: number
  slashed: string[]
}

export class EscrowManager {
  private gatewayUtxo: UTXOManager
  private escrows: Map<string, EscrowRecord> = new Map()
  private auditLog: AuditResult[] = []
  private auditRate: number
  private stats: AuditStats = {
    totalJobs: 0, totalPaid: 0,
    audited: 0, passed: 0, failed: 0, slashed: [],
  }

  constructor(gatewayUtxo: UTXOManager, auditRate = 0.05) {
    this.gatewayUtxo = gatewayUtxo
    this.auditRate = auditRate
  }

  /**
   * Worker stakes escrow → broadcast immediately via ARC.
   */
  async stakeEscrow(
    workerUtxo: UTXOManager,
    workerId: string,
    amount: number,
  ): Promise<EscrowRecord> {
    const { tx, txid } = await workerUtxo.buildTx(
      this.gatewayUtxo.getAddress(),
      amount,
      { type: 'escrow_stake', worker: workerId, amount, ts: Date.now() },
    )

    await workerUtxo.broadcastNow(tx)
    this.gatewayUtxo.addFromTx(tx, txid, 0, amount)

    const record: EscrowRecord = {
      workerId, workerAddress: workerUtxo.getAddress(),
      escrowTxid: txid, escrowAmount: amount,
      status: 'active', stakedAt: Date.now(),
    }
    this.escrows.set(workerId, record)
    console.log(`[Escrow] ${workerId} staked ${amount} sat (${txid.slice(0, 16)}...)`)
    return record
  }

  shouldAudit(): boolean {
    return Math.random() < this.auditRate
  }

  audit(
    workerId: string,
    prompt: string,
    workerResponse: string,
    referenceResponse: string,
  ): AuditResult {
    const match = workerResponse === referenceResponse ||
      workerResponse.includes(prompt.slice(0, 50))

    const result: AuditResult = { workerId, prompt, match, timestamp: Date.now() }
    this.auditLog.push(result)
    this.stats.audited++
    if (match) this.stats.passed++
    else { this.stats.failed++; console.log(`[Audit] FAIL — ${workerId}`) }
    return result
  }

  /**
   * Slash dishonest worker → broadcast immediately via ARC.
   */
  async slash(workerId: string, reason: string): Promise<string | null> {
    const escrow = this.escrows.get(workerId)
    if (!escrow || escrow.status !== 'active') return null

    const evidenceHash = Array.from(
      Hash.sha256(Array.from(new TextEncoder().encode(reason)))
    ).map(b => b.toString(16).padStart(2, '0')).join('')

    const { tx, txid } = await this.gatewayUtxo.buildTx(
      this.gatewayUtxo.getAddress(), 1,
      { type: 'escrow_slash', worker: workerId, evidence: evidenceHash.slice(0, 32), ts: Date.now() },
    )

    await this.gatewayUtxo.broadcastNow(tx)
    escrow.status = 'slashed'
    this.stats.slashed.push(workerId)
    console.log(`[Escrow] SLASHED ${workerId}! ${escrow.escrowAmount} sat forfeited (${txid.slice(0, 16)}...)`)
    return txid
  }

  /**
   * Pay worker — local build, queued for async ARC broadcast.
   */
  async payWorker(
    workerId: string,
    workerAddress: string,
    amount: number,
    proofHash: string,
  ): Promise<string> {
    const { tx, txid } = await this.gatewayUtxo.buildTx(
      workerAddress, amount,
      { type: 'job_payment', worker: workerId, proof: proofHash.slice(0, 32), ts: Date.now() },
    )
    this.gatewayUtxo.queueBroadcast(tx)
    this.stats.totalJobs++
    this.stats.totalPaid += amount
    return txid
  }

  getEscrow(workerId: string) { return this.escrows.get(workerId) }
  getStats(): AuditStats { return { ...this.stats } }
  getAuditLog() { return [...this.auditLog] }
}
