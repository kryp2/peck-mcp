/**
 * Demo: Game-Theoretic Escrow on BSV Testnet
 *
 * Phase 1: Initial sync (ONE TIME — fetches source TXs from WoC)
 * Phase 2: Escrow staking (broadcast immediately)
 * Phase 3: High-speed local TX chaining (NO API CALLS)
 * Phase 4: Dishonest worker detected + slashed
 * Phase 5: Async broadcast flush
 *
 * Usage:
 *   npx tsx src/demo-escrow.ts
 */

import { PrivateKey, Hash } from '@bsv/sdk'
import { readFileSync } from 'fs'
import { UTXOManager } from './utxo-manager.js'
import { EscrowManager } from './escrow.js'

async function main() {
  console.log('='.repeat(60))
  console.log('  Game-Theoretic Escrow Demo — BSV Testnet')
  console.log('  Ut = Rt - Ct + Pt  (reward - cost - penalty)')
  console.log('='.repeat(60))
  console.log()

  // --- Load wallets ---
  const wallets = JSON.parse(readFileSync('.wallets.json', 'utf-8'))
  const gatewayKey = PrivateKey.fromHex(wallets.gateway.hex)
  const worker1Key = PrivateKey.fromHex(wallets.worker1.hex)
  const worker2Key = PrivateKey.fromHex(wallets.worker2.hex)

  const gatewayUtxo = new UTXOManager(gatewayKey, 'test')
  const worker1Utxo = new UTXOManager(worker1Key, 'test')
  const worker2Utxo = new UTXOManager(worker2Key, 'test')

  // ========================================
  // PHASE 1: One-time sync
  // ========================================
  console.log('PHASE 1: Initial sync (one-time)...')
  const syncStart = Date.now()
  await gatewayUtxo.initialSync()
  await new Promise(r => setTimeout(r, 1500))
  await worker1Utxo.initialSync()
  await new Promise(r => setTimeout(r, 1500))
  await worker2Utxo.initialSync()
  console.log(`  Synced in ${Date.now() - syncStart}ms`)
  console.log(`  Gateway:  ${gatewayUtxo.balance} sat`)
  console.log(`  Worker-1: ${worker1Utxo.balance} sat (honest)`)
  console.log(`  Worker-2: ${worker2Utxo.balance} sat (dishonest)`)
  console.log()

  // ========================================
  // PHASE 2: Escrow staking
  // ========================================
  console.log('PHASE 2: Escrow staking...')
  const escrow = new EscrowManager(gatewayUtxo, 1.0) // 100% audit for demo

  const ESCROW_AMOUNT = 1000

  await escrow.stakeEscrow(worker1Utxo, 'worker-1', ESCROW_AMOUNT)
  await escrow.stakeEscrow(worker2Utxo, 'worker-2', ESCROW_AMOUNT)
  console.log()

  // ========================================
  // PHASE 3: High-speed local TX chaining
  // ========================================
  console.log('PHASE 3: Local TX chaining (NO API calls)...')
  const JOB_COUNT = 20
  const JOB_PRICE = 2

  const chainStart = Date.now()

  for (let i = 0; i < JOB_COUNT; i++) {
    const prompt = `Test prompt #${i + 1}`

    // Honest worker responds correctly
    const response = `[echo] ${prompt} | ts=${Date.now()}`
    const proofHash = Array.from(
      Hash.sha256(Array.from(new TextEncoder().encode(response)))
    ).map(b => b.toString(16).padStart(2, '0')).join('')

    // Audit (all pass for honest worker)
    const audit = escrow.audit('worker-1', prompt, response, response)

    // Pay — local build+sign, broadcast queued async
    const txid = await escrow.payWorker('worker-1', wallets.worker1.address, JOB_PRICE, proofHash)

    if (i < 3 || i === JOB_COUNT - 1) {
      console.log(`  Job ${i + 1}: paid 2 sat → worker-1 (tx: ${txid.slice(0, 12)}...)`)
    } else if (i === 3) {
      console.log(`  ... (${JOB_COUNT - 4} more jobs)`)
    }
  }

  const chainMs = Date.now() - chainStart
  const tps = (JOB_COUNT / (chainMs / 1000)).toFixed(1)
  console.log()
  console.log(`  ${JOB_COUNT} TXs built+signed in ${chainMs}ms = ${tps} TPS (local)`)
  console.log(`  Queue: ${gatewayUtxo.getQueueSize()} TXs waiting for broadcast`)
  console.log()

  // Flush payment TXs before slash (slash TX depends on chain being on-chain)
  console.log('Broadcasting payment chain (sequential — chained TXs)...')
  let totalSent = 0
  while (gatewayUtxo.getQueueSize() > 0) {
    const batch = await gatewayUtxo.flushBroadcasts()
    totalSent += batch.sent
    if (gatewayUtxo.getQueueSize() > 0) {
      console.log(`  Sent ${totalSent} so far, ${gatewayUtxo.getQueueSize()} remaining...`)
      await new Promise(r => setTimeout(r, 3000)) // WoC rate limit
    }
  }
  console.log(`  All ${totalSent} TXs broadcast!`)
  console.log()

  // ========================================
  // PHASE 4: Dishonest worker
  // ========================================
  console.log('PHASE 4: Dishonest worker detected...')

  const dishonestPrompt = 'Calculate the square root of 144'
  const fakeResponse = 'GARBAGE_SAVING_COMPUTE_CYCLES'
  const realResponse = `[echo] ${dishonestPrompt} | ts=${Date.now()}`

  console.log(`  Prompt:    "${dishonestPrompt}"`)
  console.log(`  Worker-2:  "${fakeResponse}"`)
  console.log(`  Reference: "${realResponse.slice(0, 40)}..."`)

  const failedAudit = escrow.audit('worker-2', dishonestPrompt, fakeResponse, realResponse)

  if (!failedAudit.match) {
    console.log()
    console.log('  *** SLASHING ESCROW ***')
    const slashTxid = await escrow.slash('worker-2', 'audit_fail|garbage_response')
    if (slashTxid) {
      console.log(`  Slash TX: https://test.whatsonchain.com/tx/${slashTxid}`)
    }
  }
  console.log()

  // Flush any remaining queued TXs
  const remaining = await gatewayUtxo.flushBroadcasts()
  if (remaining.sent > 0) console.log(`  (${remaining.sent} more TXs broadcast)`)
  console.log()

  // ========================================
  // RESULTS
  // ========================================
  console.log('='.repeat(60))
  console.log('  RESULTS')
  console.log('='.repeat(60))
  console.log()

  const stats = escrow.getStats()
  console.log(`  Jobs completed: ${stats.totalJobs}`)
  console.log(`  Total paid:     ${stats.totalPaid} sat`)
  console.log(`  Audited:        ${stats.audited}`)
  console.log(`  Passed:         ${stats.passed}`)
  console.log(`  Failed:         ${stats.failed}`)
  console.log(`  Slashed:        ${stats.slashed.join(', ') || 'none'}`)
  console.log()

  const e1 = escrow.getEscrow('worker-1')
  const e2 = escrow.getEscrow('worker-2')
  console.log(`  Worker-1: escrow=${e1?.status}, earned=${JOB_COUNT * JOB_PRICE} sat  ← HONEST WINS`)
  console.log(`  Worker-2: escrow=${e2?.status}, earned=0, lost=${ESCROW_AMOUNT} sat  ← CHEATER LOSES`)
  console.log()
  console.log(`  Local signing speed: ${tps} TPS`)
  console.log(`  Gateway balance: ${gatewayUtxo.balance} sat`)
  console.log(`  TXs on chain: ${gatewayUtxo.getTxCount()}`)
  console.log()
  console.log('  Nash equilibrium: rational strategy = be honest.')
  console.log('='.repeat(60))
}

main().catch(console.error)
