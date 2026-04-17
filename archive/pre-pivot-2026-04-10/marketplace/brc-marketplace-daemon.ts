/**
 * Pure BRC-100 marketplace daemon.
 *
 *   - MarketplaceRegistry on :8080  (catalog + SSE event feed + dashboard)
 *   - 9 BrcServiceAgents (each with own BRC-100 wallet, on its own port)
 *   - Each agent auto-announces to the registry on boot
 *   - Each successful BRC-100 payment posts an event to the registry
 *
 * No central payment router. Buyers go directly to each service.
 *
 * Run: npx tsx src/brc-marketplace-daemon.ts
 *      → open http://localhost:8080
 */
import 'dotenv/config'
import { MarketplaceRegistry } from './marketplace-registry.js'
import { BrcServiceAgent } from './brc-service-agent.js'

const REGISTRY_PORT = parseInt(process.env.REGISTRY_PORT || '8080', 10)
const REGISTRY_URL = `http://localhost:${REGISTRY_PORT}`

async function main() {
  console.log('=== BRC-100 marketplace daemon ===\n')

  // 1) Start registry first
  const registry = new MarketplaceRegistry()
  await registry.start(REGISTRY_PORT)

  // 2) Configure all BrcServiceAgents to point at the registry
  BrcServiceAgent.setRegistryUrl(REGISTRY_URL)

  // 3) Side-effect imports — each file constructs and starts its agent
  await import('./agents/weather.js')
  await import('./agents/translate.js')
  await import('./agents/summarize.js')
  await import('./agents/price.js')
  await import('./agents/geocode.js')
  await import('./agents/evm-compute.js')
  await import('./agents/wasm-compute.js')
  await import('./agents/gas-oracle.js')
  await import('./agents/metering.js')

  // 4) Wait for all to boot + announce
  await new Promise(r => setTimeout(r, 2500))
  console.log(`\n${registry.list().length} services announced.`)
  console.log(`\n👉 Dashboard: ${REGISTRY_URL}\n`)
  console.log(`Services in marketplace:`)
  for (const s of registry.list()) {
    console.log(`  • ${s.id.padEnd(15)} ${s.pricePerCall.toString().padStart(5)} sat  ${s.endpoint}  ${s.identityKey.slice(0, 18)}…`)
  }
  console.log(`\nDaemon running. Ctrl+C to stop.`)
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })
