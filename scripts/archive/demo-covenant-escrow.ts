#!/usr/bin/env npx tsx
/**
 * sCrypt Covenant Escrow — deploy to BSV testnet via bank-local.
 *
 * Uses sCrypt for the contract compilation, but deploys via our
 * existing bank-local infrastructure (wallet-infra) for reliability.
 *
 * Usage:
 *   npx tsx scripts/demo-covenant-escrow.ts < /dev/null
 */
import 'dotenv/config'
import { AgentEscrow } from '../src/contracts/AgentEscrow.js'
import { PubKey, bsv } from 'scrypt-ts'
import { BankLocal } from '../src/clients/bank-local.js'

const bank = new BankLocal()

function log(step: string, detail?: any) {
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  ${step}`)
  console.log('═'.repeat(60))
  if (detail) console.log(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2))
}

async function main() {
  console.log('\n🔐 sCrypt Covenant Escrow — Live on BSV Testnet\n')

  // Load artifact
  await AgentEscrow.loadArtifact()
  console.log('✅ Contract artifact loaded')

  // Create keys
  const serviceKey = bsv.PrivateKey.fromRandom('testnet')
  const marketplaceKey = bsv.PrivateKey.fromRandom('testnet')
  const buyerKey = bsv.PrivateKey.fromRandom('testnet')

  console.log(`  Service:     ${serviceKey.toAddress().toString()}`)
  console.log(`  Marketplace: ${marketplaceKey.toAddress().toString()}`)
  console.log(`  Buyer:       ${buyerKey.toAddress().toString()}`)

  // Instantiate contract
  const escrowAmount = 500  // lock 500 sat
  const escrow = new AgentEscrow(
    PubKey(serviceKey.publicKey.toHex()),
    PubKey(marketplaceKey.publicKey.toHex()),
    PubKey(buyerKey.publicKey.toHex()),
    70n,      // 70% to service
    0n,       // settleAfterBlock
    999999n,  // refundAfterBlock
  )

  const lockingScriptHex = escrow.lockingScript.toHex()
  console.log(`  Script size: ${lockingScriptHex.length / 2} bytes`)

  // ═══════════════════════════════════════════════════════════
  // DEPLOY — lock sat in the covenant via bank-local
  // ═══════════════════════════════════════════════════════════

  log('1. DEPLOY — locking sat in sCrypt covenant')

  const deployResult = await bank.createAction(
    'scrypt-covenant: deploy AgentEscrow (70/30 split)',
    [{ script: lockingScriptHex, satoshis: escrowAmount }]
  )

  log('Covenant deployed on-chain!', {
    txid: deployResult.txid,
    locked: escrowAmount + ' sat',
    script_size: lockingScriptHex.length / 2 + ' bytes',
    explorer: `https://test.whatsonchain.com/tx/${deployResult.txid}`,
    contract: 'AgentEscrow',
    split: '70% service / 30% marketplace',
    spending_paths: {
      settle: 'serviceSig → 70/30 split (enforced by script)',
      slash: 'marketplaceSig → 100% marketplace (misbehavior)',
      refund: 'buyerSig → 100% buyer (safety net after timelock)',
    },
  })

  // Calculate expected settlement amounts
  const serviceSats = Math.floor(escrowAmount * 70 / 100)
  const marketplaceSats = escrowAmount - serviceSats

  log('2. SETTLEMENT MATH (enforced by Bitcoin Script)', {
    total_locked: escrowAmount + ' sat',
    service_gets: serviceSats + ' sat (70%)',
    marketplace_gets: marketplaceSats + ' sat (30%)',
    enforcement: 'Bitcoin Script consensus — not a promise, a mathematical guarantee',
    note: 'Any tx that tries a different split will be REJECTED by miners',
  })

  // Post covenant info to social agent
  try {
    const { BitcoinSchema } = await import('../src/v2/bitcoin-schema.js')
    const { PrivateKey } = await import('@bsv/sdk')
    const key = PrivateKey.fromRandom()

    const script = BitcoinSchema.post({
      content: JSON.stringify({
        type: 'covenant_deployed',
        contract: 'AgentEscrow',
        txid: deployResult.txid,
        locked_sat: escrowAmount,
        split: '70/30',
        service: serviceKey.toAddress().toString(),
        marketplace: marketplaceKey.toAddress().toString(),
        wright_section: '5.4',
      }),
      tags: ['covenant', 'escrow', 'scrypt', 'wright-5.4', 'deployed'],
      signingKey: key,
    })

    const postResult = await bank.createAction(
      'bitcoin-schema: covenant deployment announcement',
      [{ script: script.toHex(), satoshis: 0 }]
    )
    console.log(`\n  Posted to social graph: ${postResult.txid}`)
  } catch (e: any) {
    console.log(`\n  Social post skipped: ${e.message}`)
  }

  // Summary
  console.log('\n' + '═'.repeat(60))
  console.log('  ✅ sCrypt Covenant Escrow Deployed!')
  console.log('═'.repeat(60))
  console.log()
  console.log('  WHAT IS ON-CHAIN RIGHT NOW:')
  console.log(`  • ${escrowAmount} sat locked in an sCrypt smart contract`)
  console.log('  • The script enforces EXACTLY 70% service + 30% marketplace')
  console.log('  • Three paths: settle / slash / refund')
  console.log('  • No one can change the rules — they are Bitcoin Script')
  console.log()
  console.log('  THE UPGRADE PATH:')
  console.log('  P2MS (Tier 1):    "both parties sign to release"  ← trust required')
  console.log('  Covenant (Tier 2): "math enforces the split"      ← trustless')
  console.log()
  console.log('  Wright §5.4: escrow forfeiture enforced by consensus,')
  console.log('  not by a trusted operator. This is the difference between')
  console.log('  "we promise not to steal" and "we cannot steal."')
  console.log()
  console.log(`  Proof: https://test.whatsonchain.com/tx/${deployResult.txid}`)
  console.log()
}

main().catch(e => { console.error('Error:', e.message || e); process.exit(1) })
