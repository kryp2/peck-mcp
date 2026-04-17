import 'dotenv/config'
import { getWallet, listAgents } from './peckpay-wallet.js'

async function main() {
  let total = 0
  for (const name of listAgents()) {
    const setup = await getWallet(name)
    const r = await setup.wallet.listOutputs({ basket: 'default', limit: 1000 }, 'peckpay.local')
    const sum = r.outputs.reduce((s: number, o: any) => s + o.satoshis, 0)
    total += sum
    console.log(`  ${name.padEnd(15)} ${sum.toString().padStart(6)} sat  (${r.outputs.length} outputs)`)
  }
  console.log(`  ${'─'.repeat(15)} ${'─'.repeat(6)}`)
  console.log(`  ${'TOTAL'.padEnd(15)} ${total.toString().padStart(6)} sat`)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
