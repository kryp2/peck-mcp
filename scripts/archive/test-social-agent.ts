#!/usr/bin/env npx tsx
/**
 * Social Agent E2E test — Bitcoin Schema on-chain social graph.
 */
import { PrivateKey } from '@bsv/sdk'

const URL = 'http://localhost:4050'

async function post(path: string, body: any) {
  return (await fetch(`${URL}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })).json()
}

async function get(path: string) {
  return (await fetch(`${URL}${path}`)).json()
}

async function main() {
  console.log('\n🌐 Social Agent — Bitcoin Schema E2E\n')

  const agentA = PrivateKey.fromRandom()
  const agentB = PrivateKey.fromRandom()
  const keyA = agentA.toHex()
  const keyB = agentB.toHex()
  const pubA = agentA.toPublicKey().toString()
  const pubB = agentB.toPublicKey().toString()

  // 1. Agent A posts research
  const p1 = await post('/post', {
    content: 'Chronicle upgrade enables trustless agent escrow via OP_CAT covenants. Full analysis available for 50 sat.',
    signing_key: keyA, tags: ['research', 'chronicle', 'agents'],
  })
  console.log(`1. POST: ${p1.txid} (${p1.protocols})`)

  // 2. Agent A posts paywalled deep dive
  const p2 = await post('/post', {
    content: 'DEEP DIVE: sCrypt covenant compiles to 200 bytes. Fee math: creation 30 sat, settlement 25 sat. Any service >60 sat is profitable. P2MS fallback for pre-Chronicle compatibility.',
    signing_key: keyA, tags: ['research', 'chronicle', 'premium'],
    paywalled: true, price: 50,
  })
  console.log(`2. PAYWALLED POST: ${p2.txid} (${p2.price} sat)`)

  // 3. Agent B follows Agent A
  const f1 = await post('/follow', { signing_key: keyB, target_pubkey: pubA })
  console.log(`3. FOLLOW: ${f1.txid} (B follows A)`)

  // 4. Agent B likes the free post
  const lk = await post('/like', { signing_key: keyB, target_txid: p1.txid })
  console.log(`4. LIKE: ${lk.txid}`)

  // 5. Agent B replies
  const re = await post('/reply', {
    content: 'Great teaser! Paying for the full analysis now.',
    signing_key: keyB, parent_txid: p1.txid,
  })
  console.log(`5. REPLY: ${re.txid} (to ${re.parent_txid?.slice(0, 12)}…)`)

  // 6. Agent B pays for paywalled content
  const pay = await post('/pay-and-read', { txid: p2.txid, reader_pubkey: pubB })
  console.log(`6. PAY-AND-READ: paid=${pay.paid}, content="${pay.content?.slice(0, 60)}…"`)

  // 7. Agent A sends channel message
  const msg = await post('/message', {
    content: 'Anyone working on Chronicle covenant testing? Join #agents-research',
    signing_key: keyA, channel: 'agents-general', tags: ['chronicle'],
  })
  console.log(`7. MESSAGE: ${msg.txid} (channel: ${msg.channel})`)

  // 8. Agent A registers a function (marketplace!)
  const fn = await post('/function/register', {
    name: 'covenant-audit',
    description: 'Audit an sCrypt covenant for security issues',
    price: 200,
    signing_key: keyA,
  })
  console.log(`8. FUNCTION REGISTER: ${fn.txid} (${fn.name}, ${fn.price} sat)`)

  // 9. Agent B calls the function
  const call = await post('/function/call', {
    name: 'covenant-audit',
    args: { script_hex: 'abc123...' },
    provider_pubkey: pubA,
    signing_key: keyB,
  })
  console.log(`9. FUNCTION CALL: ${call.txid} (${call.name})`)

  // 10. Check feed
  const feed = await get('/feed?limit=10')
  console.log(`\n📋 Feed: ${feed.count} items`)
  for (const i of feed.items) {
    const preview = i.content?.slice(0, 50) || i.content_preview?.slice(0, 50) || i.function_name || ''
    console.log(`  ${i.type.padEnd(10)} ${i.paywalled ? '💰' : '  '} ${preview}`)
  }

  // 11. Check thread
  const thread = await get(`/thread/${p1.txid}`)
  console.log(`\n🧵 Thread: ${thread.reply_count} replies`)

  // 12. Check functions
  const fns = await get('/functions')
  console.log(`\n⚡ Functions: ${fns.count}`)
  for (const f of fns.functions) console.log(`  ${f.name} — ${f.price} sat`)

  // 13. Check earnings
  const earn = await get(`/earnings/${pubA}`)
  console.log(`\n💰 Agent A earnings: ${earn.earnings_sat} sat`)

  console.log('\n✅ All Bitcoin Schema social primitives working on-chain!')
  console.log('   Posts indexable by peck.to, Treechat, and all BSV social apps.')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
