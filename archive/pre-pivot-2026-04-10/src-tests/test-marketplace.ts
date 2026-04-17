/**
 * End-to-end marketplace smoke test.
 *
 * Boots the entire marketplace daemon in-process, then calls every
 * service through the gateway with sample bodies, verifies real
 * responses come back, captures payment txids.
 */
import { PrivateKey } from '@bsv/sdk'
import { readFileSync } from 'fs'
import { UTXOManager } from './utxo-manager.js'
import { Gateway } from './gateway.js'
import { CATALOG, makeWorkerInfo } from './service-catalog.js'

import './agents/weather.js'
import './agents/translate.js'
import './agents/summarize.js'
import './agents/price.js'
import './agents/geocode.js'
import './agents/evm-compute.js'
import './agents/wasm-compute.js'
import './agents/gas-oracle.js'
import './agents/metering.js'

const GW_PORT = 3050  // separate port to avoid conflict if daemon is running

async function main() {
  // Let services bind
  await new Promise(r => setTimeout(r, 1200))

  const wallets = JSON.parse(readFileSync('.wallets.json', 'utf-8'))
  const key = PrivateKey.fromHex(wallets.gateway.hex)
  const utxoMgr = new UTXOManager(key, 'test')
  await utxoMgr.initialSync({ confirmedOnly: true })

  const gw = new Gateway(key, utxoMgr)
  for (const entry of CATALOG) gw.registerWorker(makeWorkerInfo(entry))
  await gw.start(GW_PORT)

  await new Promise(r => setTimeout(r, 500))

  console.log(`\n=== Marketplace E2E test (${CATALOG.length} services) ===\n`)

  // List the marketplace via HTTP (proves the /marketplace endpoint works)
  const mr = await fetch(`http://localhost:${GW_PORT}/marketplace`)
  const market = await mr.json() as any[]
  console.log(`Gateway lists ${market.length} services on /marketplace`)
  for (const s of market) {
    console.log(`  • ${s.id.padEnd(15)} ${s.pricePerJob.toString().padStart(5)} sat  ${s.capabilities.join(', ')}`)
  }

  // Call each service via gateway /call
  let pass = 0, fail = 0
  for (const entry of CATALOG) {
    for (const cap of entry.capabilities) {
      const body = entry.examples[cap]
      if (!body) {
        console.log(`  ${entry.id}/${cap}: ⊘ no example, skip`)
        continue
      }
      process.stdout.write(`  ${entry.id}/${cap.padEnd(20)} `)
      try {
        const r = await fetch(`http://localhost:${GW_PORT}/call`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ service: entry.id, capability: cap, body }),
        })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const data = await r.json() as any
        pass++
        const snippet = JSON.stringify(data.result).slice(0, 90)
        console.log(`✅ ${data.latencyMs}ms  ${snippet}${snippet.length >= 90 ? '…' : ''}`)
      } catch (e) {
        fail++
        console.log(`❌ ${String(e).slice(0, 100)}`)
      }
    }
  }

  // Wait for background payment processor to broadcast a few payments
  console.log('\nWaiting 6s for payment processor to flush…')
  await new Promise(r => setTimeout(r, 6000))

  console.log(`\n=== RESULT ===`)
  console.log(`  ${pass} passed / ${fail} failed`)
  console.log(`  jobs completed:    ${gw.stats.jobsCompleted}`)
  console.log(`  txs broadcast:     ${gw.stats.txBroadcast}`)
  console.log(`  total paid:        ${gw.stats.totalPaid} sat`)
  console.log(`  last txid:         ${gw.stats.lastTxid || '—'}`)
  if (gw.stats.lastTxid) {
    console.log(`  https://test.whatsonchain.com/tx/${gw.stats.lastTxid}`)
  }

  process.exit(fail > 0 ? 1 : 0)
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })
