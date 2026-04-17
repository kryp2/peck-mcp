/**
 * consolidate-dust.ts — sweeps fragmented UTXOs on worker1/worker2 (or any
 * named wallet from .wallets.json) into a single fat UTXO.
 *
 * Why: dag-1+2 testing left ~900+ tiny outputs per worker, blocking any
 * operation that needs a single chunky funding UTXO (e.g. building a fresh
 * ladder of N×200-sat leaves). This script gathers up to MAX_INPUTS UTXOs
 * (skipping uneconomical ones below MIN_SAT) and produces 1 input-batch tx
 * with one big change output back to the same address.
 *
 * Usage:
 *   WALLET=worker1 npx tsx scripts/consolidate-dust.ts
 *   WALLET=worker2 MAX_INPUTS=80 MIN_SAT=100 npx tsx scripts/consolidate-dust.ts
 *   WALLET=worker1 DRY_RUN=1 npx tsx scripts/consolidate-dust.ts
 *
 * Env:
 *   WALLET      — key in .wallets.json (default: worker1)
 *   MAX_INPUTS  — max UTXOs to consume in one tx (default: 100)
 *   MIN_SAT     — skip UTXOs smaller than this (default: 50, filters 2-sat dust)
 *   DRY_RUN     — if set, build+log but don't broadcast
 *   NETWORK     — 'test' or 'main' (default: test)
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { Transaction, P2PKH, PrivateKey } from '@bsv/sdk'
import { arcBroadcast, type Network } from '../src/ladder/arc.js'

const WALLET = process.env.WALLET ?? 'worker1'
const MAX_INPUTS = Number(process.env.MAX_INPUTS ?? 100)
const MIN_SAT = Number(process.env.MIN_SAT ?? 50)
const DRY_RUN = !!process.env.DRY_RUN
const NETWORK: Network = (process.env.NETWORK as Network) ?? 'test'

const WOC_BASE = NETWORK === 'test'
  ? 'https://api.whatsonchain.com/v1/bsv/test'
  : 'https://api.whatsonchain.com/v1/bsv/main'

interface WocUtxo {
  height: number
  tx_pos: number
  tx_hash: string
  value: number
}

async function fetchUnspent(addr: string): Promise<WocUtxo[]> {
  const r = await fetch(`${WOC_BASE}/address/${addr}/unspent`)
  if (!r.ok) throw new Error(`WoC unspent ${addr}: ${r.status}`)
  return await r.json() as WocUtxo[]
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

async function fetchTxHex(txid: string): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(`${WOC_BASE}/tx/${txid}/hex`)
    if (r.ok) return (await r.text()).trim()
    if (r.status === 429 || r.status >= 500) {
      await sleep(500 * (attempt + 1) + Math.random() * 300)
      continue
    }
    throw new Error(`WoC tx hex ${txid}: ${r.status}`)
  }
  throw new Error(`WoC tx hex ${txid}: gave up after retries`)
}

async function mapLimit<T, U>(items: T[], limit: number, fn: (x: T, i: number) => Promise<U>): Promise<U[]> {
  const out: U[] = new Array(items.length)
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++
      if (idx >= items.length) return
      out[idx] = await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return out
}

async function main() {
  const walletsPath = path.resolve('.wallets.json')
  const wallets = JSON.parse(fs.readFileSync(walletsPath, 'utf8'))
  const w = wallets[WALLET]
  if (!w) throw new Error(`wallet '${WALLET}' not in .wallets.json`)

  const key = PrivateKey.fromHex(w.hex)
  const address: string = w.address
  console.log(`[consolidate] wallet=${WALLET} addr=${address} network=${NETWORK}`)

  const all = await fetchUnspent(address)
  const total = all.reduce((s, u) => s + u.value, 0)
  console.log(`[consolidate] WoC reports ${all.length} UTXOs, total ${total} sat`)

  // Filter and pick the LARGEST first (more value per byte of input).
  const economical = all
    .filter(u => u.value >= MIN_SAT && u.height > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, MAX_INPUTS)

  const skipped = all.length - economical.length
  const sumIn = economical.reduce((s, u) => s + u.value, 0)
  console.log(`[consolidate] using ${economical.length} UTXOs (${sumIn} sat), skipped ${skipped} (dust < ${MIN_SAT} or unconfirmed)`)
  if (economical.length === 0) {
    console.log('[consolidate] nothing to consolidate, exiting')
    return
  }

  // Fetch parent tx hex for each (mined → WoC reliable). Concurrency 5.
  console.log(`[consolidate] fetching ${economical.length} parent tx hexes…`)
  const hexes = await mapLimit(economical, 2, async (u) => {
    return { u, hex: await fetchTxHex(u.tx_hash) }
  })

  // Build the consolidation tx
  const tx = new Transaction()
  for (const { u, hex } of hexes) {
    const parent = Transaction.fromHex(hex)
    tx.addInput({
      sourceTransaction: parent,
      sourceOutputIndex: u.tx_pos,
      unlockingScriptTemplate: new P2PKH().unlock(key),
    })
  }
  tx.addOutput({
    lockingScript: new P2PKH().lock(address),
    change: true,
  })
  await tx.fee()
  await tx.sign()

  const txid = tx.id('hex') as string
  const rawHex = tx.toHex()
  const out = tx.outputs[0]
  const outValue = out?.satoshis ?? 0
  const fee = sumIn - outValue
  console.log(`[consolidate] built tx ${txid}`)
  console.log(`[consolidate]   inputs:  ${economical.length} → ${sumIn} sat`)
  console.log(`[consolidate]   output:  1 → ${outValue} sat (back to ${address})`)
  console.log(`[consolidate]   fee:     ${fee} sat (${(rawHex.length / 2)} bytes raw)`)

  if (DRY_RUN) {
    console.log('[consolidate] DRY_RUN set, not broadcasting')
    return
  }

  console.log('[consolidate] broadcasting via ARC…')
  const result = await arcBroadcast(rawHex, NETWORK)
  if (!result.txid && !result.alreadyKnown) {
    throw new Error(`ARC accepted but returned no txid (status ${result.status})`)
  }
  console.log(`[consolidate] ✅ broadcast ok via ${result.endpoint}`)
  console.log(`[consolidate]    https://${NETWORK === 'test' ? 'test.' : ''}whatsonchain.com/tx/${txid}`)
}

main().catch(e => {
  console.error('[consolidate] FAILED:', e?.message ?? e)
  process.exit(1)
})
