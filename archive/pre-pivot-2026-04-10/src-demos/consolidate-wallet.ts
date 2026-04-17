/**
 * Consolidate all spendable outputs in a BRC-100 wallet into a single
 * UTXO. Useful when an agent has accumulated dozens or hundreds of small
 * change outputs from past activity, which slows down createAction's
 * change-generation logic.
 *
 * Strategy: createAction with no outputs and let wallet-toolbox sweep
 * everything to the next change destination. The result is a single
 * (or near-single) consolidated UTXO.
 *
 * Run: npx tsx src/consolidate-wallet.ts <agentName>
 */
import 'dotenv/config'
import { getWallet } from './peckpay-wallet.js'

async function balance(setup: any): Promise<{ total: number; count: number }> {
  // wallet-toolbox stores change outputs in `null` basket which the public
  // listOutputs API hides. Query the raw outputs table for the truth.
  const knex = setup.activeStorage.knex
  const r = await knex('outputs').count('* as count').sum('satoshis as total').where('spendable', 1)
  return { total: Number(r[0].total) || 0, count: Number(r[0].count) || 0 }
}

async function main() {
  const name = process.argv[2]
  if (!name) {
    console.error('usage: npx tsx src/consolidate-wallet.ts <agentName>')
    process.exit(1)
  }

  const setup = await getWallet(name)
  const before = await balance(setup)
  console.log(`${name}: ${before.count} outputs / ${before.total} sat`)

  if (before.count <= 1) {
    console.log('already consolidated, nothing to do')
    process.exit(0)
  }

  // First lower numberOfDesiredUTXOs on the default basket so subsequent
  // change generation produces a single big output instead of 144 tiny ones.
  const knex = setup.activeStorage.knex
  await knex('output_baskets')
    .where({ name: 'default' })
    .update({ numberOfDesiredUTXOs: 1, minimumDesiredUTXOValue: 1000 })
  console.log('basket settings updated: numberOfDesiredUTXOs=1, minimumDesiredUTXOValue=1000')

  console.log(`\nConsolidating via createAction(no outputs)…`)
  const t0 = Date.now()
  const result = await setup.wallet.createAction({
    description: `consolidate ${name}`.slice(0, 50),
    outputs: [],
    options: {
      acceptDelayedBroadcast: false,
      randomizeOutputs: false,
    },
  })
  const ms = Date.now() - t0

  if (!result.txid) {
    console.error('createAction did not return a txid')
    console.error(JSON.stringify(result, null, 2))
    process.exit(1)
  }
  console.log(`✅ consolidated in ${ms}ms`)
  console.log(`   txid: ${result.txid}`)

  const after = await balance(setup)
  console.log(`\n${name}: ${after.count} outputs / ${after.total} sat`)
  console.log(`fees paid: ${before.total - after.total} sat`)
  process.exit(0)
}

main().catch(e => { console.error('FAIL:', e?.message || e); process.exit(1) })
