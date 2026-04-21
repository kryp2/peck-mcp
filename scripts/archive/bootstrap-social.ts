/**
 * bootstrap-social.ts — one-shot burst: every agent follows N random peers,
 * and sends friend requests to K random peers. Generates a visible on-chain
 * social graph between agents (no LLM, no chaining complexity).
 *
 * Each follow/friend is a single TX spending one of the agent's pre-split
 * UTXOs → no chain-depth concerns, no inter-agent conflicts.
 *
 * Usage:
 *   npx tsx scripts/bootstrap-social.ts [follows_per_agent=10] [friends_per_agent=5]
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, readdirSync } from 'fs'

const FOLLOWS = parseInt(process.argv[2] || '10', 10)
const FRIENDS = parseInt(process.argv[3] || '5', 10)
const WALLET_DIR = '.agent-wallets'
const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'
const REGISTRY_FILE = '.brc-identities.json'

interface Utxo { txid: string; vout: number; satoshis: number; rawTxHex: string }
interface AgentState {
  agent: string; address: string; privKeyHex: string
  utxos: Utxo[]; index: number
  stats: any
}

async function mcpInit(): Promise<string> {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bootstrap-social', version: '1' } } }),
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

async function emit(sess: string, state: AgentState, tool: string, extra: any, path: string): Promise<boolean> {
  const pick = pickSlot(state)
  if (!pick) return false
  try {
    const res = await mcpCall(sess, tool, {
      signing_key: state.privKeyHex,
      spend_utxo: pick.utxo,
      agent_app: 'peck.agents',
      ...extra,
    })
    if (!res.success) { console.log(`      ❌ ${tool} ${res.status}`); return false }
    state.utxos[pick.slot] = res.new_utxo
    state.stats.emitted = (state.stats.emitted || 0) + 1
    state.stats.totalSpent = (state.stats.totalSpent || 0) + (res.fee || 0)
    writeFileSync(path, JSON.stringify(state, null, 2))
    return true
  } catch (e: any) {
    console.log(`      💥 ${(e.message || String(e)).slice(0, 80)}`)
    return false
  }
}

async function main() {
  const reg = JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'))
  const wallets = readdirSync(WALLET_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''))
  console.log(`[bootstrap-social] agents=${wallets.length}  follows/agent=${FOLLOWS}  friends/agent=${FRIENDS}`)
  console.log(`[bootstrap-social] ~${wallets.length * (FOLLOWS + FRIENDS)} TXs expected`)

  const sess = await mcpInit()
  const start = Date.now()
  let ok = 0, fail = 0

  for (const agent of wallets) {
    const path = `${WALLET_DIR}/${agent}.json`
    const state: AgentState = JSON.parse(readFileSync(path, 'utf-8'))
    if (!state.utxos) { console.log(`  ${agent}: skip (no multi-utxo state)`); continue }

    // Pick N random peers (not self) as follow targets
    const peers = wallets.filter(w => w !== agent)
    const shuffled = peers.sort(() => Math.random() - 0.5)
    const followTargets = shuffled.slice(0, FOLLOWS)
    const friendTargets = shuffled.slice(FOLLOWS, FOLLOWS + FRIENDS)

    console.log(`  ${agent}  follows=${followTargets.length}  friends=${friendTargets.length}`)
    for (const target of followTargets) {
      const tid = reg[target]?.identityKey
      if (!tid) { fail++; continue }
      const got = await emit(sess, state, 'peck_follow_tx', { target_pubkey: tid }, path)
      if (got) ok++; else fail++
    }
    for (const target of friendTargets) {
      const tid = reg[target]?.identityKey
      const tAddr = reg[target]?.privKeyHex
        ? (await import('@bsv/sdk')).PrivateKey.fromHex(reg[target].privKeyHex).toAddress('mainnet')
        : undefined
      if (!tid || !tAddr) { fail++; continue }
      const got = await emit(sess, state, 'peck_friend_tx', { target_bap_id: tAddr, target_pubkey: tid }, path)
      if (got) ok++; else fail++
    }
  }

  const elapsed = (Date.now() - start) / 1000
  console.log(`\n[bootstrap-social] done: ok=${ok}  fail=${fail}  ${elapsed.toFixed(1)}s  ${(ok / elapsed).toFixed(1)} TPS`)
}

main().catch(e => { console.error('[bootstrap-social] FAIL:', e.message || e); process.exit(1) })
