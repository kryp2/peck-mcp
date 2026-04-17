/**
 * Capability Registry — BRC-100-style on-chain service discovery.
 *
 * Sellers publish a self-payment TX whose OP_RETURN contains:
 *   AGTPAY1 <json capability>
 *
 * Buyers know only the seller's BSV address. They query WoC for the address
 * history, fetch each TX, parse OP_RETURN outputs, and recover the most
 * recent capability advertisement.
 */
import { Transaction } from '@bsv/sdk'
import { UTXOManager } from './utxo-manager.js'

export const PROTOCOL_PREFIX = 'AGTPAY1'
const WOC = {
  test: 'https://api.whatsonchain.com/v1/bsv/test',
  main: 'https://api.whatsonchain.com/v1/bsv/main',
}

export interface Capability {
  name: string
  service: string
  endpoint: string
  pricePerCall: number
  pubkey: string
  ts: number
}

export async function publishCapability(
  utxoMgr: UTXOManager,
  cap: Capability,
): Promise<string> {
  const payload = JSON.stringify(cap)
  const { tx, txid } = await utxoMgr.buildAdvertTx(PROTOCOL_PREFIX, payload)
  await utxoMgr.broadcastNow(tx)
  return txid
}

/**
 * Parse all OP_RETURN scripts in a tx and find ones starting with our prefix.
 */
function extractCapabilitiesFromTx(tx: Transaction): Capability[] {
  const found: Capability[] = []
  for (const out of tx.outputs) {
    if (!out.lockingScript) continue
    const bin = out.lockingScript.toBinary()
    // Look for OP_FALSE OP_RETURN ... (0x00 0x6a) or just OP_RETURN (0x6a)
    let i = 0
    if (bin[i] === 0x00 && bin[i + 1] === 0x6a) i += 2
    else if (bin[i] === 0x6a) i += 1
    else continue

    // Read prefix push (single byte length)
    const prefixLen = bin[i]; i++
    if (prefixLen === undefined || i + prefixLen > bin.length) continue
    const prefix = new TextDecoder().decode(new Uint8Array(bin.slice(i, i + prefixLen)))
    i += prefixLen
    if (prefix !== PROTOCOL_PREFIX) continue

    // Read payload (OP_PUSHDATA1 0x4c <len> <data>)
    if (bin[i] !== 0x4c) continue
    i++
    const payloadLen = bin[i]; i++
    if (payloadLen === undefined || i + payloadLen > bin.length) continue
    const payloadStr = new TextDecoder().decode(new Uint8Array(bin.slice(i, i + payloadLen)))
    try {
      const cap = JSON.parse(payloadStr) as Capability
      found.push(cap)
    } catch { /* skip malformed */ }
  }
  return found
}

/**
 * Discover capabilities published by an address.
 * Queries WoC history + unspent (to catch unconfirmed advert TXs).
 * Returns capabilities sorted newest first.
 */
export async function discoverByAddress(
  address: string,
  network: 'test' | 'main' = 'test',
  options: { retries?: number; retryDelayMs?: number } = {},
): Promise<Capability[]> {
  const base = WOC[network]
  const retries = options.retries ?? 1
  const retryDelay = options.retryDelayMs ?? 5000

  for (let attempt = 0; attempt < retries; attempt++) {
    const caps = await discoverOnce(address, base)
    if (caps.length > 0 || attempt === retries - 1) return caps
    await new Promise(r => setTimeout(r, retryDelay))
  }
  return []
}

async function discoverOnce(address: string, base: string): Promise<Capability[]> {
  const txHashes = new Set<string>()

  // Confirmed history
  try {
    const r = await fetch(`${base}/address/${address}/history`)
    if (r.ok) {
      const history = await r.json() as Array<{ tx_hash: string; height: number }>
      history.forEach(h => txHashes.add(h.tx_hash))
    }
  } catch { /* ignore */ }

  // Unspent (catches mempool / unconfirmed where the change UTXO still exists)
  try {
    const r = await fetch(`${base}/address/${address}/unspent`)
    if (r.ok) {
      const utxos = await r.json() as Array<{ tx_hash: string }>
      utxos.forEach(u => txHashes.add(u.tx_hash))
    }
  } catch { /* ignore */ }

  const caps: Array<Capability & { _txid: string }> = []
  for (const txid of txHashes) {
    try {
      const r = await fetch(`${base}/tx/${txid}/hex`)
      if (!r.ok) continue
      const hex = await r.text()
      const tx = Transaction.fromHex(hex)
      const found = extractCapabilitiesFromTx(tx)
      for (const c of found) caps.push({ ...c, _txid: txid })
    } catch { /* skip */ }
  }

  caps.sort((a, b) => (b.ts || 0) - (a.ts || 0))
  return caps.map(({ _txid, ...c }) => c)
}
