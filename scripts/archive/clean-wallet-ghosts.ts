/**
 * Clean ghost records from a BRC-100 wallet's outputs table.
 *
 * "Ghosts" are wallet-toolbox records of outgoing P2P payments that the
 * wallet created (so it tracked them in its db) but cannot actually spend
 * (no unlock template). They linger as `spendable=1, change=0, type=custom`
 * and confuse balance queries even though createAction's input selection
 * correctly excludes them.
 *
 * This script marks them as `spendable=0` so the bookkeeping reflects
 * reality.
 *
 * Usage: npx tsx scripts/clean-wallet-ghosts.ts <agentName>
 */
import 'dotenv/config'
import { getWallet, listAgents } from '../src/peckpay-wallet.js'

async function cleanOne(name: string) {
  const setup = await getWallet(name)
  const knex = (setup.activeStorage as any).knex

  const real = await knex('outputs').count('* as c').sum('satoshis as t').where({ spendable: 1, change: 1 })
  const ghost = await knex('outputs').count('* as c').sum('satoshis as t').where({ spendable: 1, change: 0 })
  console.log(`${name}: REAL=${real[0].c}/${real[0].t || 0} sat   GHOSTS=${ghost[0].c}/${ghost[0].t || 0} sat`)

  if (ghost[0].c > 0) {
    const upd = await knex('outputs').update({ spendable: 0 }).where({ spendable: 1, change: 0, type: 'custom' })
    console.log(`  cleaned ${upd} ghost rows`)
  }
}

async function main() {
  const which = process.argv[2]
  const targets = which === 'all' || !which ? listAgents() : [which]
  for (const t of targets) await cleanOne(t)
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
