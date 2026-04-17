/**
 * tagger-p2pkh-parallel.ts — run N agent P2PKH taggers in parallel via MCP,
 * then verify each reported txid against JungleBus.
 *
 * Each agent's loop is independent: own JSON state file, own UTXO chain,
 * no shared wallet-infra state. MCP peck_tag_tx handles sign+broadcast.
 *
 * Usage:
 *   npx tsx scripts/tagger-p2pkh-parallel.ts <iter-per-agent> <agent1,agent2,...>
 */
import 'dotenv/config'
import { readFileSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'

const ITER = parseInt(process.argv[2] || '5', 10)
const AGENTS = (process.argv[3] || '').split(',').map(s => s.trim()).filter(Boolean)
if (!AGENTS.length) { console.error('need agents'); process.exit(1) }

const OVERLAY_URL = process.env.OVERLAY_URL || 'https://overlay.peck.to'
const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'
const JB = 'https://junglebus.gorillapool.io/v1/transaction/get'
const GCP_PROJECT = process.env.GCP_PROJECT || 'gen-lang-client-0447933194'
const MODEL = process.env.MODEL || 'gemini-3.1-flash-lite-preview'
const APP_NAME = process.env.APP_NAME || 'peck.agents'
const VERIFY_WAIT_SEC = parseInt(process.env.VERIFY_WAIT_SEC || '60', 10)

async function getADCToken(): Promise<string | null> {
  try {
    const r = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(500) },
    )
    if (r.ok) return ((await r.json()) as any).access_token
  } catch {}
  try { return execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf-8' }).trim() } catch {}
  return null
}

async function askLLM(prompt: string, tok: string): Promise<any> {
  const url = `https://aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/global/publishers/google/models/${MODEL}:generateContent`
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 300, temperature: 0.2, responseMimeType: 'application/json' },
    }),
  })
  if (!r.ok) throw new Error(`Vertex ${r.status}`)
  return JSON.parse(((await r.json()) as any).candidates?.[0]?.content?.parts?.[0]?.text || '{}')
}

interface MCPClient { session: string }
async function mcpInit(): Promise<MCPClient> {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tagger-parallel', version: '1' } },
    }),
  })
  const session = r.headers.get('mcp-session-id') || ''
  if (!session) throw new Error('mcp session')
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
    body: JSON.stringify({
      jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6),
      method: 'tools/call', params: { name, arguments: args },
    }),
  })
  const raw = await r.text()
  const line = raw.split('\n').find(l => l.startsWith('data: '))
  if (!line) throw new Error('mcp: no data line')
  const parsed = JSON.parse(line.slice(6))
  if (parsed.error) throw new Error(`mcp: ${JSON.stringify(parsed.error).slice(0, 200)}`)
  return JSON.parse(parsed.result.content[0].text)
}

async function pickPostPool(): Promise<any[]> {
  const r = await fetch(`${OVERLAY_URL}/v1/feed?type=post&limit=60`)
  const d = (await r.json()) as any
  return (d.data || []).filter((p: any) => (p.app || '') !== 'peck.agents')
}

interface AgentState {
  agent: string; address: string; privKeyHex: string
  currentUtxo: { txid: string; vout: number; satoshis: number; rawTxHex: string }
  stats: { emitted: number; totalSpent: number; createdAt: string; lastTagAt?: string }
}

async function runAgent(name: string, cli: MCPClient, pool: any[], tok: string) {
  const path = `.agent-wallets/${name}.json`
  const state: AgentState = JSON.parse(readFileSync(path, 'utf-8'))
  const startBalance = state.currentUtxo.satoshis
  const start = Date.now()
  const txids: Array<{ txid: string; targetTxid: string }> = []
  let ok = 0, fail = 0

  for (let i = 0; i < ITER; i++) {
    const post = pool[(i * 7 + name.length) % pool.length]
    try {
      const cls = await askLLM(`Classify post. JSON: {"tags":["3-5 lowercase"],"category":"tech|news|social|art|finance|commerce|meta|personal|other","lang":"ISO","tone":"technical|casual|promotional|question|opinion|announcement|other"}. Ground only in text. Empty/link: tags=["empty"|"link-only"].

Post (app=${post.app}): ${(post.content || '').trim() || '(empty)'}`, tok)
      if (!Array.isArray(cls.tags) || !cls.tags.length) cls.tags = ['unreadable']

      const res = await mcpCall(cli, 'peck_tag_tx', {
        target_txid: post.txid,
        tags: cls.tags.map((t: any) => String(t).toLowerCase()),
        category: cls.category, lang: cls.lang, tone: cls.tone,
        signing_key: state.privKeyHex,
        spend_utxo: state.currentUtxo,
        agent_app: APP_NAME,
      })
      if (!res.success) { fail++; break }

      state.currentUtxo = res.new_utxo
      state.stats.emitted += 1
      state.stats.totalSpent += res.fee || 0
      state.stats.lastTagAt = new Date().toISOString()
      writeFileSync(path, JSON.stringify(state, null, 2))
      txids.push({ txid: res.txid, targetTxid: post.txid })
      ok++
    } catch (e: any) {
      fail++
      console.error(`  [${name}] fail: ${(e.message || String(e)).slice(0, 100)}`)
      break
    }
  }
  const duration = (Date.now() - start) / 1000
  return {
    name, ok, fail, duration,
    tps: ok / duration,
    txids,
    spent: startBalance - state.currentUtxo.satoshis,
  }
}

async function verifyChain(txid: string): Promise<'found' | 'not-found' | 'error'> {
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
    const r = await Promise.all(chunk.map(t => verifyChain(t).then(s => ({ txid: t, status: s }))))
    out.push(...r)
  }
  return out
}

async function main() {
  console.log(`[parallel-p2pkh] agents=${AGENTS.length}  iter/agent=${ITER}  total target=${AGENTS.length * ITER}`)
  const cli = await mcpInit()
  const pool = await pickPostPool()
  if (pool.length < ITER) throw new Error(`pool too small: ${pool.length}`)
  const tok = await getADCToken()
  if (!tok) throw new Error('no ADC')

  console.log(`[parallel-p2pkh] starting all agents in parallel...\n`)
  const t0 = Date.now()
  const results = await Promise.all(AGENTS.map(name => runAgent(name, cli, pool, tok)))
  const wall = (Date.now() - t0) / 1000

  const totalOk = results.reduce((s, r) => s + r.ok, 0)
  const totalFail = results.reduce((s, r) => s + r.fail, 0)
  const allTxids: Array<{ txid: string; targetTxid: string; agent: string }> = []
  for (const r of results) for (const t of r.txids) allTxids.push({ ...t, agent: r.name })

  console.log(`\n=== PER-AGENT ===`)
  for (const r of results) {
    console.log(`  ${r.name.padEnd(22)} ok=${String(r.ok).padStart(2)}/${ITER}  fail=${r.fail}  tps=${r.tps.toFixed(2)}  spent=${r.spent}`)
  }
  console.log(`\n=== GLOBAL (reported) ===`)
  console.log(`  total ok:   ${totalOk}/${AGENTS.length * ITER}`)
  console.log(`  wall clock: ${wall.toFixed(2)} s`)
  console.log(`  TPS:        ${(totalOk / wall).toFixed(2)}`)
  console.log(`  sum-TPS:    ${results.reduce((s, r) => s + r.tps, 0).toFixed(2)}`)

  console.log(`\n[parallel-p2pkh] waiting ${VERIFY_WAIT_SEC}s for JungleBus propagation...`)
  await new Promise(r => setTimeout(r, VERIFY_WAIT_SEC * 1000))

  console.log(`[parallel-p2pkh] verifying ${allTxids.length} txids...`)
  const verifyResults = await verifyBatch(allTxids.map(x => x.txid), 5)
  const found = verifyResults.filter(r => r.status === 'found').length
  const notFound = verifyResults.filter(r => r.status === 'not-found').length
  const verror = verifyResults.filter(r => r.status === 'error').length

  console.log(`\n=== VERIFICATION (JungleBus) ===`)
  console.log(`  emitted:  ${allTxids.length}`)
  console.log(`  found:    ${found}  (${(found / Math.max(1, allTxids.length) * 100).toFixed(1)}%)`)
  console.log(`  NOT found:${notFound}`)
  console.log(`  error:    ${verror}`)
  console.log(`\n  REAL TPS (on-chain verified): ${(found / wall).toFixed(2)}`)
  console.log(`  35-agent extrapolation: ${(found / wall / AGENTS.length * 35).toFixed(1)} TPS = ${Math.round(found / wall / AGENTS.length * 35 * 3600 * 12).toLocaleString()} TX / 12h`)

  if (notFound > 0) {
    console.log(`\nMISSING (sample):`)
    for (const r of verifyResults.filter(r => r.status === 'not-found').slice(0, 3)) console.log(`  ${r.txid}`)
  }
}

main().catch(e => { console.error('[parallel-p2pkh] FAIL:', e.message || e); process.exit(1) })
