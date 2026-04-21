#!/usr/bin/env npx tsx
/**
 * Reputation Demo — Like-ratio on function responses.
 *
 * Shows Wright §5.4 with ONLY Bitcoin Schema primitives:
 *   Call → Response → Like (or not) → Reputation derived
 *
 * Usage:
 *   npx tsx scripts/demo-reputation.ts < /dev/null
 */
import { PrivateKey } from '@bsv/sdk'
import { ReputationEngine } from '../src/v2/reputation.js'

function log(step: string, detail?: any) {
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  ${step}`)
  console.log('═'.repeat(60))
  if (detail) console.log(JSON.stringify(detail, null, 2))
}

async function main() {
  console.log('\n⭐ Reputation — Like-ratio on Bitcoin Schema\n')

  const engine = new ReputationEngine()

  const goodProvider = PrivateKey.fromRandom().toPublicKey().toString()
  const badProvider = PrivateKey.fromRandom().toPublicKey().toString()
  const buyer1 = PrivateKey.fromRandom().toPublicKey().toString()
  const buyer2 = PrivateKey.fromRandom().toPublicKey().toString()

  // Escrow
  await engine.recordEscrow(goodProvider, 500)
  await engine.recordEscrow(badProvider, 500)

  // ─── Good provider: 8 calls, 7 liked ───

  for (let i = 0; i < 8; i++) {
    const callTxid = `good-call-${i}`
    const responseTxid = `good-resp-${i}`

    await engine.recordCall({
      call_txid: callTxid,
      response_txid: responseTxid,
      caller: i % 2 === 0 ? buyer1 : buyer2,
      provider: goodProvider,
      function_name: 'weather-lookup',
      liked: false,
      timestamp: Date.now(),
    })
    await engine.linkResponse(callTxid, responseTxid)

    // 7 out of 8 get liked (one was slow but correct)
    if (i !== 4) {
      await engine.recordLike(responseTxid, i % 2 === 0 ? buyer1 : buyer2)
    }
  }

  // ─── Bad provider: 8 calls, 2 liked ───

  for (let i = 0; i < 8; i++) {
    const callTxid = `bad-call-${i}`
    const responseTxid = `bad-resp-${i}`

    await engine.recordCall({
      call_txid: callTxid,
      response_txid: responseTxid,
      caller: i % 2 === 0 ? buyer1 : buyer2,
      provider: badProvider,
      function_name: 'weather-lookup',
      liked: false,
      timestamp: Date.now(),
    })
    await engine.linkResponse(callTxid, responseTxid)

    // Only 2 out of 8 get liked (mostly garbage responses)
    if (i === 0 || i === 3) {
      await engine.recordLike(responseTxid, i % 2 === 0 ? buyer1 : buyer2)
    }
  }

  // ─── Results ───

  const repGood = await engine.getReputation(goodProvider)
  const repBad = await engine.getReputation(badProvider)

  log('Good Provider — mostly liked', {
    total_responses: repGood.total_responses,
    likes: repGood.likes,
    ratio: repGood.ratio,
    reputation: repGood.reputation,
    status: repGood.status,
    escrow: repGood.escrow_sat + ' sat',
  })

  log('Bad Provider — mostly NOT liked', {
    total_responses: repBad.total_responses,
    likes: repBad.likes,
    ratio: repBad.ratio,
    reputation: repBad.reputation,
    status: repBad.status,
    escrow: repBad.escrow_sat + ' sat',
  })

  // Discovery filter
  const all = [
    { provider: goodProvider, name: 'good-weather' },
    { provider: badProvider, name: 'bad-weather' },
  ]

  const visible = await engine.filterByReputation(all, 0.50)

  log('Discovery — reputation filter at 50%', {
    total_services: all.length,
    visible: visible.map(s => ({
      name: s.name,
      reputation: s.reputation.reputation,
      status: s.reputation.status,
    })),
    hidden: all.filter(a => !visible.find(v => v.provider === a.provider)).map(a => a.name),
  })

  console.log('\n' + '═'.repeat(60))
  console.log('  ✅ Reputation Demo Complete!')
  console.log('═'.repeat(60))
  console.log()
  console.log('  HOW IT WORKS:')
  console.log('  1. Agent calls a function → on-chain (Bitcoin Schema)')
  console.log('  2. Provider responds → on-chain (reply)')
  console.log('  3. Caller likes response → on-chain (Bitcoin Schema Like)')
  console.log('  4. Reputation = likes / total responses')
  console.log()
  console.log('  NO CUSTOM PROTOCOL. Just Like.')
  console.log('  Humans on peck.to can like agent responses too.')
  console.log('  Same signal, same weight, same chain.')
  console.log()
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
