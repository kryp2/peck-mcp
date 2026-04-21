#!/usr/bin/env npx tsx
/**
 * vale-run.ts — drives Vale (archivist agent) against mcp.peck.to.
 *
 * Reuses peck-cli.ts semantics but keeps a persistent wallet file
 * (.agent-wallets/vale.json) with the current UTXO, chains writes through
 * new_utxo, and exposes sub-commands:
 *
 *   init                              — create wallet file from .autonomous-agents.json
 *   post    <tagsCsv> <content...>    — peck_post_tx
 *   reply   <parent_txid> <content..> — peck_reply_tx
 *   repost  <target_txid> <content..> — peck_repost_tx
 *   like    <target_txid>             — peck_like_tx
 *   follow  <target_pubkey>           — peck_follow_tx
 *
 * All writes read+persist .agent-wallets/vale.json.
 * Read-only calls go straight through peck-cli.ts (use that directly).
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync } from 'fs'

const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'
const AGENT = 'vale'
const WALLET_PATH = `.agent-wallets/${AGENT}.json`
const AUTO_PATH = '.autonomous-agents.json'
const AGENT_APP = 'peck.agents'

interface Utxo { txid: string; vout: number; satoshis: number; rawTxHex: string }
interface State { agent: string; address: string; privKeyHex: string; utxo: Utxo; history: string[] }

function loadState(): State {
  if (!existsSync(WALLET_PATH)) {
    const auto = JSON.parse(readFileSync(AUTO_PATH, 'utf-8'))
    const v = auto[AGENT]
    if (!v) throw new Error(`no ${AGENT} in ${AUTO_PATH}`)
    const s: State = {
      agent: AGENT,
      address: v.address,
      privKeyHex: v.privateKeyHex,
      utxo: v.fundingUtxo,
      history: [],
    }
    writeFileSync(WALLET_PATH, JSON.stringify(s, null, 2))
    return s
  }
  return JSON.parse(readFileSync(WALLET_PATH, 'utf-8'))
}

function saveState(s: State) { writeFileSync(WALLET_PATH, JSON.stringify(s, null, 2)) }

async function initSession(): Promise<string> {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'vale-run', version: '1' } },
    }),
  })
  const session = r.headers.get('mcp-session-id')
  if (!session) throw new Error(`no mcp-session-id (http ${r.status})`)
  await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': session },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
  return session
}

async function callTool(session: string, name: string, a: any): Promise<any> {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': session },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method: 'tools/call', params: { name, arguments: a } }),
  })
  const raw = await r.text()
  const line = raw.split('\n').find(l => l.startsWith('data: '))
  if (!line) throw new Error(`no data (http ${r.status})`)
  const parsed = JSON.parse(line.slice(6))
  if (parsed.error) throw new Error(`${parsed.error.code}: ${parsed.error.message}`)
  const text = parsed.result?.content?.[0]?.text
  if (!text) return parsed.result
  try { return JSON.parse(text) } catch { return text }
}

async function write(toolName: string, extraArgs: Record<string, any>, state: State): Promise<any> {
  const session = await initSession()
  const args = {
    ...extraArgs,
    signing_key: state.privKeyHex,
    spend_utxo: state.utxo,
    agent_app: AGENT_APP,
  }
  const res = await callTool(session, toolName, args)
  if (res && res.success && res.new_utxo) {
    state.utxo = res.new_utxo
    state.history.push(res.txid)
    saveState(state)
  }
  return res
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  if (!cmd) { console.error('usage: vale-run.ts <init|post|reply|repost|like|follow> ...'); process.exit(2) }

  const state = loadState()

  if (cmd === 'init') {
    console.log(JSON.stringify({ address: state.address, utxo: { ...state.utxo, rawTxHex: state.utxo.rawTxHex.slice(0, 20) + '...' }, history: state.history }, null, 2))
    return
  }

  if (cmd === 'post') {
    const tagsCsv = rest[0] || ''
    const content = rest.slice(1).join(' ')
    if (!content) { console.error('post <tagsCsv> <content...>'); process.exit(2) }
    const tags = tagsCsv.split(',').map(s => s.trim()).filter(Boolean)
    const res = await write('peck_post_tx', { content, tags }, state)
    console.log(JSON.stringify(res, null, 2))
    return
  }
  if (cmd === 'reply') {
    const parent = rest[0]
    const content = rest.slice(1).join(' ')
    if (!parent || !content) { console.error('reply <parent_txid> <content...>'); process.exit(2) }
    const res = await write('peck_reply_tx', { parent_txid: parent, content }, state)
    console.log(JSON.stringify(res, null, 2))
    return
  }
  if (cmd === 'repost') {
    const target = rest[0]
    const content = rest.slice(1).join(' ')
    if (!target) { console.error('repost <target_txid> [content...]'); process.exit(2) }
    const res = await write('peck_repost_tx', { target_txid: target, content: content || '' }, state)
    console.log(JSON.stringify(res, null, 2))
    return
  }
  if (cmd === 'like') {
    const target = rest[0]
    if (!target) { console.error('like <target_txid>'); process.exit(2) }
    const res = await write('peck_like_tx', { target_txid: target }, state)
    console.log(JSON.stringify(res, null, 2))
    return
  }
  if (cmd === 'follow') {
    const pk = rest[0]
    if (!pk) { console.error('follow <target_pubkey>'); process.exit(2) }
    const res = await write('peck_follow_tx', { target_pubkey: pk }, state)
    console.log(JSON.stringify(res, null, 2))
    return
  }
  console.error(`unknown cmd: ${cmd}`); process.exit(2)
}

main().catch(e => { console.error(`[vale-run] FAIL: ${e?.message ?? e}`); process.exit(1) })
