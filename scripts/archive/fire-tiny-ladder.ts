/**
 * Fire all available leaves from the tiny ladder.
 *
 * Each leaf is consumed in a 1-in-1-out tx that sends PAYMENT_SATS to a
 * recipient address. The remainder (leaf - payment) becomes the miner fee.
 * Default recipient: worker2 from .wallets.json (any valid testnet addr works).
 *
 * Run:
 *   npx tsx scripts/fire-tiny-ladder.ts < /dev/null
 *
 * Knobs:
 *   PAYMENT_SATS=200    sat per shot to recipient (must be < LEAF_SATS)
 *   CONCURRENCY=5       parallel rifles (1 = sequential)
 *   RECIPIENT=worker2   wallet name in .wallets.json to receive payments
 */
import 'dotenv/config'
import { readFileSync } from 'fs'
import { PrivateKey } from '@bsv/sdk'
import { LadderDB } from '../src/ladder/db.js'
import { PaymentRifle } from '../src/ladder/rifle.js'
import { arcEndpointInfo } from '../src/ladder/arc.js'

const NETWORK: 'test' | 'main' = (process.env.NETWORK as any) || 'test'
const OWNER_AGENT = process.env.OWNER_AGENT || 'worker1'
const PAYMENT_SATS = parseInt(process.env.PAYMENT_SATS || '200', 10)
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5', 10)
const RECIPIENT_NAME = process.env.RECIPIENT || 'worker2'
const DB_PATH = process.env.LADDER_DB || '.ladder-state/leaves.db'

async function main() {
  console.log(`=== Fire tiny ladder ===`)
  console.log(`  network:     ${NETWORK}`)
  console.log(`  arc:         ${arcEndpointInfo(NETWORK)}`)
  console.log(`  owner:       ${OWNER_AGENT}`)
  console.log(`  payment:     ${PAYMENT_SATS} sat / shot`)
  console.log(`  concurrency: ${CONCURRENCY}`)
  console.log(`  db:          ${DB_PATH}`)

  const wallets = JSON.parse(readFileSync('.wallets.json', 'utf-8'))
  if (!wallets[OWNER_AGENT]) throw new Error(`no wallet '${OWNER_AGENT}' in .wallets.json`)
  if (!wallets[RECIPIENT_NAME]) throw new Error(`no wallet '${RECIPIENT_NAME}' in .wallets.json`)
  const ownerKey = PrivateKey.fromHex(wallets[OWNER_AGENT].hex)
  const recipientAddress = wallets[RECIPIENT_NAME].address
  console.log(`  recipient:   ${RECIPIENT_NAME} ${recipientAddress}`)
  console.log()

  const db = new LadderDB(DB_PATH)
  await db.init()

  const rifle = new PaymentRifle({
    agentName: OWNER_AGENT,
    ownerKey,
    network: NETWORK,
    db,
  })

  const initialAmmo = await rifle.remainingAmmo()
  if (initialAmmo === 0) {
    console.log(`  no leaves available — run scripts/build-tiny-ladder.ts first`)
    await db.close()
    process.exit(0)
  }
  console.log(`  starting ammo: ${initialAmmo} leaves`)
  console.log()

  const results: { ok: number; err: number; latencies: number[]; errors: string[] } = {
    ok: 0, err: 0, latencies: [], errors: [],
  }

  const t0 = Date.now()

  // Concurrency = N parallel workers, each fires until ammo runs out
  async function worker(workerId: number) {
    while (true) {
      try {
        const r = await rifle.fire(recipientAddress, PAYMENT_SATS)
        results.ok++
        results.latencies.push(r.durationMs)
        console.log(
          `  [w${workerId}] #${results.ok.toString().padStart(3)} ✅ ${r.durationMs.toString().padStart(4)}ms  ` +
          `leaf=${r.shotLeaf.txid.slice(0, 12)}…:${r.shotLeaf.vout}  ` +
          `tx=${r.txid.slice(0, 12)}…  fee=${r.feeSats}sat`
        )
      } catch (e: any) {
        const msg = String(e?.message || e)
        if (msg.includes('out of ammo')) return
        results.err++
        results.errors.push(msg.slice(0, 200))
        console.log(`  [w${workerId}] ❌ ${msg.slice(0, 150)}`)
        if (msg.includes('ARC')) {
          // Don't hammer ARC if it's rejecting
          await new Promise(r => setTimeout(r, 500))
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1))
  )

  const elapsed = (Date.now() - t0) / 1000
  const tps = results.ok / elapsed
  const avgLat = results.latencies.length > 0
    ? Math.round(results.latencies.reduce((a, b) => a + b, 0) / results.latencies.length)
    : 0
  const minLat = results.latencies.length > 0 ? Math.min(...results.latencies) : 0
  const maxLat = results.latencies.length > 0 ? Math.max(...results.latencies) : 0

  console.log()
  console.log(`=== RESULT ===`)
  console.log(`  shots fired:    ${results.ok}`)
  console.log(`  shots failed:   ${results.err}`)
  console.log(`  duration:       ${elapsed.toFixed(2)}s`)
  console.log(`  TPS:            ${tps.toFixed(2)} (${CONCURRENCY} parallel rifles)`)
  console.log(`  latency:        avg=${avgLat}ms  min=${minLat}ms  max=${maxLat}ms`)
  if (results.errors.length > 0) {
    console.log()
    console.log(`  first errors:`)
    for (const e of results.errors.slice(0, 5)) console.log(`    - ${e}`)
  }

  const finalStats = await db.stats(OWNER_AGENT)
  console.log()
  console.log(`  ladder remaining: ${finalStats.remaining}/${finalStats.total} leaves`)

  await db.close()
  process.exit(0)
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })
