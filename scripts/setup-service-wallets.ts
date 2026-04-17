/**
 * Generate persistent BSV wallets for each marketplace service.
 * Each service gets its own keypair so payments flow on-chain to
 * the correct recipient.
 *
 * Run: npx tsx scripts/setup-service-wallets.ts
 */
import { PrivateKey } from '@bsv/sdk'
import { writeFileSync, existsSync, readFileSync } from 'fs'

const FILE = '.wallets-services.json'

const SERVICES = [
  'weather',
  'translate',
  'summarize',
  'price',
  'geocode',
  'evm-compute',
  'wasm-compute',
  'gas-oracle',     // AP5D-3, will be added tonight
  'metering',       // AP4E, will be added tonight
] as const

interface ServiceWallet {
  hex: string
  address: string
  publicKey: string
}

function makeWallet(): ServiceWallet {
  const k = PrivateKey.fromRandom()
  return {
    hex: k.toHex(),
    address: k.toAddress('testnet'),
    publicKey: k.toPublicKey().toString(),
  }
}

function main() {
  let existing: Record<string, ServiceWallet> = {}
  if (existsSync(FILE)) {
    existing = JSON.parse(readFileSync(FILE, 'utf-8'))
    console.log(`Loaded existing ${FILE}`)
  }

  let added = 0
  for (const name of SERVICES) {
    if (!existing[name]) {
      existing[name] = makeWallet()
      added++
    }
  }

  writeFileSync(FILE, JSON.stringify(existing, null, 2))
  console.log(`\n${added} new wallet(s) added. Total: ${Object.keys(existing).length}`)
  console.log(`\nService wallets:`)
  for (const [name, w] of Object.entries(existing)) {
    console.log(`  ${name.padEnd(15)} ${w.address}`)
  }
  console.log(`\nNote: services receive payments. They don't need pre-funding.`)
}

main()
