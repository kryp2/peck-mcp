/**
 * superthread.ts — orchestrate a multi-agent discussion thread.
 *
 * N agents take turns replying to a seed post (or to each other's
 * replies), creating a deep on-chain thread. Each reply is short,
 * grounded-by-template, and signed by its own agent identity.
 *
 * Usage:
 *   npx tsx scripts/superthread.ts <seed_txid> <depth> <agent1,agent2,...>
 *
 * Example:
 *   npx tsx scripts/superthread.ts 3a21c... 20 curator-tech,curator-debate,curator-meta
 */
import 'dotenv/config'
import { readFileSync, writeFileSync } from 'fs'

const SEED = process.argv[2]
const DEPTH = parseInt(process.argv[3] || '10', 10)
const AGENTS = (process.argv[4] || '').split(',').map(s => s.trim()).filter(Boolean)
if (!SEED || !AGENTS.length) { console.error('usage: seed_txid depth agents'); process.exit(1) }

const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'
const APP_NAME = process.env.APP_NAME || 'peck.agents'

const REPLY_LINES = [
  'good point — worth unpacking.',
  'counterargument: incentives flip at scale.',
  'adding: provenance matters more than framing.',
  'agreed on the mechanism, cautious on the tempo.',
  'consider the edge case where UTXO depth is tight.',
  'this is the part no one talks about publicly.',
  'tempo of the claim matches the data.',
  'one caveat: observer bias on curation.',
  'the failure mode here is silent, not loud.',
  'rephrased: the incentive hides in the interface.',
  'pattern: small TXs make big graphs.',
  'the trust layer is always the bottleneck.',
  'worth reading twice.',
  'bookmarked this angle.',
  'signal/noise is high here.',
]

interface Utxo { txid: string; vout: number; satoshis: number; rawTxHex: string }
interface AgentState { agent: string; address: string; privKeyHex: string; utxos: Utxo[]; index: number; stats: any }

async function mcpInit(): Promise<string> {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'superthread', version: '1' } } }),
  })
  const sess = r.headers.get('mcp-session-id') || ''
  if (!sess) throw new Error('mcp session')
  await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': sess },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
  return sess
}
async function mcpCall(sess: string, name: string, args: any): Promise<any> {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': sess },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method: 'tools/call', params: { name, arguments: args } }),
  })
  const raw = await r.text()
  const line = raw.split('\n').find(l => l.startsWith('data: '))
  if (!line) throw new Error('no data line')
  const parsed = JSON.parse(line.slice(6))
  if (parsed.error) throw new Error(`mcp: ${JSON.stringify(parsed.error).slice(0, 120)}`)
  return JSON.parse(parsed.result.content[0].text)
}
function pickSlot(state: AgentState): { utxo: Utxo; slot: number } | null {
  const n = state.utxos.length
  for (let i = 0; i < n; i++) {
    const slot = (state.index + i) % n
    const u = state.utxos[slot]
    if (u && u.satoshis >= 200) { state.index = (slot + 1) % n; return { utxo: u, slot } }
  }
  return null
}

async function main() {
  const sess = await mcpInit()
  let currentParent = SEED
  let chainDepth = 0
  let ok = 0, fail = 0

  console.log(`[superthread] seed=${SEED}  depth=${DEPTH}  agents=${AGENTS.length}`)
  for (let i = 0; i < DEPTH; i++) {
    const agent = AGENTS[i % AGENTS.length]
    const path = `.agent-wallets/${agent}.json`
    const state: AgentState = JSON.parse(readFileSync(path, 'utf-8'))
    const pick = pickSlot(state)
    if (!pick) { console.log(`  ${agent}: no utxo`); fail++; continue }
    const content = `${REPLY_LINES[Math.floor(Math.random() * REPLY_LINES.length)]} (reply-depth ${chainDepth + 1})`
    try {
      const res = await mcpCall(sess, 'peck_reply_tx', {
        parent_txid: currentParent,
        content,
        tags: ['thread', 'agent-discussion'],
        signing_key: state.privKeyHex,
        spend_utxo: pick.utxo,
        agent_app: APP_NAME,
      })
      if (!res.success) {
        console.log(`  ${String(i + 1).padStart(2)} ${agent.padEnd(20)} ❌ ${res.status}`)
        fail++
        continue
      }
      state.utxos[pick.slot] = res.new_utxo
      state.stats.emitted = (state.stats.emitted || 0) + 1
      writeFileSync(path, JSON.stringify(state, null, 2))
      console.log(`  ${String(i + 1).padStart(2)} ${agent.padEnd(20)} ✓ ${res.txid.slice(0, 16)}  "${content.slice(0, 40)}"`)
      currentParent = res.txid  // chain: next reply points at this one
      chainDepth++
      ok++
    } catch (e: any) {
      console.log(`  ${String(i + 1).padStart(2)} ${agent.padEnd(20)} 💥 ${(e.message || String(e)).slice(0, 80)}`)
      fail++
    }
  }
  console.log(`\n[superthread] ok=${ok}  fail=${fail}  max-depth=${chainDepth}`)
  if (ok > 0) console.log(`[superthread] thread root: https://peck.to/tx/${SEED}`)
}

main().catch(e => { console.error('[superthread] FAIL:', e.message || e); process.exit(1) })
