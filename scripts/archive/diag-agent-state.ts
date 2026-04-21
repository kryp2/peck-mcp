/**
 * diag-agent-state.ts — dump wallet-toolbox's view of an agent's state.
 *
 * Shows: UTXO inventory, recent actions (confirmed/sending/failed/nosend),
 * so we can see what wallet-infra THINKS happened vs what actually landed
 * on chain (the latter is visible via JungleBus cross-check).
 */
import 'dotenv/config'
import { readFileSync } from 'fs'
import { SetupClient } from '@bsv/wallet-toolbox'

const AGENT = process.argv[2] || 'curator-ethno'
const BANK_URL = process.env.BANK_URL || 'https://bank.peck.to'
const REGISTRY_FILE = '.brc-identities.json'

async function main() {
  const reg = JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'))
  const ident = reg[AGENT]
  if (!ident) { console.error(`no id for ${AGENT}`); process.exit(1) }

  const wallet = await SetupClient.createWalletClientNoEnv({
    chain: 'main', rootKeyHex: ident.privKeyHex, storageUrl: BANK_URL,
  })

  console.log(`[diag] agent: ${AGENT}`)

  console.log(`\n--- listOutputs(basket=default) ---`)
  const outs = await wallet.listOutputs({ basket: 'default', limit: 20 })
  console.log(`totalOutputs=${outs.totalOutputs}  returned=${outs.outputs.length}`)
  for (const o of outs.outputs) {
    console.log(`  spendable=${o.spendable}  satoshis=${o.satoshis}  outpoint=${o.outpoint}`)
  }

  console.log(`\n--- listActions (recent 20) ---`)
  const acts = await wallet.listActions({ labels: [], limit: 20 })
  console.log(`totalActions=${acts.totalActions}  returned=${acts.actions.length}`)
  for (const a of acts.actions) {
    console.log(`  status=${a.status.padEnd(10)}  satoshis=${String(a.satoshis).padStart(6)}  txid=${a.txid}  desc=${a.description?.slice(0, 40)}`)
  }
}

main().catch(e => { console.error('[diag] FAIL:', e.message || e); process.exit(1) })
