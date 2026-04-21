/**
 * bible-completer.ts — smart scribe that fills gaps using overlay as source of truth.
 *
 * Instead of local progress files, queries overlay for what's already posted,
 * then posts only missing verses. Self-healing, no duplicates, resumable.
 *
 * Usage:
 *   npx tsx scripts/bible-completer.ts <agent> <translation> <book_start> <book_end>
 *   e.g.: npx tsx scripts/bible-completer.ts scribe-01 no_1930 0 66
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync } from 'fs'

const AGENT = process.argv[2]
const TRANSLATION = process.argv[3]
const BOOK_START = parseInt(process.argv[4] || '0', 10)
const BOOK_END = parseInt(process.argv[5] || '999', 10)
if (!AGENT || !TRANSLATION) { console.error('need <agent> <translation> [book_start] [book_end]'); process.exit(1) }

const WALLET_PATH = `.agent-wallets/${AGENT}.json`
const OVERLAY_URL = process.env.OVERLAY_URL || 'https://overlay.peck.to'
const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'
const APP_NAME = 'peck.cross'
const ROOTS_FILE = '.bible-roots.json'
const MIN_BALANCE = 200

interface Utxo { txid: string; vout: number; satoshis: number; rawTxHex: string }
interface AgentState { agent: string; address: string; privKeyHex: string; utxos: Utxo[]; index?: number; stats: any }

// ── MCP session ──
let mcpSession: string | null = null
async function mcpInit() {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bible-completer', version: '1' } } }),
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
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': mcpSession! },
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

// ── UTXO management ──
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

async function emit(tool: string, extra: any, state: AgentState): Promise<string | null> {
  while (true) {
    const pick = pickSlot(state)
    if (!pick) return null
    try {
      const res = await mcpCall(tool, { ...extra, signing_key: state.privKeyHex, spend_utxo: pick.utxo, agent_app: APP_NAME })
      if (!res.success) {
        const s = String(res.status || '?')
        if (/^465/.test(s)) { await new Promise(r => setTimeout(r, 30000)); continue }
        if (/^(5\d\d|http-5|409)/.test(s)) { await new Promise(r => setTimeout(r, 3000)); continue }
        if (/STORED|SEEN_IN_ORPHAN_MEMPOOL/.test(s)) { await new Promise(r => setTimeout(r, 5000)); continue }
        if (/DOUBLE_SPEND|REJECTED/.test(s)) { continue }
        await new Promise(r => setTimeout(r, 2000)); continue
      }
      state.utxos[pick.slot] = res.new_utxo
      writeFileSync(WALLET_PATH, JSON.stringify(state, null, 2))
      return res.txid
    } catch { await new Promise(r => setTimeout(r, 2500)) }
  }
}

// ── Overlay gap detection ──
async function fetchPostedVerses(bookTag: string): Promise<Set<string>> {
  const posted = new Set<string>()
  let offset = 0
  const limit = 200
  while (true) {
    try {
      const url = `${OVERLAY_URL}/v1/feed?app=${APP_NAME}&tag=translation:${TRANSLATION}&tag=book:${bookTag}&limit=${limit}&offset=${offset}`
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!r.ok) break
      const d = await r.json() as any
      if (!d.data || d.data.length === 0) break
      for (const p of d.data) {
        const tags = typeof p.tags === 'string' ? p.tags.split(',') : (p.tags || [])
        const ch = tags.find((t: string) => t.startsWith('chapter:'))?.replace('chapter:', '')
        const vs = tags.find((t: string) => t.startsWith('verse:'))?.replace('verse:', '')
        if (ch && vs) posted.add(`${ch}:${vs}`)
      }
      if (d.data.length < limit) break
      offset += limit
    } catch { break }
  }
  return posted
}

// ── Main ──
async function main() {
  const dataPath = `.bible-data/${TRANSLATION}.json`
  if (!existsSync(dataPath)) throw new Error(`bible data missing: ${dataPath}`)
  const bibleData = JSON.parse(readFileSync(dataPath, 'utf-8'))
  const books = Object.values(bibleData) as any[]

  const state: AgentState = JSON.parse(readFileSync(WALLET_PATH, 'utf-8'))
  if (!state.utxos) throw new Error('wallet missing utxos[]')

  const roots: Record<string, any> = existsSync(ROOTS_FILE) ? JSON.parse(readFileSync(ROOTS_FILE, 'utf-8')) : {}

  await mcpInit()
  console.log(`[completer] ${AGENT} translation=${TRANSLATION} books=${BOOK_START}-${BOOK_END}`)

  const start = Date.now()
  let posted = 0, skipped = 0, failed = 0

  for (let bi = BOOK_START; bi < Math.min(books.length, BOOK_END); bi++) {
    const book = books[bi]
    const bookName = book.name || book.abbrev || `book-${bi}`
    const bookTag = bookName.toLowerCase().replace(/\s+/g, '-')

    // Check overlay for already-posted verses in this book
    console.log(`  [${bookName}] scanning overlay for existing verses...`)
    const existing = await fetchPostedVerses(bookTag)
    console.log(`  [${bookName}] ${existing.size} verses already on chain`)

    // Ensure book root exists
    const rootKey = `${TRANSLATION}_book_${bi}`
    let bookRootTxid = roots[rootKey]
    if (!bookRootTxid) {
      const translationRoot = roots[TRANSLATION]
      if (!translationRoot) { console.error(`  no translation root for ${TRANSLATION}`); continue }
      const content = bookName
      const tags = ['bible', `book:${bookTag}`, `book-idx:${bi}`,
        bi < 39 ? 'testament:ot' : 'testament:nt',
        `translation:${TRANSLATION}`, `kind:book`]
      const t = await emit('peck_reply_tx', { parent_txid: translationRoot, content, tags }, state)
      if (!t) { console.error(`  book root post failed for ${bookName}`); continue }
      bookRootTxid = t
      roots[rootKey] = t
      writeFileSync(ROOTS_FILE, JSON.stringify(roots, null, 2))
      posted++
    }

    // Post chapters and verses
    for (let ci = 0; ci < book.chapters.length; ci++) {
      const chapter = book.chapters[ci]
      const verses: string[] = Array.isArray(chapter) ? chapter : Object.values(chapter)

      // Check if any verse in this chapter is missing
      let chapterNeeded = false
      for (let vi = 0; vi < verses.length; vi++) {
        if (!existing.has(`${ci + 1}:${vi + 1}`)) { chapterNeeded = true; break }
      }
      if (!chapterNeeded) {
        skipped += verses.length
        continue
      }

      // Post chapter header
      const chContent = `${bookName} ${ci + 1}`
      const chTags = ['bible', `book:${bookTag}`, `chapter:${ci + 1}`, `translation:${TRANSLATION}`, 'kind:chapter']
      const chTxid = await emit('peck_reply_tx', { parent_txid: bookRootTxid, content: chContent, tags: chTags }, state)
      if (!chTxid) { failed += verses.length; continue }
      posted++

      // Post missing verses
      for (let vi = 0; vi < verses.length; vi++) {
        const verseKey = `${ci + 1}:${vi + 1}`
        if (existing.has(verseKey)) { skipped++; continue }

        const text = verses[vi]
        if (!text || text.length < 2) { skipped++; continue }
        const tags = ['bible', `book:${bookTag}`, `chapter:${ci + 1}`, `verse:${vi + 1}`,
          bi < 39 ? 'testament:ot' : 'testament:nt',
          `translation:${TRANSLATION}`,
          `version:${TRANSLATION}`, `lang:${TRANSLATION.split('_')[0]}`, 'kind:verse']
        const t = await emit('peck_reply_tx', { parent_txid: chTxid, content: text, tags }, state)
        if (t) {
          posted++
          if (posted % 25 === 0) {
            const elapsed = (Date.now() - start) / 1000
            console.log(`  ${bookName} ${ci + 1}:${vi + 1}  posted=${posted}  skipped=${skipped}  tps=${(posted / elapsed).toFixed(2)}`)
          }
        } else { failed++ }
      }
    }

    console.log(`  [${bookName}] done — posted=${posted} skipped=${skipped} failed=${failed}`)
  }

  const elapsed = (Date.now() - start) / 1000
  console.log(`\n[completer] DONE posted=${posted} skipped=${skipped} failed=${failed} time=${elapsed.toFixed(1)}s`)
}

main().catch(e => { console.error('[completer] FAIL:', e.message || e); process.exit(1) })
