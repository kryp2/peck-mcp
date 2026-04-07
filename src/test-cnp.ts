/**
 * test-cnp.ts — Contract Net Protocol end-to-end test
 *
 * Scenario:
 *   1 manager, 3 workers (translate-fast, translate-cheap, compute-slow)
 *   Manager broadcasts CFP for "translate" task
 *   All three bid; manager scores and picks winner
 *   CommitPayment recorded (simulated on-chain hash)
 */

import { PrivateKey } from '@bsv/sdk'
import { CNPManager } from './cnp-manager.js'
import { CNPWorker } from './cnp-worker.js'
import { ReputationScorer } from './reputation.js'

async function main() {
  console.log('=== Contract Net Protocol (CNP) Test ===\n')

  // ── Shared reputation store ──────────────────────────────────────────────
  const reputation = new ReputationScorer()

  // Pre-seed some reputation data so scoring is non-trivial
  for (let i = 0; i < 20; i++) {
    await reputation.processEvent({ agentId: 'worker-fast',  type: 'completion', response_ms: 300,  earned_satoshis: 500 })
    await reputation.processEvent({ agentId: 'worker-cheap', type: 'completion', response_ms: 1200, earned_satoshis: 200 })
    await reputation.processEvent({ agentId: 'worker-slow',  type: 'completion', response_ms: 2000, earned_satoshis: 350 })
  }
  // Give worker-slow a few failures to drag down reputation
  await reputation.processEvent({ agentId: 'worker-slow', type: 'failure' })
  await reputation.processEvent({ agentId: 'worker-slow', type: 'failure' })

  // ── Manager ───────────────────────────────────────────────────────────────
  const managerKey = PrivateKey.fromRandom()
  const manager = new CNPManager(managerKey, reputation)

  // ── Workers ───────────────────────────────────────────────────────────────
  const workers = [
    new CNPWorker(
      PrivateKey.fromRandom(),
      {
        id: 'worker-fast',
        capabilities: ['translate', 'detect-language'],
        base_price_sats: 480,
        max_concurrent_tasks: 5,
        base_response_ms: 300,
      },
      reputation,
    ),
    new CNPWorker(
      PrivateKey.fromRandom(),
      {
        id: 'worker-cheap',
        capabilities: ['translate'],
        base_price_sats: 180,
        max_concurrent_tasks: 3,
        base_response_ms: 1200,
      },
      reputation,
    ),
    new CNPWorker(
      PrivateKey.fromRandom(),
      {
        id: 'worker-slow',
        capabilities: ['translate', 'summarize', 'classify'],
        base_price_sats: 300,
        max_concurrent_tasks: 2,
        base_response_ms: 2000,
      },
      reputation,
    ),
  ]

  // ── Step 1: Manager broadcasts CFP ────────────────────────────────────────
  const cfp = manager.createCFP(
    'translate',
    ['translate'],
    600,   // max 600 sats
    10000, // 10 second window
  )
  console.log(`[Manager] Broadcasting CFP ${cfp.cfp_id}`)
  console.log(`  task_type:     ${cfp.task_type}`)
  console.log(`  requirements:  ${cfp.requirements.join(', ')}`)
  console.log(`  max_price:     ${cfp.max_price_sats} sats`)
  console.log(`  deadline:      ${new Date(cfp.deadline_ms).toISOString()}\n`)

  // Print reputation scores
  console.log('[Manager] Reputation scores:')
  for (const w of workers) {
    const { score } = reputation.getTrustScore(w.stats().id)
    console.log(`  ${w.stats().id}: ${score}/100`)
  }
  console.log()

  // ── Step 2: Workers evaluate CFP and submit bids ──────────────────────────
  const bids = workers
    .map(w => w.evaluateCFP(cfp))
    .filter((b): b is NonNullable<typeof b> => b !== null)

  console.log(`\n[Manager] Received ${bids.length} bid(s)\n`)

  // ── Step 3 & 4: Evaluate bids, pick winner, commit on-chain ───────────────
  const result = await manager.run(cfp, bids)

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n=== Results ===')
  console.log(`Winner:        ${result.winner.worker_id}`)
  console.log(`Price:         ${result.winner.price_sats} sats`)
  console.log(`Est. time:     ${result.winner.estimated_ms}ms`)
  console.log(`SLA:           ${result.winner.sla_guarantee}`)
  console.log(`CommitTxid:    ${result.commit_txid.slice(0, 32)}...`)

  console.log('\nFull scoring:')
  for (const r of result.all_results) {
    const flag = r.accepted ? '✓ WINNER' : '  rejected'
    console.log(`  ${flag}  ${r.bid.worker_id.padEnd(14)} score=${r.score.toFixed(4)}  price=${r.bid.price_sats} sats`)
  }

  // ── Step 5: Winner executes task ──────────────────────────────────────────
  const winnerWorker = workers.find(w => w.stats().id === result.winner.worker_id)!
  winnerWorker.acceptTask(`task_${cfp.cfp_id}`)

  const output = await winnerWorker.executeTask(`task_${cfp.cfp_id}`, async () => {
    await new Promise(r => setTimeout(r, 50)) // simulate work
    return 'Hola mundo'
  })

  console.log(`\n[${result.winner.worker_id}] Task result: "${output}"`)
  console.log('\n=== CNP test complete ===')
}

main().catch(console.error)
