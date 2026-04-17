/**
 * Deep inspect a wallet — list outputs across baskets, raw counts.
 */
import 'dotenv/config'
import { getWallet } from './peckpay-wallet.js'

async function main() {
  const name = process.argv[2] || 'gateway'
  const setup = await getWallet(name)

  // List baskets via raw knex query (we know this is StorageKnex with sqlite)
  const knex = (setup.activeStorage as any).knex
  if (!knex) { console.error('no knex on activeStorage'); process.exit(1) }

  const baskets = await knex('outputs').select('basket').count('* as count').groupBy('basket')
  console.log(`${name}: outputs per basket`)
  for (const b of baskets) console.log(`  ${(b.basket || '(none)').padEnd(20)} ${b.count}`)

  const total = await knex('outputs').sum('satoshis as total').count('* as count').where({ spendable: 1 })
  console.log(`\nspendable totals: ${JSON.stringify(total[0])}`)

  const top = await knex('outputs').select('basket', 'satoshis', 'txid', 'vout', 'spendable').orderBy('outputId', 'desc').limit(15)
  console.log(`\nlast 15 outputs:`)
  for (const o of top) console.log(`  ${(o.basket || '-').padEnd(15)} sats=${String(o.satoshis).padStart(6)} spendable=${o.spendable} ${String(o.txid).slice(0, 16)}…:${o.vout}`)
  process.exit(0)
}

main().catch(e => { console.error('FAIL:', e?.message || e); process.exit(1) })
