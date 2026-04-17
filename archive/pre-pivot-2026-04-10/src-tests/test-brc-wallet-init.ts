/**
 * Smoke test: initialize all 10 BRC-100 wallets and report their identity keys.
 */
import { getWallet, listAgents } from './peckpay-wallet.js'

async function main() {
  const agents = listAgents()
  console.log(`Initializing ${agents.length} BRC-100 wallets…\n`)

  for (const name of agents) {
    try {
      const t0 = Date.now()
      const setup = await getWallet(name)
      const ms = Date.now() - t0
      const ident = setup.identityKey
      console.log(`  ✅ ${name.padEnd(15)} ${ident.slice(0, 20)}…  (${ms}ms)`)
    } catch (e) {
      console.error(`  ❌ ${name.padEnd(15)} ${String(e).slice(0, 100)}`)
    }
  }

  console.log('\nAll wallets initialized.')
  process.exit(0)
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })
