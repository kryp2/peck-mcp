/**
 * liker-p2pkh-parallel.ts — parallel heuristic like-bots, verified on chain.
 *
 * Each agent runs its own like loop with a unique offset into the feed
 * (so they don't all like the same posts). No LLM. Pure heuristic +
 * deterministic P2PKH via MCP peck_like_tx.
 *
 * Usage:
 *   npx tsx scripts/liker-p2pkh-parallel.ts <likes-per-agent> <agent1,agent2,...>
 */
import 'dotenv/config'
import { readFileSync, writeFileSync } from 'fs'

const COUNT = parseInt(process.argv[2] || '5', 10)
const AGENTS = (process.argv[3] || '').split(',').map(s => s.trim()).filter(Boolean)
if (!AGENTS.length) { console.error('need agents'); process.exit(1) }

const OVERLAY_URL = process.env.OVERLAY_URL || 'https://overlay.peck.to'
const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'
const JB = 'https://junglebus.gorillapool.io/v1/transaction/get'
const APP_NAME = process.env.APP_NAME || 'peck.agents'
const VERIFY_WAIT_SEC = parseInt(process.env.VERIFY_WAIT_SEC || '60', 10)

interface MCPClient { session: string }
async function mcpInit(): Promise<MCPClient> {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'liker-parallel', version: '1' } } }),
  })
  const session = r.headers.get('mcp-session-id') || ''
  if (!session) throw new Error('mcp')
  await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': session },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
  return { session }
}
async function mcpCall(cli: MCPClient, name: string, args: any): Promise<any> {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': cli.session },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method: 'tools/call', params: { name, arguments: args } }),
  })
  const raw = await r.text()
  const line = raw.split('\n').find(l => l.startsWith('data: '))
  if (!line) throw new Error('no data line')
  const parsed = JSON.parse(line.slice(6))
  if (parsed.error) throw new Error(`mcp: ${JSON.stringify(parsed.error).slice(0, 160)}`)
  return JSON.parse(parsed.result.content[0].text)
}

async function pickPool(): Promise<string[]> {
  const r = await fetch(`${OVERLAY_URL}/v1/feed?type=post&limit=200`)
  const d = (await r.json()) as any
  const out: string[] = []
  for (const p of d.data || []) {
    if ((p.app || '') === 'peck.agents') continue
    const c = (p.content || '').trim()
    if (c.length < 20) continue
    if (/TPS probe|probe-\d+|Hello.*from/i.test(c)) continue
    out.push(p.txid)
  }
  return out
}

interface AgentState {
  agent: string; address: string; privKeyHex: string
  currentUtxo: { txid: string; vout: number; satoshis: number; rawTxHex: string }
  stats: { emitted: number; totalSpent: number; createdAt: string; lastLikeAt?: string; likes?: number }
}

async function runAgent(name: string, cli: MCPClient, pool: string[], agentIdx: number) {
  const path = `.agent-wallets/${name}.json`
  const state: AgentState = JSON.parse(readFileSync(path, 'utf-8'))
  if (!state.stats.likes) state.stats.likes = 0
  const startBal = state.currentUtxo.satoshis
  const start = Date.now()
  const txids: string[] = []
  let ok = 0, fail = 0

  for (let i = 0; i < COUNT; i++) {
    // Each agent takes different slots in pool: agentIdx*COUNT + i
    const target = pool[(agentIdx * COUNT + i) % pool.length]
    try {
      const res = await mcpCall(cli, 'peck_like_tx', {
        target_txid: target,
        signing_key: state.privKeyHex,
        spend_utxo: state.currentUtxo,
        agent_app: APP_NAME,
      })
      if (!res.success) { fail++; break }
      state.currentUtxo = res.new_utxo
      state.stats.emitted += 1
      state.stats.likes! += 1
      state.stats.totalSpent += res.fee || 0
      state.stats.lastLikeAt = new Date().toISOString()
      writeFileSync(path, JSON.stringify(state, null, 2))
      txids.push(res.txid)
      ok++
    } catch (e: any) {
      fail++
      console.error(`  [${name}] fail: ${(e.message || String(e)).slice(0, 100)}`)
      break
    }
  }
  const duration = (Date.now() - start) / 1000
  return { name, ok, fail, duration, txids, spent: startBal - state.currentUtxo.satoshis }
}

async function verify(txid: string): Promise<'found' | 'not-found' | 'error'> {
  try {
    const r = await fetch(`${JB}/${txid}`)
    const text = await r.text()
    if (r.status === 404 || text.includes('tx-not-found')) return 'not-found'
    if (!r.ok) return 'error'
    try { const o = JSON.parse(text); if (o && o.id) return 'found' } catch {}
    return 'error'
  } catch { return 'error' }
}
async function verifyBatch(txids: string[], concurrency = 4) {
  const out: Array<{ txid: string; status: string }> = []
  for (let i = 0; i < txids.length; i += concurrency) {
    const chunk = txids.slice(i, i + concurrency)
    const r = await Promise.all(chunk.map(t => verify(t).then(s => ({ txid: t, status: s }))))
    out.push(...r)
  }
  return out
}

async function main() {
  console.log(`[like-parallel] agents=${AGENTS.length}  likes/agent=${COUNT}  total target=${AGENTS.length * COUNT}`)
  const cli = await mcpInit()
  const pool = await pickPool()
  if (pool.length < COUNT * AGENTS.length) console.warn(`[like-parallel] pool small: ${pool.length} — targets may overlap`)
  console.log(`[like-parallel] pool size: ${pool.length}`)

  const t0 = Date.now()
  const results = await Promise.all(AGENTS.map((a, i) => runAgent(a, cli, pool, i)))
  const wall = (Date.now() - t0) / 1000

  const allTxids = results.flatMap(r => r.txids)
  const totalOk = results.reduce((s, r) => s + r.ok, 0)
  const totalFail = results.reduce((s, r) => s + r.fail, 0)

  console.log(`\n=== PER-AGENT ===`)
  for (const r of results) {
    console.log(`  ${r.name.padEnd(22)} ok=${String(r.ok).padStart(2)}/${COUNT}  fail=${r.fail}  tps=${(r.ok / r.duration).toFixed(2)}  spent=${r.spent}`)
  }
  const sumTps = results.reduce((s, r) => s + r.ok / r.duration, 0)
  console.log(`\n=== GLOBAL (reported) ===`)
  console.log(`  total ok:   ${totalOk}/${AGENTS.length * COUNT}`)
  console.log(`  fail:       ${totalFail}`)
  console.log(`  wall clock: ${wall.toFixed(2)} s`)
  console.log(`  TPS:        ${(totalOk / wall).toFixed(2)}`)
  console.log(`  sum-TPS:    ${sumTps.toFixed(2)}`)

  console.log(`\n[like-parallel] waiting ${VERIFY_WAIT_SEC}s for JungleBus propagation...`)
  await new Promise(r => setTimeout(r, VERIFY_WAIT_SEC * 1000))
  const vr = await verifyBatch(allTxids, 5)
  const found = vr.filter(r => r.status === 'found').length
  const notFound = vr.filter(r => r.status === 'not-found').length
  console.log(`\n=== VERIFICATION ===`)
  console.log(`  emitted: ${allTxids.length}`)
  console.log(`  found:   ${found}  (${(found / Math.max(1, allTxids.length) * 100).toFixed(1)}%)`)
  console.log(`  missing: ${notFound}`)
  console.log(`\n  REAL TPS (on-chain): ${(found / wall).toFixed(2)}`)
  console.log(`  35-agent extrapolation: ${(found / wall / AGENTS.length * 35).toFixed(1)} TPS = ${Math.round(found / wall / AGENTS.length * 35 * 3600 * 12).toLocaleString()} TX / 12h`)
}

main().catch(e => { console.error('[like-parallel] FAIL:', e.message || e); process.exit(1) })
