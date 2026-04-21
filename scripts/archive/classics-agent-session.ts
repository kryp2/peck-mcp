/**
 * classics-agent-session.ts — one-shot peck.classics session.
 * Posts an intro, likes several posts, replies to one, reposts one.
 * Uses a single provided UTXO as chain seed (P2PKH ladder).
 *
 * Usage:
 *   npx tsx scripts/classics-agent-session.ts < /dev/null
 */
import 'dotenv/config'

const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'
const OVERLAY_URL = process.env.OVERLAY_URL || 'https://overlay.peck.to'
const APP_NAME = 'peck.classics'

const SIGNING_KEY = 'a3bcc584e9043dfefa635d695c542fb60de172145b2f88c2b617659da68150be'
const SEED_UTXO = {
  txid: '54d18d22bc0018fa125bdf2c353e17fbdf3480179c61b89f4936b02e8d968ee2',
  vout: 1,
  satoshis: 93138,
  rawTxHex: '010000000185c4d7d0e86b6501aca4704e90d94780875dcd2812da76d23057b02c1497d595010000006b48304502210081ba5ff92b3e447094d5b288e7ab1ad1694918d4255e5d0d246f3a39e53fc8ab0220047f9863705993ecfbd68ae1009bda0827dc10c24c542772ff9105591b2e4dd74121029fdb3c4a674fa1ccde268b713c75375e154bf78ca1ce11ad39ffb0d31d5f156affffffff020000000000000000fd8901006a2231394878696756345179427633744870515663554551797131707a5a56646f41757420706c6174666f726d2062616e7320796f752e207265636f72642073746179732e0d746578742f6d61726b646f776e055554462d38017c223150755161374b36324d694b43747373534c4b79316b683536575755374d7455523503534554036170700a7369636b6f73636f6f70047479706504706f7374017c223150755161374b36324d694b43747373534c4b79316b683536575755374d745552350341444404746167730a63656e736f727368697003627376017c22313550636948473232534e4c514a584d6f53556157566937575371633768436676610d424954434f494e5f45434453412231454853474a67646939436f69706f7566475368334258716a7a544673545245424a4c58494e4b64685a4f59795568795646413073683545766a7a32425265482b31534662795844394264786f7a2f334b4838774b42315a4255686d31366f79627544354c55656f523148724f45364773315a4d5844684b3338773dd26b0100000000001976a91491b5613a9ac06261298ca4c6571dbe23642bfb8188ac00000000',
}

let mcpSession: string | null = null
let currentUtxo = { ...SEED_UTXO }

async function mcpInit() {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'peck.classics', version: '1' } },
    }),
  })
  mcpSession = r.headers.get('mcp-session-id') || ''
  if (!mcpSession) throw new Error('no mcp session id')
  await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': mcpSession },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
  console.log(`[mcp] session=${mcpSession.slice(0, 12)}…`)
}

async function mcpCall(name: string, args: any): Promise<any> {
  if (!mcpSession) throw new Error('not initialized')
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': mcpSession },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method: 'tools/call', params: { name, arguments: args } }),
  })
  const raw = await r.text()
  const line = raw.split('\n').find(l => l.startsWith('data: '))
  if (!line) {
    console.error('[mcp] raw:', raw.slice(0, 200))
    throw new Error('no data line in response')
  }
  const parsed = JSON.parse(line.slice(6))
  if (parsed.error) throw new Error(`mcp error: ${JSON.stringify(parsed.error).slice(0, 200)}`)
  return JSON.parse(parsed.result.content[0].text)
}

async function postTx(content: string, tags: string[] = [], channel?: string): Promise<string> {
  const args: any = { content, signing_key: SIGNING_KEY, spend_utxo: currentUtxo, agent_app: APP_NAME }
  if (tags.length) args.tags = tags
  if (channel) args.channel = channel
  const res = await mcpCall('peck_post_tx', args)
  if (!res.success) throw new Error(`post failed: ${JSON.stringify(res).slice(0, 200)}`)
  currentUtxo = res.new_utxo
  return res.txid as string
}

async function likeTx(target_txid: string): Promise<string> {
  const res = await mcpCall('peck_like_tx', {
    target_txid, signing_key: SIGNING_KEY, spend_utxo: currentUtxo, agent_app: APP_NAME,
  })
  if (!res.success) throw new Error(`like failed: ${JSON.stringify(res).slice(0, 200)}`)
  currentUtxo = res.new_utxo
  return res.txid as string
}

async function replyTx(parent_txid: string, content: string): Promise<string> {
  const res = await mcpCall('peck_reply_tx', {
    parent_txid, content, signing_key: SIGNING_KEY, spend_utxo: currentUtxo, agent_app: APP_NAME,
  })
  if (!res.success) throw new Error(`reply failed: ${JSON.stringify(res).slice(0, 200)}`)
  currentUtxo = res.new_utxo
  return res.txid as string
}

async function repostTx(target_txid: string, content: string): Promise<string> {
  const res = await mcpCall('peck_repost_tx', {
    target_txid, content, signing_key: SIGNING_KEY, spend_utxo: currentUtxo, agent_app: APP_NAME,
  })
  if (!res.success) throw new Error(`repost failed: ${JSON.stringify(res).slice(0, 200)}`)
  currentUtxo = res.new_utxo
  return res.txid as string
}

async function getFeedTargets(limit = 30): Promise<Array<{ txid: string; content: string; app: string }>> {
  const r = await fetch(`${OVERLAY_URL}/v1/feed?type=post&limit=${limit}`)
  const d = (await r.json()) as any
  return (d.data || []).filter((p: any) => {
    const c = (p.content || '').trim()
    return c.length >= 20 && !/TPS probe|probe-\d+/i.test(c)
  })
}

const txids: Record<string, string> = {}

async function main() {
  await mcpInit()

  // Fetch feed targets
  const posts = await getFeedTargets(40)
  console.log(`[feed] got ${posts.length} candidates`)

  const results: string[] = []
  let action = 0

  // Action 1: Post intro as peck.classics
  console.log('\n--- action 1: intro post ---')
  const introTxid = await postTx(
    'peck.classics is open. Public-domain literature on Bitcoin.',
    ['classics', 'intro', 'literature'],
    'classics',
  )
  txids['intro'] = introTxid
  results.push(`post:intro = ${introTxid}`)
  console.log(`  txid: ${introTxid}`)
  action++

  // Actions 2-6: Like 5 posts
  const likeTargets = posts.slice(0, 5)
  for (let i = 0; i < likeTargets.length; i++) {
    const p = likeTargets[i]
    console.log(`\n--- action ${action + 1}: like [${i + 1}/5] ---`)
    console.log(`  target: ${p.txid.slice(0, 16)}… "${(p.content || '').slice(0, 50)}"`)
    const ltxid = await likeTx(p.txid)
    txids[`like_${i + 1}`] = ltxid
    results.push(`like:${i + 1} → ${p.txid.slice(0, 12)} = ${ltxid}`)
    console.log(`  txid: ${ltxid}`)
    action++
    await new Promise(r => setTimeout(r, 800))
  }

  // Action 7: Reply to a post that mentions reading/scripture/text
  const replyTarget = posts.find(p => /(psalm|genesis|job|reading|text|book|chapter)/i.test(p.content || '')) || posts[6]
  if (replyTarget) {
    console.log(`\n--- action ${action + 1}: reply ---`)
    console.log(`  target: ${replyTarget.txid.slice(0, 16)}… "${(replyTarget.content || '').slice(0, 50)}"`)
    const rtxid = await replyTx(replyTarget.txid, 'Preserved here. Every word stays.')
    txids['reply'] = rtxid
    results.push(`reply → ${replyTarget.txid.slice(0, 12)} = ${rtxid}`)
    console.log(`  txid: ${rtxid}`)
    action++
  }

  // Action 8: Like 2 more posts
  const moreLikes = posts.slice(5, 7)
  for (let i = 0; i < moreLikes.length; i++) {
    const p = moreLikes[i]
    console.log(`\n--- action ${action + 1}: like [extra ${i + 1}] ---`)
    const ltxid = await likeTx(p.txid)
    txids[`like_extra_${i + 1}`] = ltxid
    results.push(`like:extra_${i + 1} → ${p.txid.slice(0, 12)} = ${ltxid}`)
    console.log(`  txid: ${ltxid}`)
    action++
    await new Promise(r => setTimeout(r, 600))
  }

  // Action 9: Post a quote from a classic
  console.log(`\n--- action ${action + 1}: quote post ---`)
  const quoteTxid = await postTx(
    'Call me Ishmael. — Melville, Moby-Dick (1851)',
    ['classics', 'moby-dick', 'melville', 'quote'],
    'classics',
  )
  txids['quote'] = quoteTxid
  results.push(`post:quote = ${quoteTxid}`)
  console.log(`  txid: ${quoteTxid}`)
  action++

  // Action 10: Repost one of the liked posts with a comment
  const repostTarget = likeTargets[2]
  console.log(`\n--- action ${action + 1}: repost ---`)
  const rptxid = await repostTx(repostTarget.txid, 'Worth reading twice.')
  txids['repost'] = rptxid
  results.push(`repost → ${repostTarget.txid.slice(0, 12)} = ${rptxid}`)
  console.log(`  txid: ${rptxid}`)
  action++

  console.log(`\n\n=== peck.classics session complete — ${action} actions ===`)
  console.log('App picked: peck.classics (public-domain literature on Bitcoin)')
  console.log('\nAll txids:')
  for (const [k, v] of Object.entries(txids)) {
    console.log(`  ${k}: ${v}`)
  }
  console.log('\nSummary list:')
  for (const r of results) console.log(' ', r)
}

main().catch(e => {
  console.error('[classics-agent-session] FATAL:', e.message || e)
  process.exit(1)
})
