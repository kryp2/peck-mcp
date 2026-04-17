/**
 * Sustained throughput test — real BRC-100 end-to-end.
 *
 * Spawns N buyer wallets in parallel, each running an independent loop
 * that fires HTTP-402 → createAction → BEEF → internalize against a
 * cheap target service. Measures aggregate TPS over a fixed duration.
 *
 * Each wallet's createAction serializes on its own SQLite, so the only
 * way to scale TPS is horizontal parallelism across wallets.
 *
 * Prereqs:
 *   - brc-marketplace-daemon running (registry on :8080 + 9 services)
 *   - All buyer wallets funded
 *
 * Usage:
 *   npx tsx src/test-throughput.ts < /dev/null
 *   DURATION_S=30 TARGET=wasm-compute CAPABILITY=execute \
 *     npx tsx src/test-throughput.ts < /dev/null
 */
import 'dotenv/config'
import { BrcClient } from './brc-client.js'
import { listAgents } from './peckpay-wallet.js'

const REGISTRY_URL = process.env.REGISTRY_URL || 'http://localhost:8080'
const DURATION_S  = parseInt(process.env.DURATION_S  || '20', 10)
const WARMUP_S    = parseInt(process.env.WARMUP_S    || '3',  10)
const TARGET      = process.env.TARGET      || 'wasm-compute'
const CAPABILITY  = process.env.CAPABILITY  || 'execute'

interface Catalog {
  id: string
  endpoint: string
  capabilities: string[]
  pricePerCall: number
  identityKey: string
}

// Cheap, deterministic body for the chosen capability.
function bodyFor(svcId: string, cap: string): any {
  if (cap === 'execute' && svcId === 'wasm-compute') {
    return {
      wasm_base64: 'AGFzbQEAAAABBwFgAn9/AX8DAgEABwcBA2FkZAAACgkBBwAgACABags=',
      function_name: 'add',
      args: [1, 2],
    }
  }
  if (cap === 'execute' && svcId === 'evm-compute') {
    return { bytecode: '60056007016000526020600000f3' }
  }
  if (cap === 'get-weather') return { location: 'Oslo' }
  if (cap === 'crypto-price') return { coins: ['bitcoin'], currencies: ['usd'] }
  if (cap === 'recent') return { limit: 1 }
  if (cap === 'stats')  return {}
  throw new Error(`no body recipe for ${svcId}/${cap}`)
}

interface Stats {
  ok: number
  err: number
  totalLatencyMs: number
}

async function buyerLoop(
  walletName: string,
  endpoint: string,
  capability: string,
  body: any,
  stats: Stats,
  stopAt: number,
  startAt: number,
): Promise<void> {
  let client: BrcClient
  try {
    client = new BrcClient(walletName)
    await client.ready()
  } catch (e: any) {
    console.error(`  ${walletName}: failed to init wallet: ${e.message || e}`)
    return
  }

  while (Date.now() < stopAt) {
    const t0 = Date.now()
    try {
      await client.call(endpoint, capability, body)
      const dt = Date.now() - t0
      // Only count post-warmup work
      if (Date.now() >= startAt) {
        stats.ok++
        stats.totalLatencyMs += dt
      }
    } catch (e: any) {
      if (Date.now() >= startAt) stats.err++
      // Brief backoff so a broken wallet doesn't pin a CPU
      await new Promise(r => setTimeout(r, 50))
    }
  }
}

async function main() {
  console.log(`=== sustained BRC-100 throughput test ===`)
  console.log(`  target:    ${TARGET}/${CAPABILITY}`)
  console.log(`  warmup:    ${WARMUP_S}s`)
  console.log(`  duration:  ${DURATION_S}s`)
  console.log(`  registry:  ${REGISTRY_URL}`)
  console.log()

  // Fetch catalog
  const r = await fetch(`${REGISTRY_URL}/marketplace`)
  if (!r.ok) throw new Error(`registry not reachable at ${REGISTRY_URL} (HTTP ${r.status})`)
  const catalog = await r.json() as Catalog[]
  const target = catalog.find(s => s.id === TARGET)
  if (!target) throw new Error(`service '${TARGET}' not in catalog. available: ${catalog.map(s => s.id).join(', ')}`)
  if (!target.capabilities.includes(CAPABILITY)) {
    throw new Error(`service '${TARGET}' has no capability '${CAPABILITY}'. has: ${target.capabilities.join(', ')}`)
  }
  console.log(`  service ok: ${target.id} → ${target.endpoint} @ ${target.pricePerCall} sat/call`)

  // Pick all wallets EXCEPT the target itself (a wallet paying itself
  // would be a no-op derivation). Everyone else fires at the target.
  const allAgents = listAgents()
  const onlyBuyers = process.env.BUYERS  // comma-separated override
  const buyers = onlyBuyers
    ? onlyBuyers.split(',').map(s => s.trim()).filter(Boolean)
    : allAgents.filter(n => n !== TARGET)
  console.log(`  buyers (${buyers.length}): ${buyers.join(', ')}`)
  console.log()

  const body = bodyFor(TARGET, CAPABILITY)
  const stats: Stats = { ok: 0, err: 0, totalLatencyMs: 0 }

  const t0 = Date.now()
  const startAt = t0 + WARMUP_S * 1000
  const stopAt  = startAt + DURATION_S * 1000

  // Per-second progress
  let lastOk = 0
  const tick = setInterval(() => {
    const now = Date.now()
    const phase = now < startAt ? 'warmup' : 'measure'
    const delta = stats.ok - lastOk
    lastOk = stats.ok
    const elapsedMeasure = Math.max(0, (now - startAt) / 1000)
    const avgTps = elapsedMeasure > 0 ? (stats.ok / elapsedMeasure).toFixed(1) : '—'
    const avgLat = stats.ok > 0 ? (stats.totalLatencyMs / stats.ok).toFixed(0) : '—'
    console.log(`  [${phase}] +${delta.toString().padStart(3)}/s  total ok=${stats.ok} err=${stats.err}  avgTPS=${avgTps}  avgLat=${avgLat}ms`)
  }, 1000)

  // Launch all buyers concurrently
  await Promise.all(
    buyers.map(name => buyerLoop(name, target.endpoint, CAPABILITY, body, stats, stopAt, startAt))
  )

  clearInterval(tick)

  const tps = stats.ok / DURATION_S
  const avgLat = stats.ok > 0 ? (stats.totalLatencyMs / stats.ok).toFixed(0) : '—'
  console.log()
  console.log(`=== RESULT ===`)
  console.log(`  buyers in parallel: ${buyers.length}`)
  console.log(`  successful calls:   ${stats.ok}`)
  console.log(`  failed calls:       ${stats.err}`)
  console.log(`  duration:           ${DURATION_S}s`)
  console.log(`  sustained TPS:      ${tps.toFixed(1)}`)
  console.log(`  avg latency:        ${avgLat}ms (per call, end-to-end)`)
  console.log(`  per-buyer TPS:      ${(tps / buyers.length).toFixed(2)}`)
  console.log(`  hackathon target:   17 TPS sustained (1.5M tx / 24h)`)
  console.log(`  status:             ${tps >= 17 ? '✅ PASS' : '❌ below target'}`)
  console.log(`  100+ TPS goal:      ${tps >= 100 ? '✅ HIT' : `${tps.toFixed(0)}/100`}`)
  process.exit(0)
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })
