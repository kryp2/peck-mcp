/**
 * Standalone marketplace-registry bootstrap.
 *
 * Boots ONLY MarketplaceRegistry on $REGISTRY_PORT (default 8080) — no
 * legacy service-agents, no gateway, no dashboard daemon. Used by the
 * dag-3+ stack where all real agents live in their own processes and
 * just announce here.
 *
 * Run:
 *   REGISTRY_PORT=8080 npx tsx src/registry-daemon.ts < /dev/null
 */
import 'dotenv/config'
import { MarketplaceRegistry } from './marketplace-registry.js'

const PORT = parseInt(process.env.REGISTRY_PORT || '8080', 10)

const registry = new MarketplaceRegistry()
registry.onEvent((e) => {
  console.log('[registry-event]', e.type, e.service, e.detail || '')
})
await registry.start(PORT)
console.log(`[registry-daemon] listening on http://localhost:${PORT}  GET /marketplace  GET /events`)
