/**
 * UTXO Manager — local-first transaction chaining with ARC broadcast.
 *
 * Design:
 *   - ONE initial sync from WoC to bootstrap source TXs
 *   - All TX building is local (chain output A → input B)
 *   - Broadcast via ARC (no rate limits, designed for high throughput)
 *   - OP_RETURN is a 32-byte SHA-256 hash commitment, not plaintext
 */

import { PrivateKey, Transaction, P2PKH, Script, Hash } from '@bsv/sdk'

// ARC endpoints
const ARC_ENDPOINTS = {
  test: 'https://arc.gorillapool.io',
  main: 'https://arc.gorillapool.io',
}

// WoC for initial UTXO sync only
const WOC_BASE = {
  test: 'https://api.whatsonchain.com/v1/bsv/test',
  main: 'https://api.whatsonchain.com/v1/bsv/main',
}

export interface UTXO {
  txid: string
  vout: number
  satoshis: number
  sourceTx: Transaction
  spent: boolean
}

export class UTXOManager {
  private key: PrivateKey
  private address: string
  private utxos: Map<string, UTXO> = new Map()
  private network: 'test' | 'main'
  private broadcastQueue: Transaction[] = []
  private txCount = 0
  private arcUrl: string
  private wocUrl: string

  constructor(key: PrivateKey, network: 'test' | 'main' = 'test') {
    this.key = key
    this.network = network
    this.address = key.toAddress(network === 'test' ? 'testnet' : 'mainnet')
    this.arcUrl = ARC_ENDPOINTS[network]
    this.wocUrl = WOC_BASE[network]
  }

  private utxoKey(txid: string, vout: number): string {
    return `${txid}:${vout}`
  }

  /**
   * Initial sync — called ONCE at startup.
   * Uses WoC to discover existing UTXOs and fetch source TXs.
   * After this, everything is local + ARC.
   */
  async initialSync(): Promise<void> {
    let res: Response | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(`${this.wocUrl}/address/${this.address}/unspent`)
      if (res.ok) break
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 2000))
        continue
      }
      throw new Error(`UTXO fetch failed: ${res.status}`)
    }
    if (!res?.ok) throw new Error('UTXO fetch failed after retries')

    const data = await res.json() as Array<{
      tx_hash: string; tx_pos: number; value: number
    }>

    for (const u of data) {
      const key = this.utxoKey(u.tx_hash, u.tx_pos)
      if (this.utxos.has(key)) continue

      // Fetch source TX (needed for signing)
      let txHex: string | null = null
      for (let attempt = 0; attempt < 3; attempt++) {
        const txRes = await fetch(`${this.wocUrl}/tx/${u.tx_hash}/hex`)
        if (txRes.ok) { txHex = await txRes.text(); break }
        if (txRes.status === 429) {
          await new Promise(r => setTimeout(r, (attempt + 1) * 2000))
          continue
        }
        break // 404 etc — skip this UTXO
      }

      if (txHex) {
        this.utxos.set(key, {
          txid: u.tx_hash, vout: u.tx_pos, satoshis: u.value,
          sourceTx: Transaction.fromHex(txHex), spent: false,
        })
      }
    }
  }

  get balance(): number {
    let total = 0
    for (const u of this.utxos.values()) {
      if (!u.spent) total += u.satoshis
    }
    return total
  }

  /**
   * Select best UTXO. Purely local.
   */
  private selectUtxo(targetSats: number): UTXO {
    const available = [...this.utxos.values()]
      .filter(u => !u.spent)
      .sort((a, b) => a.satoshis - b.satoshis)

    const utxo = available.find(u => u.satoshis >= targetSats)
      ?? available[available.length - 1]

    if (!utxo || utxo.satoshis < targetSats) {
      throw new Error(`Insufficient funds: need ${targetSats}, have ${this.balance}`)
    }
    return utxo
  }

  /**
   * Build OP_RETURN output with hash commitment.
   *
   * Format: OP_FALSE OP_RETURN <protocol_prefix> <sha256_hash>
   * Protocol prefix: "agentic-pay" (11 bytes)
   * Hash: SHA-256 of structured data (32 bytes)
   *
   * Total OP_RETURN payload: 43 bytes + overhead = ~50 bytes
   */
  private buildOpReturn(data: Record<string, string | number>): Script {
    // Protocol prefix
    const prefix = Array.from(new TextEncoder().encode('agentic-pay'))
    // Hash the structured data
    const payload = JSON.stringify(data)
    const hash = Hash.sha256(Array.from(new TextEncoder().encode(payload)))

    // Build: OP_FALSE OP_RETURN <prefix_push> <prefix> <hash_push> <hash>
    const script: number[] = [
      0x00,           // OP_FALSE
      0x6a,           // OP_RETURN
      prefix.length,  // pushdata (11 bytes)
      ...prefix,
      hash.length,    // pushdata (32 bytes)
      ...hash,
    ]

    return Script.fromBinary(script)
  }

  /**
   * Build and sign a payment TX. Local only — no network calls.
   * Automatically chains change output → next UTXO.
   */
  async buildTx(
    toAddress: string,
    satoshis: number,
    opReturnData?: Record<string, string | number>,
  ): Promise<{ tx: Transaction; txid: string }> {
    const feeEstimate = 50
    const utxo = this.selectUtxo(satoshis + feeEstimate)

    const tx = new Transaction()

    tx.addInput({
      sourceTransaction: utxo.sourceTx,
      sourceOutputIndex: utxo.vout,
      unlockingScriptTemplate: new P2PKH().unlock(this.key),
    })

    // Payment output
    tx.addOutput({
      lockingScript: new P2PKH().lock(toAddress),
      satoshis,
    })

    // OP_RETURN commitment
    if (opReturnData) {
      tx.addOutput({
        lockingScript: this.buildOpReturn(opReturnData),
        satoshis: 0,
      })
    }

    // Change
    tx.addOutput({
      lockingScript: new P2PKH().lock(this.address),
      change: true,
    })

    await tx.fee()
    await tx.sign()

    const txid = tx.id('hex') as string

    // Mark input spent
    utxo.spent = true

    // Register change UTXO for chaining
    for (let i = 0; i < tx.outputs.length; i++) {
      const out = tx.outputs[i]
      if ((out as any).change && out.satoshis && out.satoshis > 0) {
        this.utxos.set(this.utxoKey(txid, i), {
          txid, vout: i, satoshis: out.satoshis,
          sourceTx: tx, spent: false,
        })
      }
    }

    this.txCount++
    return { tx, txid }
  }

  /**
   * Register external UTXO (e.g. escrow received)
   */
  addFromTx(tx: Transaction, txid: string, vout: number, satoshis: number): void {
    this.utxos.set(this.utxoKey(txid, vout), {
      txid, vout, satoshis, sourceTx: tx, spent: false,
    })
  }

  /**
   * Queue TX for async ARC broadcast.
   */
  queueBroadcast(tx: Transaction): void {
    this.broadcastQueue.push(tx)
  }

  /**
   * Broadcast single TX via ARC immediately.
   * ARC accepts raw TX hex via POST /v1/tx
   */
  async broadcastNow(tx: Transaction): Promise<string> {
    const txHex = tx.toHex()
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`${this.arcUrl}/v1/tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: Buffer.from(txHex, 'hex'),
      })
      const data = await res.json() as any
      if (res.ok || data.txid) return data.txid || tx.id('hex') as string
      if (res.status === 429 || res.status >= 500) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 1000))
        continue
      }
      // "already in mempool" is success
      if (data.detail?.includes('already') || data.title?.includes('Already')) {
        return tx.id('hex') as string
      }
      throw new Error(`ARC broadcast failed: ${res.status} ${JSON.stringify(data)}`)
    }
    throw new Error('ARC broadcast failed after retries')
  }

  /**
   * Flush broadcast queue via ARC.
   * ARC has no rate limits like WoC — designed for throughput.
   */
  async flushBroadcasts(): Promise<{ sent: number; failed: number }> {
    let sent = 0, failed = 0
    const batch = [...this.broadcastQueue]
    this.broadcastQueue = []

    for (const tx of batch) {
      try {
        await this.broadcastNow(tx)
        sent++
      } catch (err) {
        failed++
        // Don't re-queue — if it fails on ARC it's likely invalid
        console.error(`  Broadcast failed: ${err}`)
      }
    }
    return { sent, failed }
  }

  getAddress(): string { return this.address }
  getKey(): PrivateKey { return this.key }
  getTxCount(): number { return this.txCount }
  getQueueSize(): number { return this.broadcastQueue.length }

  stats() {
    const all = [...this.utxos.values()]
    return {
      address: this.address,
      balance: this.balance,
      utxoCount: all.filter(u => !u.spent).length,
      spentCount: all.filter(u => u.spent).length,
      txCount: this.txCount,
      queueSize: this.broadcastQueue.length,
    }
  }
}
