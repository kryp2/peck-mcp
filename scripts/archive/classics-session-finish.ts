/**
 * classics-session-finish.ts — complete remaining actions.
 * Picks up from where classics-agent-session left off after action 6.
 */
import 'dotenv/config'

const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'
const OVERLAY_URL = process.env.OVERLAY_URL || 'https://overlay.peck.to'
const APP_NAME = 'peck.classics'

const SIGNING_KEY = 'a3bcc584e9043dfefa635d695c542fb60de172145b2f88c2b617659da68150be'

// Last confirmed change UTXO (after action 6 — like 5/5)
let currentUtxo = {
  txid: 'ef335b2fa7031043fa6790a087853c1f989144dd1bdf28136d9f850561a59444',
  vout: 1,
  satoshis: 92750,
  rawTxHex: '01000000016301666849bd727d4fe91cb7b37eac93c22bbefdf1b51e05dc1bfdec4e4798c9010000006b483045022100c002c9f9575fa5cc7c2511343abf3b725c41124e3d80a5eca3a12a4c0a28352502201b9a08de64bfecff50a983733fa22902bfb3b40d2fdb9d8fcf7df7fa12dc958c4121029fdb3c4a674fa1ccde268b713c75375e154bf78ca1ce11ad39ffb0d31d5f156affffffff020000000000000000fd9f01006a2231394878696756345179427633744870515663554551797131707a5a56646f4175742150726573657276656420686572652e20457665727920776f72642073746179732e0d746578742f6d61726b646f776e055554462d38017c223150755161374b36324d694b43747373534c4b79316b683536575755374d7455523503534554036170700d7065636b2e636c617373696373047479706504706f737407636f6e746578740274780274784034336463316135353965393566643466323632663564616661333361623238663965323632346366663661323165653463383663653530663739633639303732017c22313550636948473232534e4c514a584d6f53556157566937575371633768436676610d424954434f494e5f45434453412231454853474a67646939436f69706f7566475368334258716a7a544673545245424a4c58482b6353484866362b512f54713349634339534c794d69645878726d4a6b3758426244686d436a574a38537466746e2b66584e666d6d736752626837544f434a466352306e504c73562f2b4558523165414d50303766383d4e6a0100000000001976a91491b5613a9ac06261298ca4c6571dbe23642bfb8188ac00000000',
}

let mcpSession: string | null = null

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
  if (!line) { console.error('[mcp] raw:', raw.slice(0, 300)); throw new Error('no data line') }
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

async function main() {
  await mcpInit()
  const posts = await getFeedTargets(40)
  console.log(`[feed] ${posts.length} candidates`)

  const results: string[] = []

  // Action 7: reply to a psalm/scripture/reading post
  const replyTarget = posts.find(p => /(psalm|genesis|job|reading|scripture|chapter)/i.test(p.content || '')) || posts[7]
  console.log(`\n--- action 7: reply ---`)
  console.log(`  target: ${replyTarget.txid.slice(0,16)}… "${(replyTarget.content||'').slice(0,50)}"`)
  const r7 = await replyTx(replyTarget.txid, 'Preserved here. Every word stays.')
  results.push(`reply → ${replyTarget.txid.slice(0,12)} = ${r7}`)
  console.log(`  txid: ${r7}`)
  await new Promise(r => setTimeout(r, 800))

  // Action 8: like
  const like8 = posts[8]
  console.log(`\n--- action 8: like ---`)
  console.log(`  target: ${like8.txid.slice(0,16)}… "${(like8.content||'').slice(0,50)}"`)
  const r8 = await likeTx(like8.txid)
  results.push(`like → ${like8.txid.slice(0,12)} = ${r8}`)
  console.log(`  txid: ${r8}`)
  await new Promise(r => setTimeout(r, 600))

  // Action 9: like another
  const like9 = posts[9]
  console.log(`\n--- action 9: like ---`)
  console.log(`  target: ${like9.txid.slice(0,16)}… "${(like9.content||'').slice(0,50)}"`)
  const r9 = await likeTx(like9.txid)
  results.push(`like → ${like9.txid.slice(0,12)} = ${r9}`)
  console.log(`  txid: ${r9}`)
  await new Promise(r => setTimeout(r, 600))

  // Action 10: quote post — a line from a classic
  console.log(`\n--- action 10: quote post ---`)
  const r10 = await postTx(
    'It was the best of times, it was the worst of times. — Dickens, A Tale of Two Cities',
    ['classics', 'dickens', 'quote', 'literature'],
    'classics',
  )
  results.push(`post:quote = ${r10}`)
  console.log(`  txid: ${r10}`)

  console.log('\n\n=== peck.classics finish — 4 more actions ===')
  for (const r of results) console.log(' ', r)
}

main().catch(e => {
  console.error('[finish] FATAL:', e.message || e)
  process.exit(1)
})
