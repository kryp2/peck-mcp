/**
 * jeremiah-audit.ts — survey Jeremiah thread integrity across all 11 bible translations.
 *
 * For each translation, queries overlay for all kind:chapter posts with
 * book:<name-variant> tag (Jeremiah has different slugs per language):
 *   en: jeremiah
 *   pt/es: jeremias
 *   de: jeremia
 *   la: ieremias
 *   no: jeremias
 *   he: ירמיהו
 *
 * For each chapter-header TX found, verify on chain. Report orphans.
 *
 * Usage:
 *   npx tsx scripts/jeremiah-audit.ts [--book=<slug>]
 *     e.g. --book=lamentations runs same audit for Lamentations
 */
import 'dotenv/config'
import { writeFileSync } from 'fs'

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}

const BOOK_FILTER = arg('book') // optional override
const OVERLAY = process.env.OVERLAY_URL || 'https://overlay.peck.to'
const WOC = 'https://api.whatsonchain.com/v1/bsv/main'

// Per-translation Jeremiah book slug candidates (lowercase)
const JER_SLUGS: Record<string, string[]> = {
  en_kjv:        ['jeremiah'],
  en_bbe:        ['jeremiah'],
  en_asv:        ['jeremiah'],
  pt_aa:         ['jeremias'],
  es_rvr:        ['jeremías', 'jeremias'],
  de_schlachter: ['jeremia'],
  en_dr:         ['jeremias', 'jeremiah'],
  la_vulgata:    ['ieremias', 'jeremias'],
  he_wlc:        ['ירמיהו'],
  grc_nt:        [],  // no Jeremiah in NT
  no_1930:       ['jeremias'],
}

interface Post {
  txid: string
  parent_txid: string | null
  tags?: string[] | string
  content?: string
  map_content?: string
}

async function fetchPageByTags(tags: string[], offset = 0): Promise<{ data: Post[]; total: number }> {
  const params = new URLSearchParams({ app: 'peck.cross', limit: '200', offset: String(offset) })
  for (const t of tags) params.append('tag', t)
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(`${OVERLAY}/v1/feed?${params}`, { signal: AbortSignal.timeout(20000) })
      if (!r.ok) { await new Promise(s => setTimeout(s, 1500 * (a + 1))); continue }
      const txt = await r.text()
      if (!txt.trim()) { await new Promise(s => setTimeout(s, 1500 * (a + 1))); continue }
      const d = JSON.parse(txt) as any
      return { data: (d.data || []) as Post[], total: d.total || 0 }
    } catch { await new Promise(s => setTimeout(s, 1500 * (a + 1))) }
  }
  return { data: [], total: -1 }
}

async function fetchAllChapters(translation: string, bookSlug: string): Promise<Post[]> {
  const out: Post[] = []
  for (let off = 0; off < 2000; off += 200) {
    const { data, total } = await fetchPageByTags([`translation:${translation}`, `book:${bookSlug}`, 'kind:chapter'], off)
    if (!data.length) break
    out.push(...data)
    if (out.length >= total && total > 0) break
    if (data.length < 200) break
  }
  return out
}

async function checkChain(txid: string): Promise<number> {
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fetch(`${WOC}/tx/hash/${txid}`, { signal: AbortSignal.timeout(10000) })
      if (r.status === 200 || r.status === 404) return r.status
      if (r.status === 429) { await new Promise(s => setTimeout(s, 1500 * (a + 1))); continue }
      if (a < 2) { await new Promise(s => setTimeout(s, 800)); continue }
      return r.status
    } catch {
      if (a < 3) { await new Promise(s => setTimeout(s, 1200)); continue }
      return -1
    }
  }
  return -2
}

async function main() {
  const results: Record<string, { slug: string; chapters: number; missing: string[]; firstTxids: string[] }> = {}

  for (const [trans, slugs] of Object.entries(JER_SLUGS)) {
    if (!slugs.length) { results[trans] = { slug: '(n/a)', chapters: 0, missing: [], firstTxids: [] }; continue }
    let best = { slug: slugs[0], chapters: [] as Post[] }
    for (const slug of slugs) {
      const ch = await fetchAllChapters(trans, slug)
      if (ch.length > best.chapters.length) best = { slug, chapters: ch }
    }
    const chapters = best.chapters
    console.log(`  ${trans.padEnd(15)} slug=${best.slug.padEnd(14)} found ${chapters.length} chapter-headers`)

    const missing: string[] = []
    // Check each chapter-header on chain + their parent_txid
    // (parent = book-root if tracked, else translation-root direct)
    for (let i = 0; i < chapters.length; i++) {
      const c = chapters[i]
      const st = await checkChain(c.txid)
      if (st !== 200) missing.push(c.txid)
      // Also verify parent_txid
      if (c.parent_txid) {
        const pst = await checkChain(c.parent_txid)
        if (pst !== 200) missing.push(`PARENT:${c.parent_txid}(of_chapter:${c.txid.slice(0,8)})`)
      }
      await new Promise(s => setTimeout(s, 150))
    }
    results[trans] = {
      slug: best.slug,
      chapters: chapters.length,
      missing,
      firstTxids: chapters.slice(0, 3).map(c => c.txid),
    }
  }

  // Report
  console.log('\n=== JEREMIAH THREAD AUDIT ===\n')
  let totalMissing = 0
  for (const [trans, r] of Object.entries(results)) {
    const status = r.missing.length === 0 ? 'CLEAN' : `${r.missing.length} ORPHAN`
    console.log(`  ${trans.padEnd(15)} slug=${r.slug.padEnd(14)} chapters=${r.chapters}  ${status}`)
    totalMissing += r.missing.length
  }
  console.log(`\nTotal orphan refs: ${totalMissing}`)
  writeFileSync('/tmp/jeremiah-audit.json', JSON.stringify(results, null, 2))
  console.log('Report: /tmp/jeremiah-audit.json')
}

main().catch(e => { console.error('FAIL:', e.message || e); process.exit(1) })
