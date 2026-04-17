/**
 * bible-completer-db.ts — DB-gap completer.
 *
 * Instead of asking overlay "what's already posted?", queries peck_db directly
 * via a local unix env var DB_GAP_FILE (a JSON file pre-built by
 * scripts/build-gap-file.ts per translation). No per-book overlay scan =
 * eliminates duplicate-posting and overlay bottleneck.
 *
 * Uses same wallet/UTXO chain pattern as bible-completer.ts.
 *
 * Usage:
 *   npx tsx scripts/bible-completer-db.ts <agent> <translation> <book_start> <book_end>
 *
 * Required input:
 *   .gaps/<translation>.json   — { "book-slug": [[ch,v], [ch,v], ...], ... }
 *   .bible-roots.json          — work/book roots (created if missing per book)
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync } from 'fs'

const AGENT = process.argv[2]
const TRANSLATION = process.argv[3]
const BOOK_START = parseInt(process.argv[4] || '0', 10)
const BOOK_END = parseInt(process.argv[5] || '999', 10)
if (!AGENT || !TRANSLATION) { console.error('need <agent> <translation> [book_start] [book_end]'); process.exit(1) }

const WALLET_PATH = `.agent-wallets/${AGENT}.json`
const GAP_PATH = `.gaps/${TRANSLATION}.json`
const ROOTS_FILE = '.bible-roots.json'
const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'
const APP_NAME = 'peck.cross'
const MIN_BALANCE = 200

interface Utxo { txid: string; vout: number; satoshis: number; rawTxHex: string }
interface AgentState { agent: string; address: string; privKeyHex: string; utxos: Utxo[]; index?: number; stats: any }

let mcpSession: string | null = null
async function mcpInit() {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bible-completer-db', version: '1' } } }),
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
  let attempt = 0
  while (true) {
    const pick = pickSlot(state)
    if (!pick) return null
    attempt++
    try {
      const res = await mcpCall(tool, { ...extra, signing_key: state.privKeyHex, spend_utxo: pick.utxo, agent_app: APP_NAME })
      if (!res.success) {
        const s = String(res.status || '?')
        if (attempt <= 3 || attempt % 5 === 0) console.log(`  [emit] attempt=${attempt} status=${s.slice(0, 80)} msg=${String(res.error || res.message || '').slice(0, 80)}`)
        if (/^465/.test(s)) { await new Promise(r => setTimeout(r, 30000)); continue }
        if (/^(5\d\d|http-5|409)/.test(s)) { await new Promise(r => setTimeout(r, 3000)); continue }
        if (/STORED|SEEN_IN_ORPHAN_MEMPOOL/.test(s)) { await new Promise(r => setTimeout(r, 5000)); continue }
        if (/DOUBLE_SPEND/.test(s)) {
          // UTXO was already spent — we cannot recover this utxo. Bail.
          console.log(`  [emit] FATAL DOUBLE_SPEND on ${pick.utxo.txid.slice(0,16)}:${pick.utxo.vout} — returning null`)
          return null
        }
        if (/REJECTED/.test(s)) {
          console.log(`  [emit] REJECTED — returning null`)
          return null
        }
        if (attempt > 20) {
          console.log(`  [emit] giving up after ${attempt} attempts, last status=${s}`)
          return null
        }
        await new Promise(r => setTimeout(r, 2000)); continue
      }
      state.utxos[pick.slot] = res.new_utxo
      writeFileSync(WALLET_PATH, JSON.stringify(state, null, 2))
      return res.txid
    } catch (e: any) {
      if (attempt <= 3 || attempt % 5 === 0) console.log(`  [emit] exception attempt=${attempt}: ${String(e.message || e).slice(0, 120)}`)
      if (attempt > 20) { console.log(`  [emit] giving up after ${attempt} exceptions`); return null }
      await new Promise(r => setTimeout(r, 2500))
    }
  }
}

async function main() {
  const dataPath = `.bible-data/${TRANSLATION}.json`
  if (!existsSync(dataPath)) throw new Error(`bible data missing: ${dataPath}`)
  if (!existsSync(GAP_PATH)) throw new Error(`gap file missing: ${GAP_PATH}  (run build-gap-file.ts first)`)
  const rawStr = readFileSync(dataPath, 'utf-8').replace(/^\uFEFF/, '')
  const bibleData = JSON.parse(rawStr)
  const books = Array.isArray(bibleData) ? bibleData : Object.values(bibleData) as any[]
  const gaps: Record<string, number[][]> = JSON.parse(readFileSync(GAP_PATH, 'utf-8'))

  const state: AgentState = JSON.parse(readFileSync(WALLET_PATH, 'utf-8'))
  if (!state.utxos) throw new Error('wallet missing utxos[]')
  const roots: Record<string, string> = existsSync(ROOTS_FILE) ? JSON.parse(readFileSync(ROOTS_FILE, 'utf-8')) : {}

  await mcpInit()
  console.log(`[completer-db] ${AGENT} translation=${TRANSLATION} books=${BOOK_START}-${BOOK_END}`)

  const start = Date.now()
  let posted = 0, skipped = 0, failed = 0
  const chapterTxidCache: Record<string, string> = {}

  for (let bi = BOOK_START; bi < Math.min(books.length, BOOK_END); bi++) {
    const book = books[bi]
    const bookName = book.name || book.abbrev || `book-${bi}`
    const bookTag = bookName.toLowerCase().replace(/\s+/g, '-')
    const bookGaps = gaps[bookTag] || []
    if (!bookGaps.length) { console.log(`  [${bookName}] no gaps — skipping`); continue }

    // Ensure book root exists
    const rootKey = `${TRANSLATION}_book_${bi}`
    let bookRootTxid = roots[rootKey]
    if (!bookRootTxid) {
      const translationRoot = roots[TRANSLATION]
      if (!translationRoot) { console.error(`  no translation root for ${TRANSLATION}`); continue }
      const tags = ['bible', `book:${bookTag}`, `book-idx:${bi}`,
        bi < 39 ? 'testament:ot' : 'testament:nt',
        `translation:${TRANSLATION}`, 'kind:book']
      const t = await emit('peck_reply_tx', { parent_txid: translationRoot, content: bookName, tags }, state)
      if (!t) { console.error(`  book root post failed for ${bookName}`); continue }
      bookRootTxid = t
      roots[rootKey] = t
      writeFileSync(ROOTS_FILE, JSON.stringify(roots, null, 2))
      posted++
    }

    // Group gaps by chapter so we post one chapter-header then its missing verses
    const byChapter: Record<number, number[]> = {}
    for (const [ch, v] of bookGaps) {
      if (!byChapter[ch]) byChapter[ch] = []
      byChapter[ch].push(v)
    }

    for (const chStr of Object.keys(byChapter).sort((a, b) => parseInt(a) - parseInt(b))) {
      const ci = parseInt(chStr) - 1  // 1-indexed in tags, 0-indexed in data
      const chapter = book.chapters[ci]
      if (!chapter) continue
      const verses: string[] = Array.isArray(chapter) ? chapter : Object.values(chapter)
      const versesNeeded = byChapter[parseInt(chStr)]

      // Post chapter header
      const chKey = `${TRANSLATION}:${bi}:${chStr}`
      let chTxid = chapterTxidCache[chKey]
      if (!chTxid) {
        const chContent = `${bookName} ${chStr}`
        const chTags = ['bible', `book:${bookTag}`, `chapter:${chStr}`, `translation:${TRANSLATION}`, 'kind:chapter']
        const t = await emit('peck_reply_tx', { parent_txid: bookRootTxid, content: chContent, tags: chTags }, state)
        if (!t) { failed += versesNeeded.length; continue }
        chTxid = t
        chapterTxidCache[chKey] = t
        posted++
      }

      // Post only the missing verses
      for (const vNum of versesNeeded) {
        const vi = vNum - 1  // 1-indexed in tags
        const text = verses[vi]
        if (!text || text.length < 2) { skipped++; continue }
        const tags = ['bible', `book:${bookTag}`, `chapter:${chStr}`, `verse:${vNum}`,
          bi < 39 ? 'testament:ot' : 'testament:nt',
          `translation:${TRANSLATION}`, `version:${TRANSLATION}`, `lang:${TRANSLATION.split('_')[0]}`, 'kind:verse']
        const t = await emit('peck_reply_tx', { parent_txid: chTxid, content: text, tags }, state)
        if (t) {
          posted++
          if (posted % 25 === 0) {
            const elapsed = (Date.now() - start) / 1000
            console.log(`  ${bookName} ${chStr}:${vNum}  posted=${posted}  skipped=${skipped}  failed=${failed}  tps=${(posted / elapsed).toFixed(2)}`)
          }
        } else { failed++ }
      }
    }
    console.log(`  [${bookName}] done`)
  }

  const elapsed = (Date.now() - start) / 1000
  console.log(`\n[completer-db] DONE posted=${posted} skipped=${skipped} failed=${failed} time=${elapsed.toFixed(1)}s`)
}

main().catch(e => { console.error('[completer-db] FAIL:', e.message || e); process.exit(1) })
