/**
 * M2 E2E sanity test:
 *   - Boot worker1 (echo backend) on port 4001
 *   - Boot gateway on port 3000 with UTXOManager (gateway wallet)
 *   - POST /infer → gateway forwards to worker → worker echoes
 *   - Background payment processor builds + broadcasts payment TX
 *   - Verify txid via WoC
 */
import { PrivateKey } from '@bsv/sdk'
import { readFileSync } from 'fs'
import { UTXOManager } from './utxo-manager.js'
import { Gateway } from './gateway.js'
import { ComputeWorker } from './worker.js'

const GW_PORT = 3000
const W1_PORT = 4001

async function waitFor<T>(fn: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = fn()
    if (v) return v
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`Timeout waiting for ${label}`)
}

async function main() {
  const wallets = JSON.parse(readFileSync('.wallets.json', 'utf-8'))

  // 1. UTXOManager for gateway
  const gwKey = PrivateKey.fromHex(wallets.gateway.hex)
  const utxoMgr = new UTXOManager(gwKey, 'test')
  console.log('Syncing gateway UTXOs from WoC…')
  await utxoMgr.initialSync()
  console.log('Gateway:', utxoMgr.stats())

  // 2. Boot worker1
  const w1Key = PrivateKey.fromHex(wallets.worker1.hex)
  const worker = new ComputeWorker({
    name: 'worker1',
    key: w1Key,
    port: W1_PORT,
    backend: 'echo',
    pricePerJob: 100,
  })
  worker.start()

  // 3. Boot gateway, register worker1
  const gw = new Gateway(gwKey, utxoMgr)
  gw.registerWorker({
    id: 'w1',
    name: 'worker1',
    publicKey: w1Key.toPublicKey().toString(),
    address: wallets.worker1.address,
    endpoint: `http://localhost:${W1_PORT}/infer`,
    pricePerJob: 100,
    avgLatencyMs: 0,
    failCount: 0,
    lastSeen: 0,
  })
  await gw.start(GW_PORT)

  // 4. Wait for HTTP servers to settle
  await new Promise(r => setTimeout(r, 500))

  // 5. Send a single inference request
  console.log('\n→ POST /infer')
  const t0 = Date.now()
  const res = await fetch(`http://localhost:${GW_PORT}/infer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'hello agentic pay' }),
  })
  const data = await res.json() as any
  console.log(`← ${res.status} in ${Date.now() - t0}ms:`, data)

  if (!data.response) throw new Error('No response from gateway')

  // 6. Wait for background payment to broadcast
  console.log('\nWaiting for payment processor to broadcast…')
  const txid = await waitFor(
    () => gw.stats.lastTxid || undefined,
    15000,
    'lastTxid',
  )
  console.log(`✅ Payment broadcast txid: ${txid}`)
  console.log(`   Explorer: https://test.whatsonchain.com/tx/${txid}`)

  // 7. Verify via WoC
  await new Promise(r => setTimeout(r, 1500))
  const wocRes = await fetch(`https://api.whatsonchain.com/v1/bsv/test/tx/hash/${txid}`)
  console.log(`WoC verify: HTTP ${wocRes.status}`)
  if (wocRes.ok) {
    const txData = await wocRes.json() as any
    console.log(`   size=${txData.size} vin=${txData.vin?.length} vout=${txData.vout?.length}`)
  }

  console.log('\nFinal gateway stats:', gw.stats)
  console.log('Final UTXO stats:', utxoMgr.stats())
  process.exit(0)
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })
