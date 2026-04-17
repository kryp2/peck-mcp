/**
 * sweep-user-wallet.ts — sweep ALL spendable UTXOs from the user's
 * bank.peck.to BRC-100 wallet into fleet-funder.
 *
 * Lets wallet-infra broadcast via its own ARC provider. Requires
 * peck-wallet-infra Cloud Run to run with min-instances=1 so Monitor
 * stays alive between requests (otherwise reqs can get stuck as nosend).
 *
 * Reads user's privkey from ~/.peck/identity.json (never leaves this host).
 *
 * Usage:
 *   npx tsx scripts/sweep-user-wallet.ts [destination_addr=fleet-funder]
 */
import 'dotenv/config'
import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { SetupClient } from '@bsv/wallet-toolbox'
import { P2PKH } from '@bsv/sdk'

const DEST = process.argv[2] || '1HxHKNUwPMvWwX7CwcviDMvjP5FMDcx66X'
const BANK_URL = process.env.BANK_URL || 'https://bank.peck.to'
const IDENTITY_FILE = process.env.IDENTITY_FILE || join(homedir(), '.peck/identity.json')

async function main() {
  const ident = JSON.parse(readFileSync(IDENTITY_FILE, 'utf-8'))
  console.log(`[sweep] user: ${ident.address}`)
  console.log(`[sweep] dest: ${DEST}`)
  console.log(`[sweep] bank: ${BANK_URL}`)

  console.log(`[sweep] opening wallet...`)
  const wallet = await SetupClient.createWalletClientNoEnv({
    chain: 'main',
    rootKeyHex: ident.privateKeyHex,
    storageUrl: BANK_URL,
  })

  const outs = await wallet.listOutputs({ basket: 'default', limit: 1000 })
  const spendable = outs.outputs.filter(o => o.spendable)
  const balance = spendable.reduce((s, o) => s + o.satoshis, 0)
  console.log(`[sweep] spendable: ${spendable.length} UTXOs  total=${balance} sat`)
  if (balance < 1000) { console.error('nothing to sweep'); process.exit(1) }

  // Build an action with a single output (P2PKH to DEST) and let wallet-toolbox
  // pick inputs + compute change. wallet-infra broadcasts via its own ARC provider.
  const destLock = new P2PKH().lock(DEST)

  // Try sending nearly-everything. wallet-toolbox will leave a small change + fee.
  const sendAmount = Math.max(1, balance - 2000)  // reserve buffer for fee + dust
  console.log(`[sweep] createAction ${sendAmount} sat → ${DEST}`)

  const res = await wallet.createAction({
    description: `sweep to fleet-funder`,
    outputs: [{
      lockingScript: destLock.toHex(),
      satoshis: sendAmount,
      outputDescription: 'sweep output',
    }],
    options: { acceptDelayedBroadcast: false },
  })

  if (!res.txid) { console.error('[sweep] no txid returned', res); process.exit(1) }
  console.log(`[sweep] ✓ broadcast: ${res.txid}`)
  console.log(`[sweep] https://whatsonchain.com/tx/${res.txid}`)
}

main().catch(e => { console.error('[sweep] FAIL:', e.message || e); process.exit(1) })
