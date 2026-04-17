/**
 * bible-retro-tagger.ts — add missing metadata to already-posted bible TXs.
 *
 * Bible is immutable once on chain. This emits a NEW peck_tag_tx per
 * existing book/chapter/verse that attaches supplementary metadata
 * (version name, language full name, book ordinal, testament, etc.)
 * linked to the original via context=tx + tx=<target_txid>.
 *
 * Each retro-tag is its own signed TX — agents can evolve metadata
 * without rewriting the canonical corpus.
 *
 * Usage:
 *   npx tsx scripts/bible-retro-tagger.ts <scribe> <translation>
 *
 * Reads .bible-progress/<scribe>_<translation>.json and emits one
 * tag-TX per book_txid + chapter_txid + verse_txid (derived from thread).
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'

const SCRIBE = process.argv[2]
const TRANSLATION = process.argv[3]
if (!SCRIBE || !TRANSLATION) { console.error('need <scribe> <translation>'); process.exit(1) }

const WALLET_PATH = `.agent-wallets/${SCRIBE}.json`
const PROGRESS_PATH = `.bible-progress/${SCRIBE}_${TRANSLATION}.json`
const RETRO_STATE_DIR = '.bible-retro-state'
if (!existsSync(RETRO_STATE_DIR)) mkdirSync(RETRO_STATE_DIR)
const RETRO_STATE = `${RETRO_STATE_DIR}/${SCRIBE}_${TRANSLATION}.json`

const OVERLAY_URL = process.env.OVERLAY_URL || 'https://overlay.peck.to'
const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'
const APP_NAME = 'peck.cross'
const MIN_BALANCE = 200

const TRANSLATION_META: Record<string, { lang: string; version: string }> = {
  en_kjv:         { lang: 'en', version: 'King James Version (1769)' },
  en_bbe:         { lang: 'en', version: 'Bible in Basic English (1949)' },
  en_asv:         { lang: 'en', version: 'American Standard Version (1901)' },
  pt_aa:          { lang: 'pt', version: 'Almeida Atualizada (Imprensa Bíblica, 1948)' },
  es_rvr:         { lang: 'es', version: 'Reina-Valera (1909)' },
  de_schlachter:  { lang: 'de', version: 'Schlachter (1905)' },
}

interface Utxo { txid: string; vout: number; satoshis: number; rawTxHex: string }
interface AgentState { agent: string; address: string; privKeyHex: string; utxos: Utxo[]; index?: number; stats: any }

let mcpSession: string | null = null
async function mcpInit() {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bible-retro-tagger', version: '1' } } }),
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

async function tagTarget(targetTxid: string, tags: string[], category: string, lang: string, state: AgentState): Promise<string | null> {
  while (true) {
    const pick = pickSlot(state)
    if (!pick) return null
    try {
      const res = await mcpCall('peck_tag_tx', {
        target_txid: targetTxid,
        tags, category, lang,
        tone: 'metadata',
        signing_key: state.privKeyHex,
        spend_utxo: pick.utxo,
        agent_app: APP_NAME,
      })
      if (!res.success) {
        const s = String(res.status || '?')
        if (/^465/.test(s)) { await new Promise(r => setTimeout(r, 30000)); continue }
        if (/^(5\d\d|http-5)/.test(s)) { await new Promise(r => setTimeout(r, 3000)); continue }
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
  const progress = JSON.parse(readFileSync(PROGRESS_PATH, 'utf-8'))
  const state: AgentState = JSON.parse(readFileSync(WALLET_PATH, 'utf-8'))
  const meta = TRANSLATION_META[TRANSLATION] || { lang: 'unknown', version: TRANSLATION }
  const retroState: { done: Record<string, string> } = existsSync(RETRO_STATE)
    ? JSON.parse(readFileSync(RETRO_STATE, 'utf-8')) : { done: {} }

  await mcpInit()

  const verseTxids: Array<{ key: string; txid: string; book: number; chapter: number; verse?: number; kind: 'book' | 'chapter' | 'verse' }> = []

  // Books
  for (const [bookIdx, txid] of Object.entries(progress.book_txids)) {
    const bi = parseInt(bookIdx, 10)
    verseTxids.push({ key: `book:${bi}`, txid: txid as string, book: bi, chapter: -1, kind: 'book' })
  }
  // Chapters
  for (const [key, txid] of Object.entries(progress.chapter_txids)) {
    const [bi, ci] = key.split('_').map(Number)
    verseTxids.push({ key: `chapter:${bi}:${ci}`, txid: txid as string, book: bi, chapter: ci, kind: 'chapter' })
  }
  // Verses — need to fetch from overlay (by parent=chapter_txid)
  console.log(`[retro-tag] fetching verse-txids from overlay for ${Object.keys(progress.chapter_txids).length} chapters...`)
  for (const [key, chTxid] of Object.entries(progress.chapter_txids)) {
    const [bi, ci] = key.split('_').map(Number)
    try {
      const r = await fetch(`${OVERLAY_URL}/v1/thread/${chTxid}`)
      const d = await r.json() as any
      for (const p of (d.replies || d.data || [])) {
        const tagsStr = (p.tags || '').toLowerCase()
        const m = tagsStr.match(/verse:(\d+)/)
        if (!m) continue
        verseTxids.push({ key: `verse:${bi}:${ci}:${m[1]}`, txid: p.txid, book: bi, chapter: ci, verse: parseInt(m[1], 10), kind: 'verse' })
      }
    } catch (e: any) {
      console.error(`  chapter ${key}: ${(e.message || String(e)).slice(0, 60)}`)
    }
  }

  const remaining = verseTxids.filter(v => !retroState.done[v.key])
  console.log(`[retro-tag] ${SCRIBE} ${TRANSLATION}  total=${verseTxids.length}  remaining=${remaining.length}`)

  let ok = 0
  for (const v of remaining) {
    const retroTags = [
      `version:${meta.version}`,
      `translation-name:${TRANSLATION}`,
      `kind:${v.kind}`,
      'retroactive-metadata',
    ]
    const tagTx = await tagTarget(v.txid, retroTags, 'scripture', meta.lang, state)
    if (tagTx) {
      retroState.done[v.key] = tagTx
      ok++
      if (ok % 10 === 0) {
        writeFileSync(RETRO_STATE, JSON.stringify(retroState, null, 2))
        console.log(`  ${ok}/${remaining.length}  last=${tagTx.slice(0, 12)}…`)
      }
    }
  }
  writeFileSync(RETRO_STATE, JSON.stringify(retroState, null, 2))
  console.log(`[retro-tag] done  ok=${ok}`)
}

main().catch(e => { console.error('[retro-tag] FAIL:', e.message || e); process.exit(1) })
