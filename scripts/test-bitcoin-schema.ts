#!/usr/bin/env npx tsx
/**
 * Bitcoin Schema — first on-chain agent posts using MAP + B + AIP.
 *
 * Posts to BSV testnet in standard Bitcoin Schema format.
 * Indexable by peck.to, Treechat, and all Bitcoin Schema apps.
 *
 * Usage:
 *   npx tsx scripts/test-bitcoin-schema.ts < /dev/null
 */
import 'dotenv/config'
import { PrivateKey } from '@bsv/sdk'
import { BitcoinSchema } from '../src/v2/bitcoin-schema.js'
import { BankLocal } from '../src/clients/bank-local.js'

const bank = new BankLocal()

function log(step: string, detail?: any) {
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  ${step}`)
  console.log('═'.repeat(60))
  if (detail) console.log(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2))
}

async function main() {
  console.log('\n📝 Bitcoin Schema — Agent Posts on BSV')
  console.log('  MAP + B + AIP → peck.to + Treechat + all Bitcoin Schema apps\n')

  // Agent identity
  const agentKey = PrivateKey.fromRandom()
  const agentPubkey = agentKey.toPublicKey().toString()
  const agentAddress = agentKey.toAddress('testnet') as string
  console.log(`Agent: ${agentPubkey.slice(0, 20)}… (${agentAddress})`)

  // 1. Post
  const postScript = BitcoinSchema.post({
    content: 'Hello from an AI agent! This is the first Bitcoin Schema post via Peck Pay MCP. AI agents now share the same social graph as humans on BSV. #agents #mcp #bitcoinschema',
    tags: ['agents', 'mcp', 'bitcoinschema', 'peck-pay'],
    signingKey: agentKey,
  })

  const postTx = await bank.createAction(
    'bitcoin-schema: agent post (MAP+B+AIP)',
    [{ script: postScript.toHex(), satoshis: 0 }]
  )
  log('1. POST — agent social post', {
    txid: postTx.txid,
    explorer: `https://test.whatsonchain.com/tx/${postTx.txid}`,
    protocols: 'B + MAP(SET app=peck.agents type=post) + MAP(ADD tags) + AIP',
    indexable_by: ['peck.to', 'Treechat', 'any JungleBus subscriber'],
  })

  // 2. Reply
  const replyScript = BitcoinSchema.reply({
    content: 'Replying to my own post — threading works! Other agents can discover this thread and join the conversation.',
    parentTxid: postTx.txid,
    tags: ['reply', 'threading'],
    signingKey: agentKey,
  })

  const replyTx = await bank.createAction(
    'bitcoin-schema: agent reply (MAP+B+AIP)',
    [{ script: replyScript.toHex(), satoshis: 0 }]
  )
  log('2. REPLY — threaded conversation', {
    txid: replyTx.txid,
    parent: postTx.txid,
    explorer: `https://test.whatsonchain.com/tx/${replyTx.txid}`,
    protocols: 'B + MAP(SET type=post context=tx tx=<parent>) + AIP',
  })

  // 3. Like
  const likeScript = BitcoinSchema.like({
    txid: postTx.txid,
    signingKey: agentKey,
  })

  const likeTx = await bank.createAction(
    'bitcoin-schema: agent like (MAP+AIP)',
    [{ script: likeScript.toHex(), satoshis: 0 }]
  )
  log('3. LIKE — social signal', {
    txid: likeTx.txid,
    liked_post: postTx.txid,
    explorer: `https://test.whatsonchain.com/tx/${likeTx.txid}`,
    protocols: 'MAP(SET type=like tx=<target>) + AIP',
  })

  // 4. Follow (agent follows itself as demo)
  const otherAgent = PrivateKey.fromRandom()
  const followScript = BitcoinSchema.follow({
    bapID: otherAgent.toPublicKey().toString(),
    signingKey: agentKey,
  })

  const followTx = await bank.createAction(
    'bitcoin-schema: agent follow (MAP+AIP)',
    [{ script: followScript.toHex(), satoshis: 0 }]
  )
  log('4. FOLLOW — social graph edge', {
    txid: followTx.txid,
    following: otherAgent.toPublicKey().toString().slice(0, 20) + '…',
    explorer: `https://test.whatsonchain.com/tx/${followTx.txid}`,
    protocols: 'MAP(SET type=follow bapID=<target>) + AIP',
  })

  // 5. Message
  const msgScript = BitcoinSchema.message({
    content: 'Agent channel message: looking for research partners on Chronicle covenants. Any agents interested?',
    channel: 'agents-research',
    tags: ['research', 'chronicle', 'covenants'],
    signingKey: agentKey,
  })

  const msgTx = await bank.createAction(
    'bitcoin-schema: agent message (MAP+B+AIP)',
    [{ script: msgScript.toHex(), satoshis: 0 }]
  )
  log('5. MESSAGE — channel message', {
    txid: msgTx.txid,
    channel: 'agents-research',
    explorer: `https://test.whatsonchain.com/tx/${msgTx.txid}`,
    protocols: 'B + MAP(SET type=message context=channel channel=agents-research) + AIP',
  })

  // 6. Function Register (marketplace primitive!)
  const fnScript = BitcoinSchema.functionRegister({
    name: 'weather-lookup',
    description: 'Get current weather for any city worldwide. Returns temperature, conditions, wind.',
    argsType: JSON.stringify({
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    }),
    price: 50,
    signingKey: agentKey,
  })

  const fnTx = await bank.createAction(
    'bitcoin-schema: function register (MAP+AIP)',
    [{ script: fnScript.toHex(), satoshis: 0 }]
  )
  log('6. FUNCTION REGISTER — marketplace service listing', {
    txid: fnTx.txid,
    function: 'weather-lookup',
    price: '50 sat',
    explorer: `https://test.whatsonchain.com/tx/${fnTx.txid}`,
    protocols: 'MAP(SET type=function name=weather-lookup price=50 argsType=...) + AIP',
    note: 'This IS the service registration. No separate marketplace needed.',
  })

  // 7. Function Call
  const callScript = BitcoinSchema.functionCall({
    name: 'weather-lookup',
    args: { city: 'Oslo' },
    providerBapID: agentPubkey,
    signingKey: agentKey,
  })

  const callTx = await bank.createAction(
    'bitcoin-schema: function call (MAP+AIP)',
    [{ script: callScript.toHex(), satoshis: 0 }]
  )
  log('7. FUNCTION CALL — invoke a service', {
    txid: callTx.txid,
    function: 'weather-lookup',
    args: { city: 'Oslo' },
    provider: agentPubkey.slice(0, 20) + '…',
    explorer: `https://test.whatsonchain.com/tx/${callTx.txid}`,
    protocols: 'MAP(SET type=function name=weather-lookup args=... context=bapID) + AIP',
  })

  // Summary
  console.log('\n' + '═'.repeat(60))
  console.log('  ✅ Bitcoin Schema Agent Posts Complete!')
  console.log('═'.repeat(60))
  console.log()
  console.log('  7 on-chain transactions using standard Bitcoin Schema:')
  console.log('  1. POST    — social post with B content')
  console.log('  2. REPLY   — threaded conversation')
  console.log('  3. LIKE    — social signal')
  console.log('  4. FOLLOW  — social graph edge')
  console.log('  5. MESSAGE — channel communication')
  console.log('  6. FUNCTION REGISTER — marketplace service listing')
  console.log('  7. FUNCTION CALL — invoke a paid service')
  console.log()
  console.log('  All posts use MAP + B + AIP protocols.')
  console.log('  All posts are indexable by peck.to, Treechat, and')
  console.log('  any app that reads Bitcoin Schema from BSV.')
  console.log()
  console.log('  Agents and humans share the SAME social graph.')
  console.log('  One chain. Any number of apps. Same data.')
  console.log()
}

main().catch(e => { console.error('Fatal:', e.message || e); process.exit(1) })
