/**
 * M7 stress test: sustained chained broadcast through TAAL ARC.
 *
 * Discovers a fresh unspent UTXO, then chains N txs through ARC
 * sequentially (and optionally in parallel batches).
 *
 * Run: node --env-file=.env --import tsx src/test-m7-stress.ts
 */
import { PrivateKey, Transaction } from '@bsv/sdk'
import { readFileSync } from 'fs'
import { UTXOManager } from './utxo-manager.js'

const N = parseInt(process.env.N || '20', 10)
const PARALLEL = parseInt(process.env.PARALLEL || '1', 10)

async function pickFreshUtxo(address: string): Promise<{ txid: string; vout: number; sats: number }> {
  const r = await fetch(`https://api.whatsonchain.com/v1/bsv/test/address/${address}/unspent`)
  const list = await r.json() as Array<{ tx_hash: string; tx_pos: number; value: number; height: number }>
  // Prefer the most recent (mempool, height=0) since we just broadcast — those
  // are guaranteed not double-spent. Largest within mempool first.
  const mempool = list.filter(u => u.height === 0).sort((a, b) => b.value - a.value)
  if (mempool.length > 0) return { txid: mempool[0].tx_hash, vout: mempool[0].tx_pos, sats: mempool[0].value }
  // Else: largest confirmed
  list.sort((a, b) => b.value - a.value)
  return { txid: list[0].tx_hash, vout: list[0].tx_pos, sats: list[0].value }
}

async function main() {
  if (!process.env.TAAL_TESTNET_KEY) {
    console.error('Set TAAL_TESTNET_KEY in .env'); process.exit(1)
  }
  const wallets = JSON.parse(readFileSync('.wallets.json', 'utf-8'))
  const key = PrivateKey.fromHex(wallets.gateway.hex)
  const mgr = new UTXOManager(key, 'test')

  const seed = await pickFreshUtxo(wallets.gateway.address)
  console.log(`seed: ${seed.txid}:${seed.vout} = ${seed.sats} sat`)

  const txr = await fetch(`https://api.whatsonchain.com/v1/bsv/test/tx/${seed.txid}/hex`)
  const sourceTx = Transaction.fromHex((await txr.text()).trim())
  mgr.addFromTx(sourceTx, seed.txid, seed.vout, seed.sats)

  console.log(`\n=== TAAL ARC sustained chain × ${N} (parallel=${PARALLEL}) ===`)
  let ok = 0, fail = 0
  const errors: string[] = []
  const t0 = Date.now()

  if (PARALLEL === 1) {
    for (let i = 0; i < N; i++) {
      try {
        const { tx } = await mgr.buildTx(wallets.worker1.address, 1, { i, kind: 'm7-stress' })
        await mgr.broadcastNow(tx)
        ok++
      } catch (e) {
        fail++
        const msg = String(e).slice(0, 120)
        if (errors.length < 3) errors.push(msg)
      }
    }
  } else {
    // Build sequentially (must — chain order), broadcast in parallel batches
    const txs: any[] = []
    for (let i = 0; i < N; i++) {
      try {
        const { tx } = await mgr.buildTx(wallets.worker1.address, 1, { i, kind: 'm7-stress-par' })
        txs.push(tx)
      } catch (e) {
        console.error(`build crash at iteration ${i}:`, String(e).slice(0, 200))
        console.error('mgr stats:', mgr.stats())
        throw e
      }
    }
    console.log(`built ${txs.length} txs in ${Date.now() - t0}ms, broadcasting…`)
    for (let i = 0; i < txs.length; i += PARALLEL) {
      const slice = txs.slice(i, i + PARALLEL)
      const results = await Promise.allSettled(slice.map(tx => mgr.broadcastNow(tx)))
      for (const r of results) {
        if (r.status === 'fulfilled') ok++
        else { fail++; if (errors.length < 3) errors.push(String(r.reason).slice(0, 120)) }
      }
    }
  }

  const ms = Date.now() - t0
  const tps = ok / (ms / 1000)
  console.log(`\n=== RESULT ===`)
  console.log(`  ${ok} ok / ${fail} fail in ${ms}ms`)
  console.log(`  → ${tps.toFixed(2)} TPS sustained on-chain`)
  console.log(`  → daily: ${Math.round(tps * 86400).toLocaleString()} tx/day`)
  console.log(`  hackathon target: ${tps >= 17 ? '✅' : '❌'} (need ≥17 TPS)`)
  if (errors.length) {
    console.log(`\nSample errors:`)
    errors.forEach(e => console.log(`  ${e}`))
  }
  process.exit(0)
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })
