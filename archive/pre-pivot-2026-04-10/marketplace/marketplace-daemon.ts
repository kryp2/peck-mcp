/**
 * Peck Pay Marketplace Daemon.
 *
 * One process boots:
 *   - All 9 ServiceAgents (each on its own port, with its own BSV wallet)
 *   - The M2 Gateway (with the funding gateway wallet)
 *   - All services registered in the gateway worker registry
 *   - The M5 Dashboard (SSE feed at http://localhost:8080)
 *
 * Then keeps the whole marketplace alive. Run with:
 *   npx tsx src/marketplace-daemon.ts
 *
 * Optional traffic generator (env-controlled): generates one inference
 * call to a random service every INTERVAL_MS ms.
 */
import { PrivateKey } from '@bsv/sdk'
import { readFileSync } from 'fs'
import { UTXOManager } from './utxo-manager.js'
import { Gateway } from './gateway.js'
import { startDashboard } from './dashboard.js'
import { CATALOG, makeWorkerInfo } from './service-catalog.js'

// Side-effect imports — each boots a ServiceAgent on its declared port
import './agents/weather.js'
import './agents/translate.js'
import './agents/summarize.js'
import './agents/price.js'
import './agents/geocode.js'
import './agents/evm-compute.js'
import './agents/wasm-compute.js'
import './agents/gas-oracle.js'
import './agents/metering.js'

const GW_PORT = parseInt(process.env.GW_PORT || '3000', 10)
const DASH_PORT = parseInt(process.env.DASH_PORT || '8080', 10)
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS || '0', 10)  // 0 = no traffic gen

async function main() {
  console.log('=== Peck Pay marketplace daemon ===\n')

  // Wait for all ServiceAgents to bind
  await new Promise(r => setTimeout(r, 1500))

  // Funding wallet (gateway pays workers from here)
  const wallets = JSON.parse(readFileSync('.wallets.json', 'utf-8'))
  const gwKey = PrivateKey.fromHex(wallets.gateway.hex)
  const utxoMgr = new UTXOManager(gwKey, 'test')

  console.log('Syncing gateway UTXOs from WoC…')
  await utxoMgr.initialSync({ confirmedOnly: true })
  console.log(`  balance: ${utxoMgr.balance} sat / ${utxoMgr.stats().utxoCount} confirmed UTXOs\n`)

  // Boot the gateway
  const gw = new Gateway(gwKey, utxoMgr)

  // Register every catalog entry as a service-kind worker
  for (const entry of CATALOG) {
    gw.registerWorker(makeWorkerInfo(entry))
  }
  console.log(`Registered ${CATALOG.length} services in gateway worker registry`)

  await gw.start(GW_PORT)
  startDashboard(gw, DASH_PORT)

  console.log(`\n👉 Marketplace API:`)
  console.log(`     GET  http://localhost:${GW_PORT}/marketplace   — list services`)
  console.log(`     POST http://localhost:${GW_PORT}/call          — { service, capability, body }`)
  console.log(`     GET  http://localhost:${GW_PORT}/stats         — gateway counters`)
  console.log(`👉 Dashboard:`)
  console.log(`     http://localhost:${DASH_PORT}`)

  if (INTERVAL_MS > 0) {
    console.log(`\nTraffic generator: 1 call every ${INTERVAL_MS}ms`)
    setInterval(async () => {
      const entry = CATALOG[Math.floor(Math.random() * CATALOG.length)]
      const cap = entry.capabilities[0]
      const body = entry.examples[cap] ?? {}
      try {
        const r = await fetch(`http://localhost:${GW_PORT}/call`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ service: entry.id, capability: cap, body }),
        })
        if (!r.ok) console.error(`call ${entry.id}/${cap}: HTTP ${r.status}`)
      } catch (e) {
        console.error(`call ${entry.id}/${cap}: ${e}`)
      }
    }, INTERVAL_MS)
  } else {
    console.log(`\n(Traffic generator disabled. Set INTERVAL_MS=2000 to enable.)`)
  }
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })
