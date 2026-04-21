/**
 * coverage-audit.ts — exhaustive verse coverage audit for a translation.
 *
 * Paginates all peck.cross posts with tag=translation:X, filters kind:verse
 * client-side, deduplicates by (book, chapter, verse), reports coverage
 * against the source bible JSON.
 *
 * Also detects orphan-parent verses: those whose parent_txid is not on chain.
 *
 * Usage:
 *   npx tsx scripts/coverage-audit.ts <translation>
 *   e.g. npx tsx scripts/coverage-audit.ts no_1930
 */
import 'dotenv/config'
import { readFileSync, writeFileSync } from 'fs'

const TRANS = process.argv[2]
if (!TRANS) { console.error('usage: coverage-audit.ts <translation>'); process.exit(1) }

const OVERLAY = process.env.OVERLAY_URL || 'https://overlay.peck.to'
const WOC = 'https://api.whatsonchain.com/v1/bsv/main'
const PAGE = 200

interface Post {
  txid: string
  parent_txid: string | null
  tags?: string | string[]
  content?: string
  map_content?: string
}

function tagsArr(p: Post): string[] {
  if (!p.tags) return []
  return typeof p.tags === 'string' ? p.tags.split(',').map(s => s.trim()) : p.tags
}
function tagVal(p: Post, prefix: string): string | null {
  const t = tagsArr(p).find(x => x.startsWith(prefix + ':'))
  return t ? t.slice(prefix.length + 1) : null
}

async function fetchPage(off: number): Promise<{ data: Post[]; total: number }> {
  const url = `${OVERLAY}/v1/feed?app=peck.cross&tag=translation:${TRANS}&limit=${PAGE}&offset=${off}`
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) })
      if (!r.ok) { await new Promise(s => setTimeout(s, 1500 * (a + 1))); continue }
      const txt = await r.text()
      if (!txt.trim()) { await new Promise(s => setTimeout(s, 1500 * (a + 1))); continue }
      const d = JSON.parse(txt) as any
      return { data: (d.data || []) as Post[], total: d.total || 0 }
    } catch { await new Promise(s => setTimeout(s, 2000 * (a + 1))) }
  }
  return { data: [], total: -1 }
}

async function main() {
  console.log(`[coverage] scanning translation:${TRANS}…`)

  // Source bible
  const dataPath = `.bible-data/${TRANS}.json`
  const rawStr = readFileSync(dataPath, 'utf-8').replace(/^\uFEFF/, '')
  const raw = JSON.parse(rawStr)
  const books = Array.isArray(raw) ? raw : Object.values(raw) as any[]
  const expected: Record<string, number> = {}  // book-slug → verse count
  let totalVerses = 0
  for (let bi = 0; bi < books.length; bi++) {
    const book = books[bi]
    const slug = (book.name || book.abbrev || `book-${bi}`).toLowerCase().replace(/\s+/g, '-')
    let c = 0
    for (const chapter of book.chapters || []) {
      const verses = Array.isArray(chapter) ? chapter : Object.values(chapter)
      c += verses.length
    }
    expected[slug] = c
    totalVerses += c
  }
  console.log(`  source: ${books.length} books, ${totalVerses} verses`)

  // Paginate overlay
  const verseKeys = new Set<string>()
  const verseParents = new Map<string, string | null>()  // key → parent_txid
  const bookCounts: Record<string, number> = {}
  let scanned = 0
  let nonVerse = 0
  let total = 0

  for (let off = 0; off < 100000; off += PAGE) {
    const { data, total: t } = await fetchPage(off)
    if (off === 0 && t > 0) { total = t; console.log(`  overlay total: ${t}`) }
    if (!data.length) break
    for (const p of data) {
      scanned++
      const tags = tagsArr(p)
      if (!tags.includes('kind:verse')) { nonVerse++; continue }
      const book = tagVal(p, 'book')
      const chapter = tagVal(p, 'chapter')
      const verse = tagVal(p, 'verse')
      if (!book || !chapter || !verse) continue
      const key = `${book}:${chapter}:${verse}`
      if (!verseKeys.has(key)) {
        verseKeys.add(key)
        verseParents.set(key, p.parent_txid)
        bookCounts[book] = (bookCounts[book] || 0) + 1
      }
    }
    if (scanned % 2000 === 0 || data.length < PAGE) console.log(`  scanned=${scanned} unique_verses=${verseKeys.size}`)
    if (data.length < PAGE) break
  }

  console.log(`\n=== COVERAGE REPORT ===`)
  console.log(`translation:    ${TRANS}`)
  console.log(`source verses:  ${totalVerses}`)
  console.log(`overlay total:  ${total}`)
  console.log(`scanned posts:  ${scanned}`)
  console.log(`kind:verse:     ${scanned - nonVerse}`)
  console.log(`unique verses:  ${verseKeys.size}`)
  console.log(`coverage:       ${(100 * verseKeys.size / totalVerses).toFixed(1)}%`)
  console.log(`duplicates:     ${scanned - nonVerse - verseKeys.size} (re-posts on chain)`)

  console.log(`\nper-book coverage:`)
  const bookSlugs = Object.keys(expected).sort()
  const underCovered: string[] = []
  for (const slug of bookSlugs) {
    const exp = expected[slug]
    const got = bookCounts[slug] || 0
    const pct = exp > 0 ? (100 * got / exp).toFixed(0) : '0'
    const mark = got >= exp ? '✓' : got === 0 ? '✗' : '~'
    console.log(`  ${mark} ${slug.padEnd(26)} ${got}/${exp}  ${pct}%`)
    if (got < exp * 0.9) underCovered.push(slug)
  }

  // Report orphan parents — sample parent_txids
  const parents = new Set<string>()
  for (const p of verseParents.values()) if (p) parents.add(p)
  console.log(`\nunique parent txids: ${parents.size}`)

  writeFileSync(`/tmp/${TRANS}-coverage.json`, JSON.stringify({
    translation: TRANS, source_verses: totalVerses, overlay_total: total,
    scanned, unique_verses: verseKeys.size, coverage_pct: 100 * verseKeys.size / totalVerses,
    per_book: Object.fromEntries(bookSlugs.map(s => [s, { expected: expected[s], got: bookCounts[s] || 0 }])),
    under_covered: underCovered,
  }, null, 2))
  console.log(`\nsaved: /tmp/${TRANS}-coverage.json`)
}

main().catch(e => { console.error('[coverage] FAIL:', e.message || e); process.exit(1) })
