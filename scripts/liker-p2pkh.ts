/**
 * liker-p2pkh.ts — heuristic like-bot, no LLM.
 *
 * Reads recent feed, applies a simple filter (skip own/other-agent posts,
 * skip very short content, pick every Nth), calls MCP peck_like_tx with
 * {target_txid, signing_key, spend_utxo}, updates local state JSON on
 * ARC-confirmed success.
 *
 * Same pattern as tagger-p2pkh but ~10× faster per agent because no LLM.
 *
 * Usage:
 *   npx tsx scripts/liker-p2pkh.ts <agent> [count=5]
 *   npx tsx scripts/liker-p2pkh.ts <agent> [count=5] <offset=0>
 */
import 'dotenv/config'
import { readFileSync, writeFileSync } from 'fs'

const AGENT = process.argv[2]
const COUNT = parseInt(process.argv[3] || '5', 10)
const OFFSET = parseInt(process.argv[4] || '0', 10)
if (!AGENT) { console.error('need agent'); process.exit(1) }

const WALLET_PATH = `.agent-wallets/${AGENT}.json`
const OVERLAY_URL = process.env.OVERLAY_URL || 'https://overlay.peck.to'
const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'
const APP_NAME = process.env.APP_NAME || 'peck.agents'
const FEED_LIMIT = parseInt(process.env.FEED_LIMIT || '100', 10)

interface AgentState {
  agent: string; address: string; privKeyHex: string
  currentUtxo: { txid: string; vout: number; satoshis: number; rawTxHex: string }
  stats: { emitted: number; totalSpent: number; createdAt: string; lastTagAt?: string; lastLikeAt?: string; likes?: number }
}

let mcpSession: string | null = null
async function mcpInit() {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'liker', version: '1' } } }),
  })
  mcpSession = r.headers.get('mcp-session-id') || ''
  if (!mcpSession) throw new Error('no mcp session')
  await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': mcpSession },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
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
  if (!line) throw new Error('no data line')
  const parsed = JSON.parse(line.slice(6))
  if (parsed.error) throw new Error(`mcp: ${JSON.stringify(parsed.error).slice(0, 200)}`)
  return JSON.parse(parsed.result.content[0].text)
}

async function pickLikeTargets(limit: number, startOffset: number): Promise<string[]> {
  const r = await fetch(`${OVERLAY_URL}/v1/feed?type=post&limit=${FEED_LIMIT}`)
  const d = (await r.json()) as any
  // Heuristic: skip own-app posts (peck.agents own noise), skip very thin content,
  // skip obvious TPS-probe-style repeats
  const candidates: string[] = []
  for (const p of d.data || []) {
    if ((p.app || '') === 'peck.agents') continue
    const c = (p.content || '').trim()
    if (c.length < 20) continue
    if (/TPS probe|probe-\d+|Hello.*from/i.test(c)) continue
    candidates.push(p.txid)
  }
  // Pick every Nth starting at offset to diversify across multiple like-bots
  const step = Math.max(1, Math.floor(candidates.length / limit))
  const chosen: string[] = []
  for (let i = startOffset; i < candidates.length && chosen.length < limit; i += step) {
    chosen.push(candidates[i])
  }
  return chosen
}

async function main() {
  const state: AgentState = JSON.parse(readFileSync(WALLET_PATH, 'utf-8'))
  if (!state.stats.likes) state.stats.likes = 0
  await mcpInit()

  const targets = await pickLikeTargets(COUNT, OFFSET)
  if (!targets.length) throw new Error('no like targets found in feed')
  console.log(`[like] ${AGENT}  balance=${state.currentUtxo.satoshis}  count=${COUNT}  picked ${targets.length} targets`)

  const start = Date.now()
  let ok = 0, fail = 0
  for (let i = 0; i < targets.length; i++) {
    const t0 = Date.now()
    try {
      const res = await mcpCall('peck_like_tx', {
        target_txid: targets[i],
        signing_key: state.privKeyHex,
        spend_utxo: state.currentUtxo,
        agent_app: APP_NAME,
      })
      if (!res.success) {
        fail++
        console.error(`  [${i + 1}/${targets.length}] ❌ status=${res.status}  (chain halts)`)
        break
      }
      state.currentUtxo = res.new_utxo
      state.stats.emitted += 1
      state.stats.likes! += 1
      state.stats.totalSpent += res.fee || 0
      state.stats.lastLikeAt = new Date().toISOString()
      writeFileSync(WALLET_PATH, JSON.stringify(state, null, 2))
      ok++
      console.log(`  [${i + 1}/${targets.length}] ✓ ${res.txid}  (${Date.now() - t0}ms)`)
    } catch (e: any) {
      fail++
      console.error(`  [${i + 1}/${targets.length}] ❌ ${(e.message || String(e)).slice(0, 120)}`)
      break
    }
  }
  const elapsed = (Date.now() - start) / 1000
  console.log(`\n[like] ok=${ok}  fail=${fail}  ${elapsed.toFixed(2)}s  ${(ok / elapsed).toFixed(2)} TPS  balance=${state.currentUtxo.satoshis}`)
}

main().catch(e => { console.error('[like] FAIL:', e.message || e); process.exit(1) })
