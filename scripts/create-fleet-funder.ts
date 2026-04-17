/**
 * Generate a fresh P2PKH key for funding the curator fleet.
 * Writes .fleet-funder.json with privkey + address.
 *
 * You send 125,000+ sats from peck-desktop to the printed address,
 * then run: npx tsx scripts/fund-fleet-mainnet.ts
 *
 * Run: npx tsx scripts/create-fleet-funder.ts
 */
import { PrivateKey } from '@bsv/sdk'
import { writeFileSync, existsSync, readFileSync } from 'fs'

const FILE = '.fleet-funder.json'

function main() {
  if (existsSync(FILE)) {
    const d = JSON.parse(readFileSync(FILE, 'utf-8'))
    console.log('fleet-funder already exists:')
    console.log(`  address: ${d.address}`)
    console.log(`  pubkey:  ${d.pubkey.slice(0, 20)}…`)
    console.log(`  file:    ${FILE}`)
    console.log('\nto regenerate, delete the file first.')
    return
  }
  const k = PrivateKey.fromRandom()
  const data = {
    address: k.toAddress('mainnet') as string,
    pubkey: k.toPublicKey().toString(),
    privKeyHex: k.toString(),
    network: 'mainnet',
    createdAt: new Date().toISOString(),
    note: 'Source for BRC-29 mainnet funding of curator-fleet. NEVER commit.',
  }
  writeFileSync(FILE, JSON.stringify(data, null, 2), { mode: 0o600 })
  console.log(`fleet-funder created at ${FILE}`)
  console.log(`\nsend ≥125,000 sats (25 agents × 5,000) from peck-desktop to:\n`)
  console.log(`  ${data.address}\n`)
  console.log('then run: npx tsx scripts/fund-fleet-mainnet.ts')
}

main()
