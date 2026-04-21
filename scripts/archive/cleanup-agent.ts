/**
 * cleanup-agent.ts — abort stuck actions and reconcile wallet-toolbox state.
 *
 * Aborts actions stuck in status=sending or status=unsigned so their
 * reserved UTXO inputs are released and the wallet can pick the real
 * on-chain spendable UTXOs again.
 *
 * Usage:
 *   npx tsx scripts/cleanup-agent.ts <agent-name>
 */
import 'dotenv/config'
import { readFileSync } from 'fs'
import { SetupClient } from '@bsv/wallet-toolbox'

const AGENT = process.argv[2]
if (!AGENT) { console.error('agent name required'); process.exit(1) }
const BANK_URL = process.env.BANK_URL || 'https://bank.peck.to'
const REGISTRY_FILE = '.brc-identities.json'

async function main() {
  const reg = JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'))
  const ident = reg[AGENT]
  if (!ident) { console.error(`no id for ${AGENT}`); process.exit(1) }
  const wallet = await SetupClient.createWalletClientNoEnv({
    chain: 'main', rootKeyHex: ident.privKeyHex, storageUrl: BANK_URL,
  })

  console.log(`[cleanup] ${AGENT} — scanning actions...`)
  const acts = await wallet.listActions({ labels: [], limit: 200 })
  const stuck = acts.actions.filter(a => a.status === 'sending' || a.status === 'unsigned' || a.status === 'nosend' || a.status === 'failed')
  console.log(`[cleanup] ${stuck.length} stuck actions (status in sending/unsigned/nosend/failed) out of ${acts.actions.length}`)

  let ok = 0, fail = 0
  for (const a of stuck) {
    try {
      const ref = a.reference
      if (!ref) { console.log(`  skip ${a.txid || '<unsigned>'} — no reference`); continue }
      const r = await wallet.abortAction({ reference: ref } as any)
      if (r.aborted) {
        console.log(`  ✓ aborted ${a.status.padEnd(9)} ${a.txid || '<unsigned>'}`)
        ok++
      } else {
        console.log(`  ❌ not aborted ${a.txid}`)
        fail++
      }
    } catch (e: any) {
      console.log(`  ❌ ${a.txid || '<unsigned>'}: ${(e.message || String(e)).slice(0, 100)}`)
      fail++
    }
  }
  console.log(`\n[cleanup] aborted: ${ok}  failed: ${fail}`)

  // Check final state
  const after = await wallet.listActions({ labels: [], limit: 200 })
  const sendAfter = after.actions.filter(a => a.status === 'sending' || a.status === 'unsigned' || a.status === 'nosend' || a.status === 'failed').length
  const outs = await wallet.listOutputs({ basket: 'default', limit: 20 })
  const spendable = outs.outputs.filter(o => o.spendable)
  console.log(`[cleanup] after: ${sendAfter} still stuck  |  ${spendable.length} spendable UTXOs totaling ${spendable.reduce((s, o) => s + o.satoshis, 0)} sat`)
}

main().catch(e => { console.error('[cleanup] FAIL:', e.message || e); process.exit(1) })
