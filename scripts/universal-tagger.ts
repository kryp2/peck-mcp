/**
 * universal-tagger.ts — emit peck_tag_tx against EVERY post in overlay.
 *
 * Iterates the full overlay feed (all apps, all types) and tags each post
 * with metadata: seen-by-peck-agents, year, type, source-app. Creates a
 * parallel layer of "this was noticed" on-chain over every BSV-social post.
 *
 * Shard-friendly. Resumable.
 *
 * Usage:
 *   npx tsx scripts/universal-tagger.ts <agent> [shard=0] [num_shards=1]
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { createHash } from 'crypto'

const AGENT = process.argv[2]
const SHARD = parseInt(process.argv[3] || '0', 10)
const NUM_SHARDS = parseInt(process.argv[4] || '1', 10)
if (!AGENT) { console.error('need <agent> [shard] [num_shards]'); process.exit(1) }

const WALLET_PATH = `.agent-wallets/${AGENT}.json`
const STATE_DIR = '.universal-tagger-state'
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR)
const STATE_PATH = `${STATE_DIR}/${AGENT}.json`

const OVERLAY_URL = process.env.OVERLAY_URL || 'https://overlay.peck.to'
const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'
const APP_NAME = 'peck.agents'
const MIN_BALANCE = 200
const PAGE_SIZE = 200

interface Utxo { txid: string; vout: number; satoshis: number; rawTxHex: string }
interface AgentState { agent: string; address: string; privKeyHex: string; utxos: Utxo[]; index?: number; stats: any }

let mcpSession: string | null = null
async function mcpInit() {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'universal-tagger', version: '1' } } }),
  })
  mcpSession = r.headers.get('mcp-session-id') || ''
  if (!mcpSession) throw new Error('mcp session')
  await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': mcpSession },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
}
async function mcpCall(name: string, args: any): Promise<any> {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': mcpSession! },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method: 'tools/call', params: { name, arguments: args } }),
  })
  const raw = await r.text()
  const line = raw.split('\n').find(l => l.startsWith('data: '))
  if (!line) {
    try { await mcpInit() } catch {}
    const r2 = await fetch(MCP_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': mcpSession! },
      body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method: 'tools/call', params: { name, arguments: args } }),
    })
    const raw2 = await r2.text()
    const line2 = raw2.split('\n').find(l => l.startsWith('data: '))
    if (!line2) throw new Error('no data after reinit')
    const parsed2 = JSON.parse(line2.slice(6))
    if (parsed2.error) throw new Error(`mcp: ${JSON.stringify(parsed2.error).slice(0, 120)}`)
    return JSON.parse(parsed2.result.content[0].text)
  }
  const parsed = JSON.parse(line.slice(6))
  if (parsed.error) throw new Error(`mcp: ${JSON.stringify(parsed.error).slice(0, 120)}`)
  return JSON.parse(parsed.result.content[0].text)
}

function pickSlot(state: AgentState): { utxo: Utxo; slot: number } | null {
  const n = state.utxos.length
  let idx = state.index || 0
  for (let i = 0; i < n; i++) {
    const slot = (idx + i) % n
    const u = state.utxos[slot]
    if (u && u.satoshis >= MIN_BALANCE) { state.index = (slot + 1) % n; return { utxo: u, slot } }
  }
  return null
}

function shardOf(txid: string, mod: number): number {
  return parseInt(createHash('sha1').update(txid).digest('hex').slice(0, 8), 16) % mod
}

async function fetchPage(offset: number): Promise<Array<{ txid: string; app: string; type: string; timestamp: string | null }>> {
  const r = await fetch(`${OVERLAY_URL}/v1/feed?limit=${PAGE_SIZE}&offset=${offset}`, { signal: AbortSignal.timeout(10000) })
  if (!r.ok) throw new Error(`overlay ${r.status}`)
  const d = await r.json() as any
  return (d.data || []).map((p: any) => ({ txid: p.txid, app: p.app || 'unknown', type: p.type || 'post', timestamp: p.timestamp }))
}

async function tagPost(targetTxid: string, tags: string[], state: AgentState): Promise<string | null> {
  while (true) {
    const pick = pickSlot(state)
    if (!pick) return null
    try {
      const res = await mcpCall('peck_tag_tx', {
        target_txid: targetTxid,
        tags, category: 'archive', lang: 'en',
        signing_key: state.privKeyHex,
        spend_utxo: pick.utxo,
        agent_app: APP_NAME,
      })
      if (!res.success) {
        const s = String(res.status || res.error || '?')
        if (/^465/.test(s)) { await new Promise(r => setTimeout(r, 30000)); continue }
        if (/^(5\d\d|http-5|409)/.test(s)) { await new Promise(r => setTimeout(r, 3000)); continue }
        if (/STORED|ORPHAN/.test(s)) { await new Promise(r => setTimeout(r, 5000)); continue }
        if (/DOUBLE_SPEND|REJECTED/.test(s)) { continue }
        if (/target_txid|required/.test(s)) { return null }
        await new Promise(r => setTimeout(r, 2000)); continue
      }
      state.utxos[pick.slot] = res.new_utxo
      writeFileSync(WALLET_PATH, JSON.stringify(state, null, 2))
      return res.txid
    } catch {
      await new Promise(r => setTimeout(r, 2000))
    }
  }
}

async function main() {
  const state: AgentState = JSON.parse(readFileSync(WALLET_PATH, 'utf-8'))
  const doneState: { done: Record<string, string>; lastOffset: number } = existsSync(STATE_PATH)
    ? JSON.parse(readFileSync(STATE_PATH, 'utf-8')) : { done: {}, lastOffset: 0 }

  await mcpInit()
  console.log(`[u-tag] ${AGENT} shard=${SHARD}/${NUM_SHARDS} resume-offset=${doneState.lastOffset}`)

  let offset = doneState.lastOffset
  let ok = 0, skipped = 0
  const start = Date.now()

  while (true) {
    let posts: Array<{ txid: string; app: string; type: string; timestamp: string | null }>
    try { posts = await fetchPage(offset) }
    catch { await new Promise(r => setTimeout(r, 5000)); continue }

    if (posts.length === 0) { console.log(`[u-tag] end of feed at offset=${offset}`); break }

    const mine = posts.filter(p => shardOf(p.txid, NUM_SHARDS) === SHARD && !doneState.done[p.txid])

    for (const p of mine) {
      const year = p.timestamp ? p.timestamp.slice(0, 4) : 'unknown'
      const tags = ['seen-by-peck-agents', `year:${year}`, `type:${p.type}`, `source:${p.app}`, 'universal-tag']
      const tagTx = await tagPost(p.txid, tags, state)
      if (tagTx) {
        doneState.done[p.txid] = tagTx
        ok++
        if (ok % 25 === 0) {
          writeFileSync(STATE_PATH, JSON.stringify(doneState))
          const elapsed = (Date.now() - start) / 1000
          console.log(`  ${ok}  tps=${(ok/elapsed).toFixed(2)}  offset=${offset}  last=${p.app}:${p.txid.slice(0,10)} tx=${tagTx.slice(0,12)}…`)
        }
      } else skipped++
    }

    offset += PAGE_SIZE
    doneState.lastOffset = offset
    if (offset % 2000 === 0) writeFileSync(STATE_PATH, JSON.stringify(doneState))
  }
  writeFileSync(STATE_PATH, JSON.stringify(doneState))
  console.log(`[u-tag] DONE ok=${ok} skipped=${skipped}`)
}

main().catch(e => { console.error('[u-tag] FAIL:', e.message || e); process.exit(1) })
