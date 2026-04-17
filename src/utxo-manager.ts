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
import { existsSync } from 'fs'

// Auto-load .env (Node 21+) so any test that imports UTXOManager picks up
// TAAL keys without needing --env-file on the cli.
if (!process.env.TAAL_TESTNET_KEY && existsSync('.env')) {
  try { (process as any).loadEnvFile('.env') } catch { /* ignore */ }
}

// ARC endpoints
const ARC_ENDPOINTS = {
  test: 'https://arc-test.taal.com',
  main: 'https://arc.taal.com',
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
  async initialSync(opts: { confirmedOnly?: boolean } = {}): Promise<void> {
    const confirmedOnly = opts.confirmedOnly ?? false
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
      tx_hash: string; tx_pos: number; value: number; height: number
    }>

    for (const u of data) {
      if (confirmedOnly && (!u.height || u.height === 0)) continue
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
          sourceTx: Transaction.fromHex(txHex.trim()), spent: false,
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
   * Build OP_RETURN output with self-describing JSON payload.
   *
   * Format: OP_FALSE OP_RETURN "peckpay" <json>
   *
   * The JSON is human-readable in any block explorer (WoC etc.) and
   * fully reconstructs the meaning of the transaction without needing
   * an off-chain decoder. Typical payload is 60–180 bytes.
   *
   * If the JSON exceeds 200 bytes we fall back to a SHA-256 commitment
   * so we never overflow OP_RETURN budget.
   */
  private buildOpReturn(data: Record<string, any>): Script {
    const prefix = Array.from(new TextEncoder().encode('peckpay'))
    const json = JSON.stringify(data)
    let payloadBytes = Array.from(new TextEncoder().encode(json))
    let usePushdata1 = false

    if (payloadBytes.length > 200) {
      // Fallback to hash commitment if too large
      payloadBytes = Array.from(Hash.sha256(payloadBytes))
    }
    if (payloadBytes.length > 75) usePushdata1 = true

    const script: number[] = [
      0x00,           // OP_FALSE
      0x6a,           // OP_RETURN
      prefix.length,  // direct push (7 bytes)
      ...prefix,
    ]
    if (usePushdata1) {
      script.push(0x4c, payloadBytes.length, ...payloadBytes) // OP_PUSHDATA1
    } else {
      script.push(payloadBytes.length, ...payloadBytes)        // direct push
    }
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
   * Build a self-payment carrying a raw OP_RETURN payload (used for
   * capability advertisements / BRC-100-style discovery records).
   * Payload is embedded verbatim under the given protocol prefix.
   */
  async buildAdvertTx(prefix: string, payload: string): Promise<{ tx: Transaction; txid: string }> {
    const feeEstimate = 80
    const utxo = this.selectUtxo(feeEstimate)

    const prefixBytes = Array.from(new TextEncoder().encode(prefix))
    const payloadBytes = Array.from(new TextEncoder().encode(payload))
    if (payloadBytes.length > 220) throw new Error('advert payload too large')

    const script: number[] = [
      0x00, 0x6a, // OP_FALSE OP_RETURN
      prefixBytes.length, ...prefixBytes,
      0x4c, payloadBytes.length, ...payloadBytes, // OP_PUSHDATA1
    ]

    const tx = new Transaction()
    tx.addInput({
      sourceTransaction: utxo.sourceTx,
      sourceOutputIndex: utxo.vout,
      unlockingScriptTemplate: new P2PKH().unlock(this.key),
    })
    tx.addOutput({
      lockingScript: Script.fromBinary(script),
      satoshis: 0,
    })
    tx.addOutput({
      lockingScript: new P2PKH().lock(this.address),
      change: true,
    })

    await tx.fee()
    await tx.sign()

    const txid = tx.id('hex') as string
    utxo.spent = true

    for (let i = 0; i < tx.outputs.length; i++) {
      const out = tx.outputs[i]
      if ((out as any).change && out.satoshis && out.satoshis > 0) {
        this.utxos.set(this.utxoKey(txid, i), {
          txid, vout: i, satoshis: out.satoshis, sourceTx: tx, spent: false,
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
   * Broadcast single TX. Prefers TAAL ARC (with API key from env)
   * for both testnet and mainnet. Falls back to WoC if no key set.
   *
   * Env: TAAL_TESTNET_KEY, TAAL_MAINNET_KEY
   */
  async broadcastNow(tx: Transaction): Promise<string> {
    const txHex = tx.toHex()
    const localTxid = tx.id('hex') as string

    const taalKey = this.network === 'test'
      ? process.env.TAAL_TESTNET_KEY
      : process.env.TAAL_MAINNET_KEY

    if (taalKey) {
      const arcBase = this.network === 'test'
        ? 'https://arc-test.taal.com'
        : 'https://arc.taal.com'
      // Use Extended Format (EF) so ARC can validate chained mempool txs
      // without looking up the parent — required for high throughput chains.
      const efHex = (tx as any).toHexEF ? (tx as any).toHexEF() : txHex
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(`${arcBase}/v1/tx`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${taalKey}`,
          },
          body: JSON.stringify({ rawTx: efHex }),
        })
        const data = await res.json().catch(() => ({})) as any
        // ARC success: status 200 with txStatus SEEN_ON_NETWORK / STORED
        if (res.ok) return data.txid || localTxid
        // Already in mempool / chain → success
        const detail = (data.detail || data.title || '').toString()
        if (detail.toLowerCase().includes('already')) return localTxid
        if (res.status === 429 || res.status >= 500) {
          await new Promise(r => setTimeout(r, (attempt + 1) * 1000))
          continue
        }
        throw new Error(`ARC broadcast failed: ${res.status} ${JSON.stringify(data)}`)
      }
      throw new Error('ARC broadcast failed after retries')
    }

    // Fallback: WoC (testnet only, mainnet would need ARC)
    if (this.network !== 'test') {
      throw new Error('Mainnet broadcast requires TAAL_MAINNET_KEY env var')
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`${this.wocUrl}/tx/raw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txhex: txHex }),
      })
      const text = await res.text()
      if (res.ok) return text.replace(/"/g, '').trim() || localTxid
      if (text.includes('already') || text.includes('Already')) return localTxid
      if (res.status === 429 || res.status >= 500) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 1000))
        continue
      }
      throw new Error(`WoC broadcast failed: ${res.status} ${text}`)
    }
    throw new Error('WoC broadcast failed after retries')
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
