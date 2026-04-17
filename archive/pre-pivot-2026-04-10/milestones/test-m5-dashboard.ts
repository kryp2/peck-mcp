/**
 * M5 — Live dashboard E2E.
 *
 * Boots: seller worker, gateway (with UTXOManager), dashboard server.
 * Generates a steady stream of inference requests so the dashboard shows
 * live activity. Open http://localhost:8080 in a browser.
 *
 * Run with: timeout 60 npx tsx src/test-m5-dashboard.ts
 * Or set ROUNDS env var.
 */
import { PrivateKey } from '@bsv/sdk'
import { readFileSync } from 'fs'
import { UTXOManager } from './utxo-manager.js'
import { Gateway } from './gateway.js'
import { ComputeWorker } from './worker.js'
import { startDashboard } from './dashboard.js'

const GW_PORT = 3000
const W_PORT = 4001
const DASH_PORT = 8080
const ROUNDS = parseInt(process.env.ROUNDS || '10', 10)
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS || '1500', 10)

async function main() {
  const wallets = JSON.parse(readFileSync('.wallets.json', 'utf-8'))

  // Seller
  const sellerKey = PrivateKey.fromHex(wallets.worker1.hex)
  new ComputeWorker({
    name: 'echo-1', key: sellerKey, port: W_PORT, backend: 'echo', pricePerJob: 100,
  }).start()
  await new Promise(r => setTimeout(r, 300))

  // Gateway
  const gwKey = PrivateKey.fromHex(wallets.gateway.hex)
  const utxoMgr = new UTXOManager(gwKey, 'test')
  console.log('Syncing gateway UTXOs…')
  await utxoMgr.initialSync()
  console.log('balance:', utxoMgr.balance)

  const gw = new Gateway(gwKey, utxoMgr)
  gw.registerWorker({
    id: 'echo-1', name: 'echo-1',
    publicKey: sellerKey.toPublicKey().toString(),
    address: wallets.worker1.address,
    endpoint: `http://localhost:${W_PORT}/infer`,
    pricePerJob: 100, avgLatencyMs: 0, failCount: 0, lastSeen: 0,
  })
  await gw.start(GW_PORT)

  // Dashboard
  startDashboard(gw, DASH_PORT)
  console.log(`\n👉 Open http://localhost:${DASH_PORT} in a browser to watch live\n`)

  // Local SSE listener (verifies events fire)
  let seenEvents = 0
  gw.events.on('event', (ev) => {
    seenEvents++
    console.log(`[event #${seenEvents}]`, ev.type, ev.type === 'payment' ? ev.txid : ev.jobNumber)
  })

  // Traffic generator
  await new Promise(r => setTimeout(r, 800))
  for (let i = 1; i <= ROUNDS; i++) {
    try {
      const r = await fetch(`http://localhost:${GW_PORT}/infer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: `m5 round ${i}` }),
      })
      const d = await r.json() as any
      console.log(`round ${i}: ${d.response?.slice(0, 50)}`)
    } catch (e) {
      console.error(`round ${i} fail:`, e)
    }
    await new Promise(r => setTimeout(r, INTERVAL_MS))
  }

  // Wait for last payments to flush
  console.log('\nWaiting 5s for payment processor to flush…')
  await new Promise(r => setTimeout(r, 5000))

  console.log('\nFinal stats:', gw.stats)
  console.log(`Total events emitted: ${seenEvents}`)
  console.log(`Expected ~${ROUNDS * 2} (job + payment per round)`)
  process.exit(0)
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })
