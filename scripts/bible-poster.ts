/**
 * bible-poster.ts — post a translation's book/chapter/verse tree on-chain.
 *
 * Each scribe takes one (translation, book-range) assignment. Posts:
 *   Book header  → peck_post_tx, kind=book
 *   Chapter hdr  → peck_post_tx, parent=book_txid, kind=chapter
 *   Verse        → peck_post_tx, parent=chapter_txid, kind=verse
 *
 * All posts carry structural tags: book:<name>, chapter:<n>, verse:<n>,
 * translation:<code>, lang:<iso>, kind:verse|chapter|book, testament:ot|nt.
 * Content is ONLY the scripture text (markdown/utf-8). Metadata is in MAP.
 *
 * App: peck.cross (separates this canonical corpus from agent chatter).
 *
 * Progress persisted to .bible-progress/<scribe>_<translation>.json so we
 * can resume if a crash happens mid-run.
 *
 * Usage:
 *   npx tsx scripts/bible-poster.ts <scribe> <translation> <book_start> <book_end>
 *
 * Example (scribe-01 posts Genesis through Deuteronomy in KJV):
 *   npx tsx scripts/bible-poster.ts scribe-01 en_kjv 0 5
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'

const SCRIBE = process.argv[2]
const TRANSLATION = process.argv[3]  // e.g. en_kjv
const BOOK_START = parseInt(process.argv[4] || '0', 10)
const BOOK_END = parseInt(process.argv[5] || '66', 10)
if (!SCRIBE || !TRANSLATION) { console.error('need <scribe> <translation> [start] [end]'); process.exit(1) }

const WALLET_PATH = `.agent-wallets/${SCRIBE}.json`
const BIBLE_DIR = '.bible-data'
const PROGRESS_DIR = '.bible-progress'
const ROOTS_FILE = '.bible-roots.json'
const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'
const APP_NAME = process.env.BIBLE_APP || 'peck.cross'
const MIN_BALANCE = parseInt(process.env.MIN_BALANCE || '200', 10)

if (!existsSync(PROGRESS_DIR)) mkdirSync(PROGRESS_DIR)

// ─── Bible translation metadata (lang + human-readable version name) ───
// All 6 confirmed public-domain sources (safe to publish on chain).
const TRANSLATION_META: Record<string, { lang: string; version: string; canon?: string }> = {
  en_kjv:         { lang: 'en',  version: 'King James Version (1769)',                canon: 'protestant' },
  en_bbe:         { lang: 'en',  version: 'Bible in Basic English (1949)',            canon: 'protestant' },
  en_asv:         { lang: 'en',  version: 'American Standard Version (1901)',         canon: 'protestant' },
  pt_aa:          { lang: 'pt',  version: 'Almeida Atualizada (Imprensa Bíblica, 1948)', canon: 'protestant' },
  es_rvr:         { lang: 'es',  version: 'Reina-Valera (1909)',                      canon: 'protestant' },
  de_schlachter:  { lang: 'de',  version: 'Schlachter (1905)',                        canon: 'protestant' },
  en_dr:          { lang: 'en',  version: 'Douay-Rheims (1899 Challoner)',            canon: 'catholic' },
  la_vulgata:     { lang: 'la',  version: 'Clementine Vulgate',                       canon: 'catholic' },
  he_wlc:         { lang: 'he',  version: 'Westminster Leningrad Codex',              canon: 'jewish' },
  grc_nt:         { lang: 'grc', version: 'Byzantine Majority Text (Robinson-Pierpont, 2005)', canon: 'greek-nt' },
  no_1930:        { lang: 'no',  version: 'Bibelen 1930 (Det Norske Bibelselskap)',   canon: 'protestant' },
}

// Book 0-38 = OT (Genesis..Malachi), 39-65 = NT (Matthew..Revelation)
function testamentOf(bookIdx: number): 'ot' | 'nt' { return bookIdx < 39 ? 'ot' : 'nt' }

// ─── State ───
interface Utxo { txid: string; vout: number; satoshis: number; rawTxHex: string }
interface AgentState {
  agent: string; address: string; privKeyHex: string
  utxos: Utxo[]; index?: number; stats: any
}
interface Progress {
  translation: string
  last_book_idx: number
  last_chapter_idx: number
  last_verse_idx: number
  book_txids: Record<number, string>  // book_idx → txid
  chapter_txids: Record<string, string>  // `${book_idx}_${ch_idx}` → txid
  stats: { posted: number; failed: number; startedAt: string }
}

function loadProgress(): Progress {
  const p = `${PROGRESS_DIR}/${SCRIBE}_${TRANSLATION}.json`
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8'))
  return {
    translation: TRANSLATION,
    last_book_idx: -1, last_chapter_idx: -1, last_verse_idx: -1,
    book_txids: {}, chapter_txids: {},
    stats: { posted: 0, failed: 0, startedAt: new Date().toISOString() },
  }
}
function saveProgress(p: Progress) {
  writeFileSync(`${PROGRESS_DIR}/${SCRIBE}_${TRANSLATION}.json`, JSON.stringify(p, null, 2))
}

// ─── MCP ───
let mcpSession: string | null = null
async function mcpInit() {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bible-poster', version: '1' } } }),
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
    // no data = dead session → reinit and retry once
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

// ─── Slot management (round-robin across agent's 50 UTXOs) ───
// Two workers can run on the same wallet safely by sharing SLOT_START..SLOT_END.
// Pattern: worker A uses slots 0..24, worker B uses 25..49. Round-robin within
// the assigned range only. Wallet file is shared (mtime racing is fine because
// each worker only touches its own slot indices on write-back).
const SLOT_START = parseInt(process.env.SLOT_START || '0', 10)
const SLOT_END   = parseInt(process.env.SLOT_END   || '99999', 10)
const blindSlots = new Set<number>()
const slotFails = new Map<number, number>()
function pickSlot(state: AgentState): { utxo: Utxo; slot: number } | null {
  const n = state.utxos.length
  const lo = Math.max(0, SLOT_START)
  const hi = Math.min(n - 1, SLOT_END)
  const range = Math.max(1, hi - lo + 1)
  // Rotate within assigned range only
  let cursor = state.index || 0
  if (cursor < lo || cursor > hi) cursor = lo
  for (let i = 0; i < range; i++) {
    const slot = lo + ((cursor - lo + i) % range)
    if (blindSlots.has(slot)) continue
    const u = state.utxos[slot]
    if (u && u.satoshis >= MIN_BALANCE) {
      state.index = slot + 1 > hi ? lo : slot + 1
      return { utxo: u, slot }
    }
  }
  return null
}
function markFail(slot: number, severe = false) {
  const n = (slotFails.get(slot) || 0) + (severe ? 3 : 1)
  slotFails.set(slot, n)
  if (n >= 3) blindSlots.add(slot)
}
function markOk(slot: number) { slotFails.delete(slot) }

async function emit(tool: string, extra: any, state: AgentState): Promise<string | null> {
  while (true) {
    const pick = pickSlot(state)
    if (!pick) { console.error(`  no usable slot`); return null }
    try {
      const res = await mcpCall(tool, {
        ...extra,
        signing_key: state.privKeyHex,
        spend_utxo: pick.utxo,
        agent_app: APP_NAME,
      })
      if (!res.success) {
        const s = String(res.status || '?')
        markFail(pick.slot, /DOUBLE_SPEND|REJECTED/.test(s))
        // recoverable statuses: retry
        if (/^465/.test(s)) { await new Promise(r => setTimeout(r, 30000)); continue }
        if (/^409/.test(s)) { await new Promise(r => setTimeout(r, 1000)); continue }
        if (/^(5\d\d|http-5)/.test(s)) { await new Promise(r => setTimeout(r, 3000)); continue }
        if (/STORED|SEEN_IN_ORPHAN_MEMPOOL/.test(s)) { await new Promise(r => setTimeout(r, 5000)); continue }
        if (/DOUBLE_SPEND|REJECTED/.test(s)) { continue }
        await new Promise(r => setTimeout(r, 2000))
        continue
      }
      markOk(pick.slot)
      state.utxos[pick.slot] = res.new_utxo
      writeFileSync(WALLET_PATH, JSON.stringify(state, null, 2))
      return res.txid
    } catch (e: any) {
      await new Promise(r => setTimeout(r, 2500))
      // retry (don't break)
    }
  }
}

// ─── Main ───
async function main() {
  const biblePath = `${BIBLE_DIR}/${TRANSLATION}.json`
  if (!existsSync(biblePath)) throw new Error(`bible data missing: ${biblePath}`)
  const bible = JSON.parse(readFileSync(biblePath, 'utf-8').replace(/^\uFEFF/, ''))
  const meta = TRANSLATION_META[TRANSLATION] || { lang: 'unknown' }

  const state: AgentState = JSON.parse(readFileSync(WALLET_PATH, 'utf-8'))
  if (!state.utxos) throw new Error('agent state missing utxos[]')

  if (!existsSync(ROOTS_FILE)) throw new Error(`${ROOTS_FILE} missing — run bible-roots-init.ts first`)
  const roots: Record<string, string> = JSON.parse(readFileSync(ROOTS_FILE, 'utf-8'))
  const rootTxid = roots[TRANSLATION]
  if (!rootTxid) throw new Error(`no root txid for ${TRANSLATION} in ${ROOTS_FILE}`)

  const progress = loadProgress()
  await mcpInit()

  console.log(`[bible-poster] root(${TRANSLATION}) = ${rootTxid.slice(0, 14)}…`)

  console.log(`[bible-poster] scribe=${SCRIBE} translation=${TRANSLATION} books=${BOOK_START}..${BOOK_END}`)
  console.log(`[bible-poster] resume: book=${progress.last_book_idx} chapter=${progress.last_chapter_idx} verse=${progress.last_verse_idx}`)

  const start = Date.now()
  let postedThisRun = 0

  for (let bi = BOOK_START; bi < Math.min(BOOK_END, bible.length); bi++) {
    if (bi < progress.last_book_idx) continue  // already done entire book
    const book = bible[bi]
    const bookName = book.name
    const testament = testamentOf(bi)

    // Reset chapter/verse cursor when entering a new book so we don't skip
    // early chapters of this book due to the previous book's progress state.
    if (bi > progress.last_book_idx || (bi === progress.last_book_idx && progress.last_chapter_idx >= book.chapters.length)) {
      progress.last_chapter_idx = -1
      progress.last_verse_idx = -1
    }

    // Post book header (reply to translation root so books thread together)
    let bookTxid = progress.book_txids[bi]
    if (!bookTxid) {
      const bookContent = `${bookName}`
      const tags = [
        'bible', `book:${bookName.toLowerCase().replace(/\s+/g, '-')}`,
        `book-idx:${bi + 1}`, `testament:${testament}`,
        `translation:${TRANSLATION}`, `version:${meta.version}`,
        `lang:${meta.lang}`, 'kind:book',
      ]
      console.log(`\n[${bi + 1}/${BOOK_END}] Book: ${bookName}`)
      const t = await emit('peck_reply_tx', { parent_txid: rootTxid, content: bookContent, tags }, state)
      if (!t) { console.error('  book post failed'); continue }
      bookTxid = t
      progress.book_txids[bi] = t
      progress.last_book_idx = bi
      saveProgress(progress)
      postedThisRun++
    }

    for (let ci = 0; ci < book.chapters.length; ci++) {
      if (bi === progress.last_book_idx && ci < progress.last_chapter_idx) continue

      const chapter = book.chapters[ci]
      const chapterKey = `${bi}_${ci}`
      let chapterTxid = progress.chapter_txids[chapterKey]

      if (!chapterTxid) {
        const chContent = `${bookName} ${ci + 1}`
        const tags = [
          'bible', `book:${bookName.toLowerCase().replace(/\s+/g, '-')}`,
          `chapter:${ci + 1}`, `testament:${testament}`,
          `translation:${TRANSLATION}`, `version:${meta.version}`,
          `lang:${meta.lang}`, 'kind:chapter',
        ]
        const t = await emit('peck_reply_tx', { parent_txid: bookTxid, content: chContent, tags }, state)
        if (!t) { console.error('  chapter post failed'); continue }
        chapterTxid = t
        progress.chapter_txids[chapterKey] = t
        progress.last_chapter_idx = ci
        progress.last_verse_idx = -1
        saveProgress(progress)
        postedThisRun++
      }

      for (let vi = 0; vi < chapter.length; vi++) {
        if (bi === progress.last_book_idx && ci === progress.last_chapter_idx && vi <= progress.last_verse_idx) continue

        const verseText = chapter[vi]
        const tags = [
          'bible', `book:${bookName.toLowerCase().replace(/\s+/g, '-')}`,
          `chapter:${ci + 1}`, `verse:${vi + 1}`,
          `testament:${testament}`, `translation:${TRANSLATION}`,
          `version:${meta.version}`, `lang:${meta.lang}`, 'kind:verse',
        ]
        const t = await emit('peck_reply_tx', { parent_txid: chapterTxid, content: verseText, tags }, state)
        if (!t) { progress.stats.failed += 1; continue }
        progress.last_verse_idx = vi
        progress.stats.posted += 1
        postedThisRun++
        if (postedThisRun % 25 === 0) {
          const elapsed = (Date.now() - start) / 1000
          const tps = postedThisRun / elapsed
          console.log(`  ${bookName} ${ci + 1}:${vi + 1}  posted=${postedThisRun}  tps=${tps.toFixed(2)}  txid=${t.slice(0, 12)}…`)
          saveProgress(progress)
        }
      }
      progress.last_verse_idx = -1
    }
  }

  const elapsed = (Date.now() - start) / 1000
  console.log(`\n[bible-poster] DONE  posted=${postedThisRun}  failed=${progress.stats.failed}  time=${elapsed.toFixed(1)}s  tps=${(postedThisRun / elapsed).toFixed(2)}`)
  saveProgress(progress)
}

main().catch(e => { console.error('[bible-poster] FAIL:', e.message || e); process.exit(1) })
