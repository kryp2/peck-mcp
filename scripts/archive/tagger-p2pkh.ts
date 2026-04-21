/**
 * tagger-p2pkh.ts — deterministic tagger via mcp.peck.to peck_tag_tx.
 *
 * MCP is the entrypoint. This script just:
 *   1. Reads agent state from .agent-wallets/<agent>.json (current UTXO)
 *   2. Asks Gemini to classify a post
 *   3. Calls MCP peck_tag_tx with {target, tags, signing_key, spend_utxo}
 *   4. If MCP returns success=true: persists new_utxo to JSON
 *   5. If fails: leaves JSON untouched, logs, stops chain
 *
 * The MCP server is the ONLY place that signs + broadcasts. Client is
 * stateless over the wire — only local file state.
 *
 * Usage:
 *   npx tsx scripts/tagger-p2pkh.ts <agent> [count=1]
 */
import 'dotenv/config'
import { readFileSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'

const AGENT = process.argv[2]
const COUNT = parseInt(process.argv[3] || '1', 10)
if (!AGENT) { console.error('need agent name'); process.exit(1) }

const WALLET_PATH = `.agent-wallets/${AGENT}.json`
const OVERLAY_URL = process.env.OVERLAY_URL || 'https://overlay.peck.to'
const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'
const GCP_PROJECT = process.env.GCP_PROJECT || 'gen-lang-client-0447933194'
const MODEL = process.env.MODEL || 'gemini-3.1-flash-lite-preview'
const APP_NAME = process.env.APP_NAME || 'peck.agents'

interface AgentState {
  agent: string
  address: string
  privKeyHex: string
  currentUtxo: { txid: string; vout: number; satoshis: number; rawTxHex: string }
  stats: { emitted: number; totalSpent: number; createdAt: string; lastTagAt?: string }
}

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

async function pickPost(): Promise<any> {
  const r = await fetch(`${OVERLAY_URL}/v1/feed?type=post&limit=30`)
  const d = (await r.json()) as any
  const list = (d.data || []).filter((p: any) => (p.app || '') !== 'peck.agents')
  if (!list.length) throw new Error('no post')
  return list[Math.floor(Math.random() * list.length)]
}

// ─── MCP session ───
let mcpSession: string | null = null
async function mcpInit() {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tagger-p2pkh', version: '0.1.0' } },
    }),
  })
  mcpSession = r.headers.get('mcp-session-id') || ''
  if (!mcpSession) throw new Error('no mcp-session-id')
  await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': mcpSession },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
}
async function mcpCall(name: string, args: any): Promise<any> {
  if (!mcpSession) throw new Error('mcp not initialized')
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': mcpSession },
    body: JSON.stringify({
      jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6),
      method: 'tools/call', params: { name, arguments: args },
    }),
  })
  const raw = await r.text()
  const line = raw.split('\n').find(l => l.startsWith('data: '))
  if (!line) throw new Error(`mcp: no event-stream data`)
  const parsed = JSON.parse(line.slice(6))
  if (parsed.error) throw new Error(`mcp: ${JSON.stringify(parsed.error)}`)
  const resultText = parsed.result?.content?.[0]?.text
  if (!resultText) throw new Error('mcp: no result text')
  return JSON.parse(resultText)
}

async function emitOne(state: AgentState, tok: string): Promise<{ ok: boolean; txid: string; status: string }> {
  const post = await pickPost()
  const cls = await askLLM(`Classify this post. JSON only: {"tags":["3-5 lowercase"],"category":"tech|news|social|art|finance|commerce|meta|personal|other","lang":"ISO","tone":"technical|casual|promotional|question|opinion|announcement|other"}. Ground only in text. Empty/link: tags=["empty"|"link-only"].

Post (app=${post.app}): ${(post.content || '').trim() || '(empty)'}`, tok)
  if (!Array.isArray(cls.tags) || !cls.tags.length) cls.tags = ['unreadable']

  const res = await mcpCall('peck_tag_tx', {
    target_txid: post.txid,
    tags: cls.tags.map((t: any) => String(t).toLowerCase()),
    category: cls.category,
    lang: cls.lang,
    tone: cls.tone,
    signing_key: state.privKeyHex,
    spend_utxo: state.currentUtxo,
    agent_app: APP_NAME,
  })

  if (!res.success) return { ok: false, txid: res.txid || '', status: res.status || 'unknown' }

  // Truthful: only update local state after ARC-confirmed
  state.currentUtxo = res.new_utxo
  state.stats.emitted += 1
  state.stats.totalSpent += res.fee || 0
  state.stats.lastTagAt = new Date().toISOString()
  writeFileSync(WALLET_PATH, JSON.stringify(state, null, 2))
  return { ok: true, txid: res.txid, status: res.status }
}

async function main() {
  const state: AgentState = JSON.parse(readFileSync(WALLET_PATH, 'utf-8'))
  const tok = await getADCToken()
  if (!tok) throw new Error('no ADC token — run `gcloud auth login`')
  await mcpInit()

  console.log(`[p2pkh-tagger] agent=${AGENT}  addr=${state.address}  balance=${state.currentUtxo.satoshis}  count=${COUNT}`)

  const start = Date.now()
  let ok = 0, fail = 0
  for (let i = 0; i < COUNT; i++) {
    const t0 = Date.now()
    try {
      const r = await emitOne(state, tok)
      if (r.ok) {
        ok++
        console.log(`  [${i + 1}/${COUNT}] ✓ ${r.txid}  (${Date.now() - t0}ms)  balance=${state.currentUtxo.satoshis}`)
      } else {
        fail++
        console.error(`  [${i + 1}/${COUNT}] ❌ status=${r.status}  txid=${r.txid}  — STOPPING chain`)
        break
      }
    } catch (e: any) {
      fail++
      console.error(`  [${i + 1}/${COUNT}] ❌ ${(e.message || String(e)).slice(0, 200)}`)
      break
    }
  }
  const elapsed = (Date.now() - start) / 1000
  console.log(`\n[p2pkh-tagger] ok=${ok}  fail=${fail}  ${elapsed.toFixed(2)}s  ${(ok / elapsed).toFixed(2)} TPS`)
  console.log(`[p2pkh-tagger] final: balance=${state.currentUtxo.satoshis}  total emitted=${state.stats.emitted}`)
}

main().catch(e => { console.error('[p2pkh-tagger] FAIL:', e.message || e); process.exit(1) })
