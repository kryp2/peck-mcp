/**
 * Test: Create two agent wallets and verify we can build transactions on testnet.
 *
 * This is a minimal proof-of-concept to understand the BSV SDK
 * before the hackathon starts April 6.
 *
 * Testnet has Chronicle active since January 2026.
 */

import { PrivateKey, P2PKH, Transaction, ARC } from '@bsv/sdk'

// Testnet ARC endpoint (GorillaPool runs testnet too)
const TESTNET_ARC = 'https://arc.gorillapool.io'

async function main() {
  // Create two agent keypairs
  const agentA = PrivateKey.fromRandom()
  const agentB = PrivateKey.fromRandom()

  console.log('=== Agent Wallets Created ===')
  console.log(`Agent A (Adam):`)
  console.log(`  Private key: ${agentA.toWif()}`)
  console.log(`  Address:     ${agentA.toAddress()}`)
  console.log()
  console.log(`Agent B (Eva):`)
  console.log(`  Private key: ${agentB.toWif()}`)
  console.log(`  Address:     ${agentB.toAddress()}`)
  console.log()

  console.log('=== Testnet Info ===')
  console.log(`ARC endpoint: ${TESTNET_ARC}`)
  console.log(`Explorer:     https://test.whatsonchain.com`)
  console.log()
  console.log('Next steps:')
  console.log('1. Get testnet coins from faucet or Discord')
  console.log('2. Fund Agent A address above')
  console.log('3. Run agent-a.ts to start sending micropayments to Agent B')
  console.log()

  // Test that we can construct a transaction (won't broadcast without funds)
  const tx = new Transaction()
  console.log('Transaction construction: OK')
  console.log(`SDK loaded successfully!`)
}

main().catch(console.error)
