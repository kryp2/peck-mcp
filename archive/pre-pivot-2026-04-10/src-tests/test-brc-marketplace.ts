/**
 * End-to-end smoke test for the pure BRC-100 marketplace.
 *
 *   - Boots registry + all 9 service-agents in-process
 *   - Uses gateway BRC wallet as the buyer (BrcClient)
 *   - Walks the marketplace catalog, calls one capability per service
 *   - Verifies each call goes through the full BRC-100 402 → createAction
 *     → internalize round trip
 */
import 'dotenv/config'
import { MarketplaceRegistry } from './marketplace-registry.js'
import { BrcServiceAgent } from './brc-service-agent.js'
import { BrcClient } from './brc-client.js'

const REGISTRY_PORT = 8090  // separate port to avoid collision with daemon

interface SmokeCase { capability: string; body: any }

const SMOKE_CASES: Record<string, SmokeCase> = {
  weather:       { capability: 'get-weather', body: { location: 'Trondheim' } },
  translate:     { capability: 'translate', body: { text: 'good morning agent', sourceLang: 'en', targetLang: 'no' } },
  price:         { capability: 'crypto-price', body: { coins: ['bitcoin-cash-sv'], currencies: ['usd', 'nok'] } },
  geocode:       { capability: 'geocode', body: { location: 'Bergen' } },
  'gas-oracle':  { capability: 'savings-vs-bsv', body: { gasUsed: 50000 } },
  'wasm-compute': { capability: 'execute', body: { wasm_base64: 'AGFzbQEAAAABBwFgAn9/AX8DAgEABwcBA2FkZAAACgkBBwAgACABags=', function_name: 'add', args: [42, 100] } },
  'evm-compute': { capability: 'execute', body: { bytecode: '60056007016000526020600000f3' } },
  summarize:     { capability: 'summarize-text', body: { text: 'Bitcoin SV restored the original Bitcoin protocol. It scales by removing the 1MB limit. Many companies use it for data anchoring. Transactions are very cheap. Blocks can be terabytes in size.' } },
  metering:      { capability: 'recent', body: { limit: 5 } },
}

async function main() {
  // 1. Start registry
  const registry = new MarketplaceRegistry()
  await registry.start(REGISTRY_PORT)
  BrcServiceAgent.setRegistryUrl(`http://localhost:${REGISTRY_PORT}`)

  // 2. Boot all 9 service agents
  await import('./agents/weather.js')
  await import('./agents/translate.js')
  await import('./agents/summarize.js')
  await import('./agents/price.js')
  await import('./agents/geocode.js')
  await import('./agents/evm-compute.js')
  await import('./agents/wasm-compute.js')
  await import('./agents/gas-oracle.js')
  await import('./agents/metering.js')

  await new Promise(r => setTimeout(r, 2500))

  const services = registry.list()
  console.log(`\n=== ${services.length} services in marketplace ===`)
  for (const s of services) {
    console.log(`  • ${s.id.padEnd(15)} ${s.pricePerCall.toString().padStart(5)} sat  ${s.identityKey.slice(0, 18)}…`)
  }

  // 3. Buyer: gateway BRC wallet
  const buyer = new BrcClient('gateway')
  await buyer.ready()
  console.log(`\nbuyer identity: ${buyer.identityKey.slice(0, 18)}…`)

  // 4. Walk catalog, pay for one capability per service
  console.log(`\n=== Round trip per service ===\n`)
  let pass = 0, fail = 0
  for (const svc of services) {
    const test = SMOKE_CASES[svc.id]
    if (!test) { console.log(`  ⊘ ${svc.id} (no smoke case)`); continue }

    process.stdout.write(`  ${svc.id}/${test.capability.padEnd(20)} `)
    try {
      const r = await buyer.call(svc.endpoint, test.capability, test.body)
      pass++
      console.log(`✅ ${r.durationMs}ms  paid=${r.price} sat  txid=${r.paymentTxid.slice(0, 16)}…`)
      const snippet = JSON.stringify(r.result).slice(0, 110)
      console.log(`     → ${snippet}${snippet.length >= 110 ? '…' : ''}`)
    } catch (e) {
      fail++
      console.log(`❌ ${String(e).slice(0, 150)}`)
    }
  }

  console.log(`\n=== RESULT ===`)
  console.log(`  ${pass} passed / ${fail} failed`)
  console.log(`  ${pass} real BRC-100 BEEF payments verified offline by receivers`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })
