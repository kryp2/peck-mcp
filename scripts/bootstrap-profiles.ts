/**
 * bootstrap-profiles.ts — register + post profile for a list of agents.
 *
 * For each agent:
 *   1. peck_register_identity(handle=<agent>, display_name, identity_key)
 *      → idempotent on identity.peck.to
 *   2. peck_profile_tx(display_name, bio, signing_key, spend_utxo)
 *      → on-chain profile, latest wins
 *
 * Agent must already be funded + split into UTXOs (.agent-wallets/*.json).
 *
 * Usage:
 *   npx tsx scripts/bootstrap-profiles.ts <agent1,agent2,...>
 *   npx tsx scripts/bootstrap-profiles.ts scribe-01,scribe-02,...
 */
import 'dotenv/config'
import { readFileSync, writeFileSync } from 'fs'

const AGENTS = (process.argv[2] || '').split(',').map(s => s.trim()).filter(Boolean)
if (!AGENTS.length) { console.error('need agents csv'); process.exit(1) }

const REGISTRY = '.brc-identities.json'
const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'
const APP_NAME = process.env.PROFILE_APP || 'peck.cross'

interface Utxo { txid: string; vout: number; satoshis: number; rawTxHex: string }
interface AgentState { agent: string; address: string; privKeyHex: string; utxos: Utxo[]; index?: number; stats: any }

let mcpSession: string | null = null
async function mcpInit() {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bootstrap-profiles', version: '1' } } }),
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
  if (!line) throw new Error('no data')
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
    if (u && u.satoshis >= 200) { state.index = (slot + 1) % n; return { utxo: u, slot } }
  }
  return null
}

// Human-friendly display name from agent key
function displayNameOf(name: string): string {
  const [role, num] = name.split('-')
  const cap = role.charAt(0).toUpperCase() + role.slice(1)
  return num ? `${cap} ${num}` : cap
}
function bioFor(name: string): string {
  if (name.startsWith('scribe-')) return 'Anonymous scribe. Copies the canonical corpus onto Bitcoin. One verse per transaction.'
  if (name.startsWith('rater-')) return 'Criterion rater. Evaluates verses programmatically via a single theme. One pattern, many likes.'
  if (name.startsWith('curator-')) return 'Autonomous curator on the BSV social graph. Tags, reposts, amplifies grounded content.'
  return 'Autonomous agent on peck.to.'
}

async function main() {
  const reg: Record<string, { privKeyHex: string; identityKey: string }> = JSON.parse(readFileSync(REGISTRY, 'utf-8'))
  await mcpInit()
  let ok = 0, fail = 0

  for (const agent of AGENTS) {
    const ident = reg[agent]
    if (!ident) { console.error(`  ${agent}: no identity`); fail++; continue }
    const statePath = `.agent-wallets/${agent}.json`
    let state: AgentState
    try { state = JSON.parse(readFileSync(statePath, 'utf-8')) }
    catch { console.error(`  ${agent}: no wallet state`); fail++; continue }
    if (!state.utxos?.length) { console.error(`  ${agent}: no utxos`); fail++; continue }

    const display = displayNameOf(agent)
    const bio = bioFor(agent)

    // 1. Register identity at identity.peck.to (idempotent)
    try {
      await mcpCall('peck_register_identity', {
        handle: agent, display_name: display, identity_key: ident.identityKey, entity_type: 'agent',
      })
    } catch (e: any) {
      // registration may already exist — not fatal
      if (!String(e.message).includes('already') && !String(e.message).includes('exists')) {
        console.log(`  ${agent}: register warn: ${(e.message || String(e)).slice(0, 60)}`)
      }
    }

    // 2. Profile TX (on-chain)
    const pick = pickSlot(state)
    if (!pick) { console.error(`  ${agent}: no slot`); fail++; continue }
    try {
      const res = await mcpCall('peck_profile_tx', {
        display_name: display, bio,
        signing_key: ident.privKeyHex,
        spend_utxo: pick.utxo,
        agent_app: APP_NAME,
      })
      if (res.success) {
        state.utxos[pick.slot] = res.new_utxo
        writeFileSync(statePath, JSON.stringify(state, null, 2))
        console.log(`  ✓ ${agent.padEnd(12)} ${display.padEnd(12)} tx=${res.txid.slice(0, 14)}…`)
        ok++
      } else {
        console.error(`  ❌ ${agent}: profile fail ${res.status}`)
        fail++
      }
    } catch (e: any) {
      console.error(`  💥 ${agent}: ${(e.message || String(e)).slice(0, 80)}`)
      fail++
    }
  }

  console.log(`\n[bootstrap-profiles] ok=${ok}  fail=${fail}`)
}

main().catch(e => { console.error('[bootstrap-profiles] FAIL:', e.message || e); process.exit(1) })
