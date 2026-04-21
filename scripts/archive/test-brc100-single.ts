/**
 * test-brc100-single.ts — probe native BRC-100 via bank.peck.to.
 *
 * Uses Setup.createWalletClientNoEnv to open a per-agent wallet-toolbox
 * Wallet whose storage lives in bank.peck.to. No local SQLite, no WoC.
 * BRC-104 mutual auth happens on every RPC against the StorageServer.
 *
 * Usage:  npx tsx scripts/test-brc100-single.ts [agent=curator-tech]
 */
import 'dotenv/config'
import { SetupClient, Setup } from '@bsv/wallet-toolbox'
import { PrivateKey } from '@bsv/sdk'
import { readFileSync } from 'fs'

const AGENT = process.argv[2] || 'curator-tech'
const STORAGE_URL = process.env.BANK_URL || 'https://bank.peck.to'
const REGISTRY_FILE = '.brc-identities.json'

async function main() {
  const reg = JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'))
  const ident = reg[AGENT]
  if (!ident) { console.error(`No identity for "${AGENT}"`); process.exit(1) }

  const privKey = PrivateKey.fromHex(ident.privKeyHex)
  const pub = privKey.toPublicKey().toString()
  const addr = privKey.toAddress('mainnet') as string

  console.log(`[brc100] agent: ${AGENT}`)
  console.log(`[brc100] identityKey: ${pub}`)
  console.log(`[brc100] identity-address (P2PKH): ${addr}`)
  console.log(`[brc100] storage: ${STORAGE_URL}`)
  console.log()

  console.log(`[brc100] opening wallet...`)
  const wallet = await SetupClient.createWalletClientNoEnv({
    chain: 'main',
    rootKeyHex: ident.privKeyHex,
    storageUrl: STORAGE_URL,
  })
  console.log(`[brc100] wallet opened ✓`)

  console.log(`[brc100] listOutputs(basket=default)...`)
  const outputs = await wallet.listOutputs({ basket: 'default', limit: 100 })
  console.log(`[brc100]   totalOutputs=${outputs.totalOutputs}`)
  const spendable = outputs.outputs.filter(o => o.spendable)
  const balance = spendable.reduce((s, o) => s + o.satoshis, 0)
  console.log(`[brc100]   spendable=${spendable.length} balance=${balance} sat`)

  if (balance === 0) {
    console.log()
    console.log(`[brc100] ❌ zero balance — need funding`)
    console.log()
    console.log(`=== FUND VIA BRC-29 PAYMENT ===`)
    console.log(`recipient identityKey: ${pub}`)
    console.log(`NOTE: sending raw sats to ${addr} will NOT be picked up`)
    console.log(`      — must be a BRC-29 payment tx that wallet-toolbox internalizes.`)
    console.log()
    console.log(`Run:  npx tsx scripts/fund-one-brc29.ts ${AGENT} 50000`)
    process.exit(2)
  }

  console.log(`[brc100] ✓ wallet has funds — ready for createAction test`)
}

main().catch(e => {
  console.error(`[brc100] FAIL:`, e.message || e)
  process.exit(1)
})
