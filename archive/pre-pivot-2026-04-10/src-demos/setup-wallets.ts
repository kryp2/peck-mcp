/**
 * Wallet Setup — generates persistent testnet wallets for hackathon agents.
 *
 * BRC-100 compliant: keys stored as hex (never WIF for server keys).
 * Type-42 key derivation ready: master keys can derive per-session child keys.
 *
 * Usage:
 *   npx tsx src/setup-wallets.ts          # Generate new wallets
 *   npx tsx src/setup-wallets.ts --show   # Show existing wallets
 */

import { PrivateKey } from '@bsv/sdk'
import { readFileSync, writeFileSync, existsSync } from 'fs'

const WALLET_FILE = '.wallets.json'

interface WalletData {
  gateway: { hex: string; address: string; publicKey: string }
  worker1: { hex: string; address: string; publicKey: string }
  worker2: { hex: string; address: string; publicKey: string }
  network: 'testnet' | 'mainnet'
  created: string
}

function createWallet(label: string) {
  const key = PrivateKey.fromRandom()
  const address = key.toAddress('testnet')
  const publicKey = key.toPublicKey().toString()
  const hex = key.toHex()

  console.log(`  ${label}:`)
  console.log(`    Address:    ${address}`)
  console.log(`    Public Key: ${publicKey.slice(0, 20)}...`)
  console.log()

  return { hex, address, publicKey }
}

function loadWallets(): WalletData | null {
  if (!existsSync(WALLET_FILE)) return null
  return JSON.parse(readFileSync(WALLET_FILE, 'utf-8'))
}

function showWallets(data: WalletData) {
  console.log(`Network: ${data.network}`)
  console.log(`Created: ${data.created}`)
  console.log()

  for (const [name, wallet] of Object.entries(data)) {
    if (typeof wallet !== 'object' || !('address' in wallet)) continue
    const key = PrivateKey.fromHex(wallet.hex)
    console.log(`  ${name}:`)
    console.log(`    Address:    ${wallet.address}`)
    console.log(`    Public Key: ${wallet.publicKey.slice(0, 20)}...`)
    // Verify key still derives same address
    const check = key.toAddress('testnet')
    console.log(`    Verified:   ${check === wallet.address ? 'OK' : 'MISMATCH!'}`)
    console.log()
  }
}

async function main() {
  const showOnly = process.argv.includes('--show')

  console.log('='.repeat(50))
  console.log('  Agentic Pay — Wallet Setup (Testnet)')
  console.log('='.repeat(50))
  console.log()

  // Check for existing wallets
  const existing = loadWallets()

  if (showOnly) {
    if (!existing) {
      console.log('No wallets found. Run without --show to generate.')
      return
    }
    showWallets(existing)
    return
  }

  if (existing) {
    console.log('Existing wallets found!')
    console.log()
    showWallets(existing)
    console.log('To regenerate, delete .wallets.json first.')
    return
  }

  // Generate new wallets
  console.log('Generating testnet wallets...')
  console.log()

  const gateway = createWallet('Gateway (orchestrator)')
  const worker1 = createWallet('Worker-1 (honest)')
  const worker2 = createWallet('Worker-2 (will be dishonest for demo)')

  const data: WalletData = {
    gateway,
    worker1,
    worker2,
    network: 'testnet',
    created: new Date().toISOString(),
  }

  writeFileSync(WALLET_FILE, JSON.stringify(data, null, 2))
  console.log(`Wallets saved to ${WALLET_FILE}`)
  console.log()

  console.log('='.repeat(50))
  console.log('  FUND THESE ADDRESSES ON TESTNET')
  console.log('='.repeat(50))
  console.log()
  console.log(`  Gateway:  ${gateway.address}`)
  console.log(`  Worker-1: ${worker1.address}`)
  console.log(`  Worker-2: ${worker2.address}`)
  console.log()
  console.log('  Gateway needs the most funds (pays workers per job).')
  console.log('  Workers need escrow deposit (e.g. 10,000 sat each).')
  console.log()
  console.log(`  Faucet:   https://faucet.bitcoincloud.net`)
  console.log(`  Explorer: https://test.whatsonchain.com`)
  console.log()
}

main().catch(console.error)
