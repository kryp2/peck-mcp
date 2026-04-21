/**
 * bible-roots-init.ts — post one root-TX per translation, shared by all scribes.
 *
 * Each of the 6 translations gets ONE top-level post (kind=translation) that
 * every book in that translation replies to. Gives a clean thread:
 *
 *   translation-root
 *    └─ book
 *        └─ chapter
 *            └─ verse
 *
 * Run ONCE from scribe-01 before any bible-posters start. Writes
 * `.bible-roots.json` → { translation_code: root_txid } so all scribes
 * (scribe-01..scribe-24) read the same shared roots.
 *
 * Idempotent: skips translations already in .bible-roots.json.
 *
 * Usage:
 *   npx tsx scripts/bible-roots-init.ts
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync } from 'fs'

const SCRIBE = process.env.ROOTS_SCRIBE || 'scribe-01'
const WALLET_PATH = `.agent-wallets/${SCRIBE}.json`
const ROOTS_FILE = '.bible-roots.json'
const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'
const APP_NAME = 'peck.cross'
const MIN_BALANCE = 200

const TRANSLATION_META: Record<string, { lang: string; version: string; verses: number; canon?: string }> = {
  en_kjv:         { lang: 'en',  version: 'King James Version (1769)',                verses: 31100, canon: 'protestant' },
  en_bbe:         { lang: 'en',  version: 'Bible in Basic English (1949)',            verses: 31104, canon: 'protestant' },
  en_asv:         { lang: 'en',  version: 'American Standard Version (1901)',         verses: 31103, canon: 'protestant' },
  pt_aa:          { lang: 'pt',  version: 'Almeida Atualizada (Imprensa Bíblica, 1948)', verses: 31104, canon: 'protestant' },
  es_rvr:         { lang: 'es',  version: 'Reina-Valera (1909)',                      verses: 31102, canon: 'protestant' },
  de_schlachter:  { lang: 'de',  version: 'Schlachter (1905)',                        verses: 31101, canon: 'protestant' },
  en_dr:          { lang: 'en',  version: 'Douay-Rheims (1899 Challoner)',            verses: 35804, canon: 'catholic' },
  la_vulgata:     { lang: 'la',  version: 'Clementine Vulgate',                       verses: 35809, canon: 'catholic' },
  he_wlc:         { lang: 'he',  version: 'Westminster Leningrad Codex',              verses: 23213, canon: 'jewish' },
  grc_nt:         { lang: 'grc', version: 'Byzantine Majority Text (Robinson-Pierpont, 2005)', verses: 7953, canon: 'greek-nt' },
  no_1930:        { lang: 'no',  version: 'Bibelen 1930 (Det Norske Bibelselskap)',   verses: 31102, canon: 'protestant' },
}

interface Utxo { txid: string; vout: number; satoshis: number; rawTxHex: string }
interface AgentState { agent: string; address: string; privKeyHex: string; utxos: Utxo[]; index?: number; stats: any }

let mcpSession: string | null = null
async function mcpInit() {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bible-roots-init', version: '1' } } }),
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
    if (u && u.satoshis >= MIN_BALANCE) { state.index = (slot + 1) % n; return { utxo: u, slot } }
  }
  return null
}

async function postRoot(code: string, meta: { lang: string; version: string; verses: number }, state: AgentState): Promise<string> {
  const content =
    `${meta.version}\n` +
    `Public domain. 66 books, 1,189 chapters, ${meta.verses.toLocaleString('en-US')} verses.\n` +
    `Posted verse-by-verse as a tree on Bitcoin by anonymous scribes.`
  const tags = [
    'bible', `translation:${code}`, `version:${meta.version}`,
    `lang:${meta.lang}`, 'kind:translation', 'root',
  ]
  while (true) {
    const pick = pickSlot(state)
    if (!pick) throw new Error(`${SCRIBE}: no usable slot for ${code} root`)
    try {
      const res = await mcpCall('peck_post_tx', {
        content, tags, channel: 'bible',
        signing_key: state.privKeyHex,
        spend_utxo: pick.utxo,
        agent_app: APP_NAME,
      })
      if (!res.success) {
        const s = String(res.status || '?')
        if (/^465/.test(s)) { await new Promise(r => setTimeout(r, 30000)); continue }
        if (/^(5\d\d|http-5|409)/.test(s)) { await new Promise(r => setTimeout(r, 3000)); continue }
        if (/STORED|ORPHAN/.test(s)) { await new Promise(r => setTimeout(r, 5000)); continue }
        if (/DOUBLE_SPEND|REJECTED/.test(s)) { continue }
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
  const roots: Record<string, string> = existsSync(ROOTS_FILE)
    ? JSON.parse(readFileSync(ROOTS_FILE, 'utf-8')) : {}

  await mcpInit()
  console.log(`[bible-roots-init] scribe=${SCRIBE} existing=${Object.keys(roots).length}`)

  for (const [code, meta] of Object.entries(TRANSLATION_META)) {
    if (roots[code]) { console.log(`  ${code}: already = ${roots[code].slice(0, 14)}…`); continue }
    const txid = await postRoot(code, meta, state)
    roots[code] = txid
    writeFileSync(ROOTS_FILE, JSON.stringify(roots, null, 2))
    console.log(`  ✓ ${code.padEnd(14)} ${meta.version.padEnd(48)} root=${txid.slice(0, 14)}…`)
  }

  console.log(`[bible-roots-init] done  roots=${Object.keys(roots).length}`)
}

main().catch(e => { console.error('[bible-roots-init] FAIL:', e.message || e); process.exit(1) })
