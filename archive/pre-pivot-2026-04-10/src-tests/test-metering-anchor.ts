/**
 * Demonstrates AP4E end-to-end:
 *   1. Call a handful of marketplace services
 *   2. Each call automatically records to the in-process metering engine
 *   3. Compute Merkle root over all un-anchored events
 *   4. Broadcast the root to BSV testnet via OP_RETURN ("AP4E" prefix)
 *   5. Verify a single event is included by re-computing the root
 *
 * The result: a tamper-proof on-chain proof of usage that any third
 * party can audit. Stripe can't do this — their database is mutable.
 */
import { PrivateKey } from '@bsv/sdk'
import { readFileSync } from 'fs'
import { UTXOManager } from './utxo-manager.js'
import { Gateway } from './gateway.js'
import { CATALOG, makeWorkerInfo } from './service-catalog.js'
import { metering } from './metering.js'

import './agents/weather.js'
import './agents/translate.js'
import './agents/price.js'
import './agents/geocode.js'
import './agents/gas-oracle.js'
import './agents/wasm-compute.js'
import './agents/metering.js'

const GW_PORT = 3060

async function callViaGateway(serviceId: string, capability: string, body: any) {
  const r = await fetch(`http://localhost:${GW_PORT}/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service: serviceId, capability, body }),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return await r.json() as any
}

async function main() {
  await new Promise(r => setTimeout(r, 1200))

  const wallets = JSON.parse(readFileSync('.wallets.json', 'utf-8'))
  const key = PrivateKey.fromHex(wallets.gateway.hex)
  const utxoMgr = new UTXOManager(key, 'test')
  await utxoMgr.initialSync({ confirmedOnly: true })

  const gw = new Gateway(key, utxoMgr)
  for (const entry of CATALOG) gw.registerWorker(makeWorkerInfo(entry))
  await gw.start(GW_PORT)
  await new Promise(r => setTimeout(r, 400))

  console.log('=== AP4E — tamper-proof metering anchor ===\n')

  // 1) Generate some real usage by calling several services
  console.log('Step 1: Generate usage events…')
  const calls: Array<[string, string, any]> = [
    ['weather', 'get-weather', { location: 'Oslo' }],
    ['translate', 'translate', { text: 'good morning', sourceLang: 'en', targetLang: 'no' }],
    ['price', 'crypto-price', { coins: ['bitcoin-cash-sv'], currencies: ['usd'] }],
    ['geocode', 'geocode', { location: 'Bergen' }],
    ['gas-oracle', 'savings-vs-bsv', { gasUsed: 50000 }],
    ['wasm-compute', 'execute', { wasm_base64: 'AGFzbQEAAAABBwFgAn9/AX8DAgEABwcBA2FkZAAACgkBBwAgACABags=', function_name: 'add', args: [10, 20] }],
  ]
  for (const [s, c, b] of calls) {
    const out = await callViaGateway(s, c, b)
    console.log(`  ${s}/${c} → paid ${out.paid} sat`)
  }

  // 2) Inspect metering state
  console.log(`\nStep 2: Metering state`)
  const stats = metering.stats()
  console.log(`  total events:      ${stats.total_events}`)
  console.log(`  next id:           ${stats.next_id}`)
  console.log(`  last anchored id:  ${stats.last_anchored_id}`)

  // 3) Prepare anchor
  console.log(`\nStep 3: Compute Merkle root over un-anchored events`)
  const anchor = metering.prepareAnchor()
  if (!anchor) { console.log('  nothing to anchor'); process.exit(1) }
  console.log(`  range:    ${anchor.start_id}–${anchor.end_id}  (${anchor.count} events)`)
  console.log(`  root:     ${anchor.root}`)

  // 4) Broadcast root to BSV via OP_RETURN
  console.log(`\nStep 4: Anchor root on-chain (OP_RETURN "AP4E" + root)`)
  const payload = JSON.stringify({
    p: 'AP4E',
    root: anchor.root,
    range: [anchor.start_id, anchor.end_id],
    count: anchor.count,
    ts: anchor.ts,
  })
  const { tx, txid } = await utxoMgr.buildAdvertTx('AP4E', payload)
  await utxoMgr.broadcastNow(tx)
  metering.recordAnchor(anchor, txid)
  console.log(`  ✅ anchor txid: ${txid}`)
  console.log(`     https://test.whatsonchain.com/tx/${txid}`)

  // 5) Verify a random event is contained in the anchor
  console.log(`\nStep 5: Verify a single event is in the anchor (re-compute root)`)
  const middleId = Math.floor((anchor.start_id + anchor.end_id) / 2)
  const ok = metering.verifyEventInAnchor(middleId, 0)
  console.log(`  verify event #${middleId} in anchor #0 → ${ok ? '✅' : '❌'}`)

  // 6) Show totals per service
  console.log(`\nStep 6: Per-service earnings (in-process accounting)`)
  const services = new Set<string>()
  for (const e of metering.recent(100)) services.add(e.service)
  for (const s of services) {
    console.log(`  ${s.padEnd(25)} ${metering.totalEarnedBy(s)} sat`)
  }

  console.log('\n=== AP4E SUCCESS — tamper-proof metering live on BSV ===')
  process.exit(ok ? 0 : 1)
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })
