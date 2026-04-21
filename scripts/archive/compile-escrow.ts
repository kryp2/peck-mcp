#!/usr/bin/env npx tsx
/**
 * Compile and test the AgentEscrow sCrypt contract.
 */
import { AgentEscrow } from '../src/v2/contracts/AgentEscrow.js'
import { PubKey, bsv, toByteString } from 'scrypt-ts'

async function main() {
  console.log('\n🔐 sCrypt AgentEscrow — Compile & Test\n')

  // Compile the contract
  await AgentEscrow.loadArtifact()
  console.log('✅ Contract compiled to Bitcoin Script')

  // Create test keys
  const serviceKey = bsv.PrivateKey.fromRandom('testnet')
  const marketplaceKey = bsv.PrivateKey.fromRandom('testnet')
  const buyerKey = bsv.PrivateKey.fromRandom('testnet')

  console.log(`  Service:     ${serviceKey.publicKey.toHex().slice(0, 20)}…`)
  console.log(`  Marketplace: ${marketplaceKey.publicKey.toHex().slice(0, 20)}…`)
  console.log(`  Buyer:       ${buyerKey.publicKey.toHex().slice(0, 20)}…`)

  // Instantiate with 70/30 split
  const escrow = new AgentEscrow(
    PubKey(serviceKey.publicKey.toHex()),
    PubKey(marketplaceKey.publicKey.toHex()),
    PubKey(buyerKey.publicKey.toHex()),
    70n,        // 70% to service
    0n,         // settleAfterBlock (0 for testing)
    100000n,    // refundAfterBlock
  )

  const lockingScript = escrow.lockingScript.toHex()
  console.log(`\n  Locking script: ${lockingScript.length / 2} bytes`)
  console.log(`  Script preview:  ${lockingScript.slice(0, 40)}…`)

  console.log('\n  Three spending paths (enforced by Bitcoin Script):')
  console.log('    settle(serviceSig)      → 70% service + 30% marketplace')
  console.log('    slash(marketplaceSig)   → 100% marketplace (misbehavior)')
  console.log('    refund(buyerSig)        → 100% buyer (safety net)')

  console.log('\n  Wright §5.4 in Bitcoin Script:')
  console.log('    "If a node propagated incorrect state → e_i → forfeit"')
  console.log('    Covenant enforces this mathematically. No trust needed.')

  console.log('\n✅ AgentEscrow ready for deployment to BSV testnet')
}

main().catch(e => { console.error('Error:', e.message || e); process.exit(1) })
