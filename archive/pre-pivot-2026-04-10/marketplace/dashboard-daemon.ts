/**
 * Dashboard daemon — keeps gateway + dashboard + worker running indefinitely
 * so a browser at http://localhost:8080 can watch live activity.
 *
 * Sends one inference request every INTERVAL_MS (default 3000ms).
 * Run with:  npx tsx src/dashboard-daemon.ts
 * Stop with: Ctrl+C
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
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS || '3000', 10)

async function main() {
  const wallets = JSON.parse(readFileSync('.wallets.json', 'utf-8'))

  const sellerKey = PrivateKey.fromHex(wallets.worker1.hex)
  new ComputeWorker({
    name: 'echo-1', key: sellerKey, port: W_PORT, backend: 'echo', pricePerJob: 100,
  }).start()
  await new Promise(r => setTimeout(r, 300))

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
  startDashboard(gw, DASH_PORT)

  console.log(`\n👉 Dashboard: http://localhost:${DASH_PORT}`)
  console.log(`   Sending one inference every ${INTERVAL_MS}ms. Ctrl+C to stop.\n`)

  let n = 0
  setInterval(async () => {
    n++
    try {
      const r = await fetch(`http://localhost:${GW_PORT}/infer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: `daemon round ${n} @ ${new Date().toISOString()}` }),
      })
      if (!r.ok) console.error(`round ${n}: HTTP ${r.status}`)
    } catch (e) {
      console.error(`round ${n} error:`, e)
    }
  }, INTERVAL_MS)
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })
