/**
 * cross-ref-poster.ts — emit peck_tag_tx per OpenBible cross-reference.
 *
 * OpenBible.info maintains a CC-BY-licensed crowdsourced cross-reference
 * table (~344K entries, Treasury-of-Scripture-Knowledge-inspired). Each
 * row is "Gen.1.1 → Rev.22.13 (votes=56)". This script binds those pairs
 * on-chain by emitting one peck_tag_tx per entry:
 *
 *   target_txid = KJV verse txid of "From"
 *   tags        = [cross-ref:<to_txid>, ref-from:gen:1:1, ref-to:rev:22:13,
 *                  votes:56, source:openbible, source:tsk-tradition]
 *
 * Shard-friendly: pass <shard> <num_shards> so N agents can divide the
 * work via hash(from+to) mod num_shards. State file per agent records
 * done entries for resume.
 *
 * Requires KJV bible posts to be indexed in overlay. Walks all KJV
 * chapter_txids in .bible-progress/* and fetches verse children to
 * build a ref→txid map (cached in .cross-ref-data/kjv-verse-map.json).
 *
 * Usage:
 *   npx tsx scripts/cross-ref-poster.ts <agent> [shard=0] [num_shards=1]
 *
 *   # 8 workers sharing the workload
 *   for s in 0 1 2 3 4 5 6 7; do
 *     npx tsx scripts/cross-ref-poster.ts scribe-0$((s+1)) $s 8 &
 *   done
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { createHash } from 'crypto'

const AGENT = process.argv[2]
const SHARD = parseInt(process.argv[3] || '0', 10)
const NUM_SHARDS = parseInt(process.argv[4] || '1', 10)
if (!AGENT) { console.error('need <agent> [shard] [num_shards]'); process.exit(1) }

const WALLET_PATH = `.agent-wallets/${AGENT}.json`
const XREF_TSV = '.cross-ref-data/openbible-xref.tsv'
const VERSE_MAP_PATH = '.cross-ref-data/kjv-verse-map.json'
const STATE_DIR = '.cross-ref-state'
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR)
const STATE_PATH = `${STATE_DIR}/${AGENT}.json`

const OVERLAY_URL = process.env.OVERLAY_URL || 'https://overlay.peck.to'
const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'
const APP_NAME = 'peck.cross'
const MIN_BALANCE = 200
const MIN_VOTES = parseInt(process.env.MIN_VOTES || '3', 10) // skip low-quality refs

// ─── Bitcoin Schema book abbrev → our book slug (from thiagobodruk format) ───
const BOOK_MAP: Record<string, { slug: string; chapterIdx: number }> = {
  Gen: { slug: 'genesis', chapterIdx: 0 },
  Exod: { slug: 'exodus', chapterIdx: 1 },
  Lev: { slug: 'leviticus', chapterIdx: 2 },
  Num: { slug: 'numbers', chapterIdx: 3 },
  Deut: { slug: 'deuteronomy', chapterIdx: 4 },
  Josh: { slug: 'joshua', chapterIdx: 5 },
  Judg: { slug: 'judges', chapterIdx: 6 },
  Ruth: { slug: 'ruth', chapterIdx: 7 },
  '1Sam': { slug: '1-samuel', chapterIdx: 8 },
  '2Sam': { slug: '2-samuel', chapterIdx: 9 },
  '1Kgs': { slug: '1-kings', chapterIdx: 10 },
  '2Kgs': { slug: '2-kings', chapterIdx: 11 },
  '1Chr': { slug: '1-chronicles', chapterIdx: 12 },
  '2Chr': { slug: '2-chronicles', chapterIdx: 13 },
  Ezra: { slug: 'ezra', chapterIdx: 14 },
  Neh: { slug: 'nehemiah', chapterIdx: 15 },
  Esth: { slug: 'esther', chapterIdx: 16 },
  Job: { slug: 'job', chapterIdx: 17 },
  Ps: { slug: 'psalms', chapterIdx: 18 },
  Prov: { slug: 'proverbs', chapterIdx: 19 },
  Eccl: { slug: 'ecclesiastes', chapterIdx: 20 },
  Song: { slug: 'song-of-solomon', chapterIdx: 21 },
  Isa: { slug: 'isaiah', chapterIdx: 22 },
  Jer: { slug: 'jeremiah', chapterIdx: 23 },
  Lam: { slug: 'lamentations', chapterIdx: 24 },
  Ezek: { slug: 'ezekiel', chapterIdx: 25 },
  Dan: { slug: 'daniel', chapterIdx: 26 },
  Hos: { slug: 'hosea', chapterIdx: 27 },
  Joel: { slug: 'joel', chapterIdx: 28 },
  Amos: { slug: 'amos', chapterIdx: 29 },
  Obad: { slug: 'obadiah', chapterIdx: 30 },
  Jonah: { slug: 'jonah', chapterIdx: 31 },
  Mic: { slug: 'micah', chapterIdx: 32 },
  Nah: { slug: 'nahum', chapterIdx: 33 },
  Hab: { slug: 'habakkuk', chapterIdx: 34 },
  Zeph: { slug: 'zephaniah', chapterIdx: 35 },
  Hag: { slug: 'haggai', chapterIdx: 36 },
  Zech: { slug: 'zechariah', chapterIdx: 37 },
  Mal: { slug: 'malachi', chapterIdx: 38 },
  Matt: { slug: 'matthew', chapterIdx: 39 },
  Mark: { slug: 'mark', chapterIdx: 40 },
  Luke: { slug: 'luke', chapterIdx: 41 },
  John: { slug: 'john', chapterIdx: 42 },
  Acts: { slug: 'acts', chapterIdx: 43 },
  Rom: { slug: 'romans', chapterIdx: 44 },
  '1Cor': { slug: '1-corinthians', chapterIdx: 45 },
  '2Cor': { slug: '2-corinthians', chapterIdx: 46 },
  Gal: { slug: 'galatians', chapterIdx: 47 },
  Eph: { slug: 'ephesians', chapterIdx: 48 },
  Phil: { slug: 'philippians', chapterIdx: 49 },
  Col: { slug: 'colossians', chapterIdx: 50 },
  '1Thess': { slug: '1-thessalonians', chapterIdx: 51 },
  '2Thess': { slug: '2-thessalonians', chapterIdx: 52 },
  '1Tim': { slug: '1-timothy', chapterIdx: 53 },
  '2Tim': { slug: '2-timothy', chapterIdx: 54 },
  Titus: { slug: 'titus', chapterIdx: 55 },
  Phlm: { slug: 'philemon', chapterIdx: 56 },
  Heb: { slug: 'hebrews', chapterIdx: 57 },
  Jas: { slug: 'james', chapterIdx: 58 },
  '1Pet': { slug: '1-peter', chapterIdx: 59 },
  '2Pet': { slug: '2-peter', chapterIdx: 60 },
  '1John': { slug: '1-john', chapterIdx: 61 },
  '2John': { slug: '2-john', chapterIdx: 62 },
  '3John': { slug: '3-john', chapterIdx: 63 },
  Jude: { slug: 'jude', chapterIdx: 64 },
  Rev: { slug: 'revelation', chapterIdx: 65 },
}

// Parse "Gen.1.1" or "Ps.89.11-Ps.89.12" → canonical ref key "genesis:1:1"
function parseRef(s: string): string | null {
  // Drop range suffix — we only anchor at start verse
  const firstPart = s.split('-')[0]
  const m = firstPart.match(/^([0-9]?[A-Za-z]+)\.(\d+)\.(\d+)$/)
  if (!m) return null
  const [, bookAbbr, ch, vs] = m
  const book = BOOK_MAP[bookAbbr]
  if (!book) return null
  return `${book.slug}:${ch}:${vs}`
}

interface Utxo { txid: string; vout: number; satoshis: number; rawTxHex: string }
interface AgentState { agent: string; address: string; privKeyHex: string; utxos: Utxo[]; index?: number; stats: any }

let mcpSession: string | null = null
async function mcpInit() {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cross-ref-poster', version: '1' } } }),
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

// Build { "genesis:1:1": "<kjv_txid>", ... } by walking all .bible-progress/
// en_kjv chapter_txids and fetching each chapter's verse children from overlay.
async function buildVerseMap(): Promise<Record<string, string>> {
  if (existsSync(VERSE_MAP_PATH)) {
    const cached = JSON.parse(readFileSync(VERSE_MAP_PATH, 'utf-8'))
    console.log(`[x-ref] using cached verse map: ${Object.keys(cached).length} entries`)
    return cached
  }

  console.log(`[x-ref] building unified verse map (all Protestant+Catholic+Norwegian translations) from overlay ...`)
  const map: Record<string, string> = {}
  // Aggregate ALL translations that use Protestant book-index ordering.
  // Skip Hebrew (he_wlc: different canon) and Greek NT (grc_nt: offset indices).
  const progressFiles = readdirSync('.bible-progress').filter(f =>
    f.endsWith('.json') && !f.includes('_he_wlc') && !f.includes('_grc_nt'))
  const allChapters: Array<{ bookIdx: number; chIdx: number; chTxid: string }> = []

  for (const f of progressFiles) {
    const p = JSON.parse(readFileSync(`.bible-progress/${f}`, 'utf-8'))
    for (const [key, chTxid] of Object.entries(p.chapter_txids || {})) {
      const [bi, ci] = key.split('_').map(Number)
      allChapters.push({ bookIdx: bi, chIdx: ci, chTxid: chTxid as string })
    }
  }

  // Reverse map: chapterIdx → book slug
  const slugFor: Record<number, string> = {}
  for (const [, v] of Object.entries(BOOK_MAP)) slugFor[v.chapterIdx] = v.slug

  let fetched = 0
  for (const ch of allChapters) {
    try {
      const r = await fetch(`${OVERLAY_URL}/v1/thread/${ch.chTxid}`)
      const d = await r.json() as any
      for (const p of (d.replies || d.data || [])) {
        const tagsStr = (p.tags || '').toLowerCase()
        const m = tagsStr.match(/verse:(\d+)/)
        if (!m) continue
        const slug = slugFor[ch.bookIdx]
        if (!slug) continue
        const ref = `${slug}:${ch.chIdx + 1}:${m[1]}`
        map[ref] = p.txid
      }
      fetched++
      if (fetched % 100 === 0) console.log(`  fetched ${fetched}/${allChapters.length} chapters, map size=${Object.keys(map).length}`)
    } catch (e: any) {
      // skip — chapter not indexed yet
    }
  }

  writeFileSync(VERSE_MAP_PATH, JSON.stringify(map))
  console.log(`[x-ref] verse map built: ${Object.keys(map).length} entries → ${VERSE_MAP_PATH}`)
  return map
}

interface XrefEntry { from: string; to: string; votes: number; fromRaw: string; toRaw: string }
function loadXrefs(): XrefEntry[] {
  const lines = readFileSync(XREF_TSV, 'utf-8').split('\n')
  const entries: XrefEntry[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line.startsWith('#')) continue
    const [fromRaw, toRaw, votesStr] = line.split('\t')
    if (!fromRaw || !toRaw) continue
    const votes = parseInt(votesStr, 10)
    if (isNaN(votes) || votes < MIN_VOTES) continue
    const from = parseRef(fromRaw); const to = parseRef(toRaw)
    if (!from || !to) continue
    entries.push({ from, to, votes, fromRaw, toRaw })
  }
  return entries
}

function hashShard(from: string, to: string, mod: number): number {
  return parseInt(createHash('sha1').update(`${from}|${to}`).digest('hex').slice(0, 8), 16) % mod
}

async function postTag(targetTxid: string, tags: string[], lang: string, state: AgentState): Promise<string | null> {
  while (true) {
    const pick = pickSlot(state)
    if (!pick) return null
    try {
      const res = await mcpCall('peck_tag_tx', {
        target_txid: targetTxid,
        tags, category: 'scripture', lang,
        tone: 'cross-reference',
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
  const doneState: { done: Record<string, string> } = existsSync(STATE_PATH)
    ? JSON.parse(readFileSync(STATE_PATH, 'utf-8')) : { done: {} }

  const xrefs = loadXrefs()
  console.log(`[x-ref] ${AGENT} shard=${SHARD}/${NUM_SHARDS}  total=${xrefs.length}  min-votes=${MIN_VOTES}`)

  const myShard = xrefs.filter(x => hashShard(x.from, x.to, NUM_SHARDS) === SHARD)
  const remaining = myShard.filter(x => !doneState.done[`${x.from}|${x.to}`])
  console.log(`[x-ref] my shard=${myShard.length}  already-done=${myShard.length - remaining.length}  remaining=${remaining.length}`)

  const verseMap = await buildVerseMap()

  await mcpInit()

  let ok = 0, skipped = 0
  const start = Date.now()
  for (const x of remaining) {
    const fromTxid = verseMap[x.from]
    const toTxid = verseMap[x.to]
    if (!fromTxid || !toTxid) { skipped++; continue }

    const tags = [
      'cross-ref', `cross-ref:${toTxid}`,
      `ref-from:${x.from}`, `ref-to:${x.to}`,
      `votes:${x.votes}`,
      'source:openbible', 'translation:en_kjv',
    ]
    const tagTx = await postTag(fromTxid, tags, 'en', state)
    if (tagTx) {
      doneState.done[`${x.from}|${x.to}`] = tagTx
      ok++
      if (ok % 25 === 0) {
        writeFileSync(STATE_PATH, JSON.stringify(doneState, null, 2))
        const elapsed = (Date.now() - start) / 1000
        console.log(`  ${ok}/${remaining.length}  tps=${(ok / elapsed).toFixed(2)}  skipped=${skipped}  last=${x.from}→${x.to} tx=${tagTx.slice(0, 12)}…`)
      }
    }
  }
  writeFileSync(STATE_PATH, JSON.stringify(doneState, null, 2))
  console.log(`[x-ref] done  ok=${ok}  skipped=${skipped}`)
}

main().catch(e => { console.error('[x-ref] FAIL:', e.message || e); process.exit(1) })
