/**
 * Concurrency sweep against an existing ladder. For each concurrency level
 * in the sweep, fires a fixed number of shots and measures sustained TPS.
 *
 * Pre-req: a built ladder with enough leaves to cover sum(BATCH_SIZES).
 *
 * Run:
 *   npx tsx scripts/sweep-ladder.ts < /dev/null
 */
import 'dotenv/config'
import { readFileSync } from 'fs'
import { PrivateKey } from '@bsv/sdk'
import { LadderDB } from '../src/ladder/db.js'
import { PaymentRifle } from '../src/ladder/rifle.js'
import { arcEndpointInfo } from '../src/ladder/arc.js'

const NETWORK: 'test' | 'main' = (process.env.NETWORK as any) || 'test'
const OWNER_AGENT = process.env.OWNER_AGENT || 'worker1'
const PAYMENT_SATS = parseInt(process.env.PAYMENT_SATS || '150', 10)
const RECIPIENT_NAME = process.env.RECIPIENT || 'worker2'
const DB_PATH = process.env.LADDER_DB || '.ladder-state/leaves.db'

// Concurrency levels to sweep, paired with how many shots to fire at each.
// Bigger batches at higher concurrency so each measurement is statistically
// meaningful (small batch with C=100 → workers starve before steady state).
const SWEEP: Array<{ concurrency: number; shots: number }> = [
  { concurrency: 25,  shots: 50 },
  { concurrency: 40,  shots: 60 },
  { concurrency: 50,  shots: 80 },
  { concurrency: 60,  shots: 80 },
  { concurrency: 75,  shots: 80 },
  { concurrency: 100, shots: 80 },
  { concurrency: 150, shots: 70 },
]

interface PhaseResult {
  concurrency: number
  shotsTarget: number
  shotsOk: number
  shotsErr: number
  durationS: number
  tps: number
  avgLatMs: number
  p50LatMs: number
  p95LatMs: number
  endpointHits: Record<string, number>
}

async function runPhase(
  rifle: PaymentRifle,
  recipientAddress: string,
  concurrency: number,
  shotsTarget: number,
): Promise<PhaseResult> {
  let ok = 0
  let err = 0
  const latencies: number[] = []
  const endpointHits: Record<string, number> = {}
  let stop = false

  const t0 = Date.now()

  async function worker() {
    while (!stop) {
      // Atomically claim a slot in this phase
      if (ok + err >= shotsTarget) return
      try {
        const r = await rifle.fire(recipientAddress, PAYMENT_SATS)
        ok++
        latencies.push(r.durationMs)
        endpointHits[r.endpoint] = (endpointHits[r.endpoint] || 0) + 1
      } catch (e: any) {
        const msg = String(e?.message || e)
        if (msg.includes('out of ammo')) { stop = true; return }
        err++
        if (msg.includes('ARC')) {
          await new Promise(r => setTimeout(r, 200))
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker))

  const durationS = (Date.now() - t0) / 1000
  latencies.sort((a, b) => a - b)
  const avgLatMs = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : 0
  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0

  return {
    concurrency,
    shotsTarget,
    shotsOk: ok,
    shotsErr: err,
    durationS,
    tps: ok / durationS,
    avgLatMs,
    p50LatMs: p50,
    p95LatMs: p95,
    endpointHits,
  }
}

async function main() {
  console.log(`=== Concurrency sweep ===`)
  console.log(`  network:    ${NETWORK}`)
  console.log(`  arc:        ${arcEndpointInfo(NETWORK)}`)
  console.log(`  owner:      ${OWNER_AGENT}`)
  console.log(`  payment:    ${PAYMENT_SATS} sat / shot`)
  console.log(`  db:         ${DB_PATH}`)

  const wallets = JSON.parse(readFileSync('.wallets.json', 'utf-8'))
  const ownerKey = PrivateKey.fromHex(wallets[OWNER_AGENT].hex)
  const recipientAddress = wallets[RECIPIENT_NAME].address
  console.log(`  recipient:  ${RECIPIENT_NAME} ${recipientAddress}`)
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
  const totalNeeded = SWEEP.reduce((s, p) => s + p.shots, 0)
  console.log(`  ammo:       ${initialAmmo} leaves available`)
  console.log(`  sweep:      ${SWEEP.map(p => `C=${p.concurrency}/${p.shots}`).join(' ')}`)
  console.log(`  total need: ${totalNeeded} shots`)
  console.log()

  if (initialAmmo < totalNeeded) {
    console.error(`  not enough ammo: need ${totalNeeded}, have ${initialAmmo}`)
    process.exit(1)
  }

  const results: PhaseResult[] = []
  for (const phase of SWEEP) {
    process.stdout.write(`  C=${phase.concurrency.toString().padStart(3)} ${phase.shots} shots… `)
    const r = await runPhase(rifle, recipientAddress, phase.concurrency, phase.shots)
    results.push(r)
    const epStr = Object.entries(r.endpointHits).map(([n, v]) => `${n}:${v}`).join(' ')
    console.log(
      `${r.shotsOk}✅/${r.shotsErr}❌  ${r.durationS.toFixed(2)}s  ` +
      `${r.tps.toFixed(1)} TPS  avg=${r.avgLatMs}ms p95=${r.p95LatMs}  [${epStr}]`
    )
    // brief gap between phases so latency tails settle
    await new Promise(r => setTimeout(r, 500))
  }

  console.log()
  console.log(`=== SUMMARY ===`)
  console.log(`  conc │ shots ok/err │ duration │  TPS  │ avg lat │ p50 │ p95`)
  console.log(`  ─────┼──────────────┼──────────┼───────┼─────────┼─────┼─────`)
  for (const r of results) {
    const tpsStr = r.tps.toFixed(1).padStart(5)
    console.log(
      `  ${r.concurrency.toString().padStart(4)} │ ${r.shotsOk.toString().padStart(4)}/${r.shotsErr.toString().padStart(3)}     │ ${r.durationS.toFixed(2).padStart(6)}s │ ${tpsStr} │ ${r.avgLatMs.toString().padStart(5)}ms │ ${r.p50LatMs.toString().padStart(3)} │ ${r.p95LatMs.toString().padStart(3)}`
    )
  }
  console.log()

  const peakTps = Math.max(...results.map(r => r.tps))
  const peakConc = results.find(r => r.tps === peakTps)?.concurrency
  console.log(`  peak TPS:    ${peakTps.toFixed(1)} at C=${peakConc}`)
  console.log(`  17 TPS bar:  ${peakTps >= 17 ? '✅ cleared' : '❌ not cleared'}`)
  console.log(`  100 TPS bar: ${peakTps >= 100 ? '✅ cleared' : '❌ not cleared'}`)
  console.log()
  console.log(`  daily capacity at peak: ${Math.round(peakTps * 86400).toLocaleString()} tx/day`)
  console.log(`  vs hackathon req:       1,500,000 tx/day`)
  console.log(`  → headroom factor:      ${(peakTps * 86400 / 1_500_000).toFixed(2)}×`)

  const finalStats = await db.stats(OWNER_AGENT)
  console.log()
  console.log(`  ammo remaining: ${finalStats.remaining}/${finalStats.total} leaves`)

  await db.close()
  process.exit(0)
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })
