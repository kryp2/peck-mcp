/**
 * bible-book-roots-init.ts — serial pre-pass to post all book-root TXs for
 * he_wlc + grc_nt under scribe-01's fresh UTXO chain.
 *
 * Why: bible-completer.ts writes .bible-roots.json without file locking. 24
 * parallel scribes racing that file would lose updates (classic RMW race).
 * Pre-populating all he_wlc_book_0..38 and grc_nt_book_0..26 keys here means
 * the parallel run only writes verse-posts (no roots writes) and races are
 * avoided.
 *
 * Reads existing .bible-roots.json, skips keys already present (idempotent).
 * Uses scribe-01's first utxo and chains change-outputs forward — seriell,
 * zero race risk within this process.
 *
 * Usage:
 *   npx tsx scripts/bible-book-roots-init.ts
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync } from 'fs'

const SCRIBE = process.env.ROOTS_SCRIBE || 'scribe-01'
const WALLET_PATH = `.agent-wallets/${SCRIBE}.json`
const ROOTS_FILE = '.bible-roots.json'
const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'
const APP_NAME = 'peck.cross'
const MIN_BALANCE = 200
const TRANSLATIONS = ['he_wlc', 'grc_nt'] as const

interface Utxo { txid: string; vout: number; satoshis: number; rawTxHex: string }
interface AgentState { agent: string; address: string; privKeyHex: string; utxos: Utxo[]; index?: number; stats: any }

let mcpSession: string | null = null
async function mcpInit() {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'book-roots-init', version: '1' } } }),
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
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': mcpSession! },
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

async function emit(tool: string, extra: any, state: AgentState): Promise<string> {
  while (true) {
    const pick = pickSlot(state)
    if (!pick) throw new Error(`${SCRIBE}: no usable slot`)
    try {
      const res = await mcpCall(tool, { ...extra, signing_key: state.privKeyHex, spend_utxo: pick.utxo, agent_app: APP_NAME })
      if (!res.success) {
        const s = String(res.status || '?')
        if (/^465/.test(s)) { await new Promise(r => setTimeout(r, 30000)); continue }
        if (/^(5\d\d|http-5|409)/.test(s)) { await new Promise(r => setTimeout(r, 3000)); continue }
        if (/STORED|SEEN_IN_ORPHAN_MEMPOOL/.test(s)) { await new Promise(r => setTimeout(r, 5000)); continue }
        if (/DOUBLE_SPEND|REJECTED/.test(s)) { throw new Error(`fatal: ${s} ${JSON.stringify(res).slice(0, 200)}`) }
        await new Promise(r => setTimeout(r, 2000)); continue
      }
      state.utxos[pick.slot] = res.new_utxo
      writeFileSync(WALLET_PATH, JSON.stringify(state, null, 2))
      return res.txid
    } catch (e: any) {
      if (String(e.message || '').startsWith('fatal')) throw e
      await new Promise(r => setTimeout(r, 2500))
    }
  }
}

async function main() {
  const state: AgentState = JSON.parse(readFileSync(WALLET_PATH, 'utf-8'))
  const roots: Record<string, string> = existsSync(ROOTS_FILE)
    ? JSON.parse(readFileSync(ROOTS_FILE, 'utf-8')) : {}

  await mcpInit()
  console.log(`[book-roots-init] scribe=${SCRIBE} balance=${state.utxos.reduce((s, u) => s + u.satoshis, 0)} sat  existing_roots=${Object.keys(roots).length}`)

  let posted = 0
  let skipped = 0

  for (const translation of TRANSLATIONS) {
    const translationRoot = roots[translation]
    if (!translationRoot) { console.error(`  skip ${translation}: no translation-root`); continue }

    const dataPath = `.bible-data/${translation}.json`
    const raw = JSON.parse(readFileSync(dataPath, 'utf-8'))
    const books = Array.isArray(raw) ? raw : Object.values(raw) as any[]
    console.log(`\n[${translation}] ${books.length} books, parent=${translationRoot.slice(0, 14)}…`)

    for (let bi = 0; bi < books.length; bi++) {
      const key = `${translation}_book_${bi}`
      if (roots[key]) {
        skipped++
        continue
      }
      const book = books[bi]
      const bookName = book.name || book.abbrev || `book-${bi}`
      const bookTag = bookName.toLowerCase().replace(/\s+/g, '-')
      const testament = translation === 'he_wlc' ? 'testament:ot' :
                        translation === 'grc_nt' ? 'testament:nt' :
                        bi < 39 ? 'testament:ot' : 'testament:nt'
      const tags = ['bible', `book:${bookTag}`, `book-idx:${bi}`, testament,
                    `translation:${translation}`, 'kind:book']
      const txid = await emit('peck_reply_tx', { parent_txid: translationRoot, content: bookName, tags }, state)
      roots[key] = txid
      writeFileSync(ROOTS_FILE, JSON.stringify(roots, null, 2))
      posted++
      console.log(`  ✓ ${translation} bk${String(bi).padStart(2)} ${bookName.padEnd(18)} → ${txid.slice(0, 14)}…`)
    }
  }

  const balance = state.utxos.reduce((s, u) => s + u.satoshis, 0)
  console.log(`\n[book-roots-init] done  posted=${posted}  skipped=${skipped}  final_balance=${balance} sat`)
}

main().catch(e => { console.error('[book-roots-init] FAIL:', e.message || e); process.exit(1) })
