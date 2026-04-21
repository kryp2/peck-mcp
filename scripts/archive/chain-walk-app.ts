/**
 * chain-walk-app.ts — reconstruct local state for a peck app from chain/overlay.
 *
 * For classics/wisdom apps: VM-based posting may have out-of-sync local state
 * (orphan parents, missing progress files). This script walks chain via overlay
 * to rebuild the canonical tree:
 *
 *   work-root TXs (tag=kind:work)
 *     └─ chapter-root TXs (tag=kind:chapter, parent_txid=work_root)
 *         └─ paragraph TXs (tag=kind:paragraph, parent_txid=chapter_root)
 *
 * Then verifies each parent-TX on WoC (skips orphaned nodes and their subtrees).
 *
 * Outputs:
 *   .{app}-roots-chain.json       work_slug → root_txid (chain-confirmed)
 *   .{app}-progress-chain/*.json  agent_work → { chapter_txids, posted_paragraphs }
 *   /tmp/{app}-chain-walk.json    full report
 *
 * Usage:
 *   npx tsx scripts/chain-walk-app.ts <app_tag> [--limit N] [--concurrency N]
 *   e.g. npx tsx scripts/chain-walk-app.ts classics
 */
import 'dotenv/config'
import { writeFileSync, mkdirSync, existsSync } from 'fs'

const APP = process.argv[2]
if (!APP) { console.error('usage: chain-walk-app.ts <classics|wisdom|peck.cross|...>'); process.exit(1) }
const APP_TAG = APP.includes('.') ? APP : `peck.${APP}`

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}

const CONCURRENCY = parseInt(arg('concurrency', '3')!, 10)
const PAGE_SIZE = 200
const MAX_WORKS = parseInt(arg('max-works', '50')!, 10)
const OVERLAY = process.env.OVERLAY_URL || 'https://overlay.peck.to'
const WOC = 'https://api.whatsonchain.com/v1/bsv/main'

interface Post {
  txid: string
  parent_txid: string | null
  author?: string
  tags?: string[] | string
  content?: string
  map_content?: string
  app?: string
  block_height?: number
}

async function fetchAllByTags(app: string, extraTags: string[] = [], maxPages = 100): Promise<Post[]> {
  const results: Post[] = []
  for (let off = 0; off < maxPages * PAGE_SIZE; off += PAGE_SIZE) {
    const params = new URLSearchParams({ app, limit: String(PAGE_SIZE), offset: String(off) })
    for (const t of extraTags) params.append('tag', t)
    const url = `${OVERLAY}/v1/feed?${params}`
    let tries = 0
    while (true) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(20000) })
        if (!r.ok) {
          if (r.status === 429 && tries < 4) { await new Promise(rs => setTimeout(rs, 2000)); tries++; continue }
          return results
        }
        const d = await r.json() as any
        const page = (d.data || []) as Post[]
        results.push(...page)
        if (page.length < PAGE_SIZE) return results
        break
      } catch (e) {
        if (tries < 3) { await new Promise(rs => setTimeout(rs, 1500)); tries++; continue }
        return results
      }
    }
  }
  return results
}

async function fetchChildren(app: string, parentTxid: string, extraTags: string[] = []): Promise<Post[]> {
  // Overlay may or may not support parent-filtered feed; fall back to tag-only
  // and filter client-side.
  const all = await fetchAllByTags(app, extraTags)
  return all.filter(p => p.parent_txid === parentTxid)
}

async function checkChain(txid: string): Promise<{ onChain: boolean; height: number | null; status: number }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(`${WOC}/tx/hash/${txid}`, { signal: AbortSignal.timeout(12000) })
      if (r.status === 200) {
        const d = await r.json() as any
        return { onChain: true, height: d.blockheight ?? null, status: 200 }
      }
      if (r.status === 404) return { onChain: false, height: null, status: 404 }
      if (r.status === 429) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1) + Math.random() * 500)); continue }
      if (attempt < 2) { await new Promise(r => setTimeout(r, 800)); continue }
      return { onChain: false, height: null, status: r.status }
    } catch {
      if (attempt < 3) { await new Promise(r => setTimeout(r, 1200)); continue }
      return { onChain: false, height: null, status: -1 }
    }
  }
  return { onChain: false, height: null, status: 429 }
}

async function runPool<T, R>(items: T[], concurrency: number, worker: (item: T, idx: number) => Promise<R>, onProgress?: (done: number, total: number) => void): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let done = 0, idx = 0
  async function runner() {
    while (true) {
      const i = idx++
      if (i >= items.length) return
      results[i] = await worker(items[i], i)
      done++
      if (onProgress && done % 25 === 0) onProgress(done, items.length)
    }
  }
  const pool: Promise<void>[] = []
  for (let i = 0; i < Math.min(concurrency, items.length); i++) pool.push(runner())
  await Promise.all(pool)
  if (onProgress) onProgress(done, items.length)
  return results
}

function tagsOf(p: Post): string[] {
  if (!p.tags) return []
  if (typeof p.tags === 'string') return p.tags.split(',').map(s => s.trim())
  return p.tags
}
function tagValue(p: Post, prefix: string): string | null {
  const t = tagsOf(p).find(x => x.startsWith(prefix + ':'))
  return t ? t.slice(prefix.length + 1) : null
}

async function main() {
  console.log(`[chain-walk] app=${APP_TAG} overlay=${OVERLAY}`)

  // Phase 1: find all work-roots
  console.log(`\n[phase 1] fetching all kind:work for ${APP_TAG}…`)
  const works = await fetchAllByTags(APP_TAG, ['kind:work'])
  console.log(`  found ${works.length} kind:work posts`)

  // Phase 2: verify each work on chain
  console.log(`\n[phase 2] verifying ${works.length} work-roots on chain…`)
  const workChecks = await runPool(works.slice(0, MAX_WORKS), CONCURRENCY, async (w) => ({ work: w, chain: await checkChain(w.txid) }), (d, t) => console.log(`  [works] ${d}/${t}`))
  const liveWorks = workChecks.filter(x => x.chain.onChain).map(x => x.work)
  const deadWorks = workChecks.filter(x => !x.chain.onChain)
  console.log(`  live=${liveWorks.length} orphan=${deadWorks.length}`)

  // Build roots map: use work-slug (tag=work:X or first 40 chars of content)
  const roots: Record<string, string> = {}
  for (const w of liveWorks) {
    let slug = tagValue(w, 'work') || tagValue(w, 'slug')
    if (!slug) {
      // Fall back to content-derived slug
      const content = w.content || w.map_content || ''
      slug = content.split('\n')[0].toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40) || w.txid.slice(0, 8)
    }
    if (roots[slug]) slug = `${slug}_${w.txid.slice(0, 6)}`  // dedupe
    roots[slug] = w.txid
  }

  // Phase 3: for each live work, walk chapters + paragraphs
  console.log(`\n[phase 3] walking chapters+paragraphs for ${liveWorks.length} works…`)
  const tree: Record<string, { work_txid: string; chapters: Record<string, { chapter_txid: string; paragraphs: Record<string, string> }> }> = {}

  for (const w of liveWorks) {
    const slug = Object.entries(roots).find(([, t]) => t === w.txid)![0]
    tree[slug] = { work_txid: w.txid, chapters: {} }

    // Fetch all kind:chapter, filter by parent_txid client-side (since overlay
    // may not support parent query in feed)
    const chapters = await fetchAllByTags(APP_TAG, ['kind:chapter', `work:${slug}`])
    const chaptersThisWork = chapters.filter(c => c.parent_txid === w.txid)
    const uniqueChapterMap: Record<string, Post> = {}
    for (const c of chaptersThisWork) {
      const num = tagValue(c, 'chapter') || c.txid.slice(0, 8)
      uniqueChapterMap[num] = c  // last-posted wins for duplicates
    }

    // Verify chapter TXs on chain
    const chapterEntries = Object.entries(uniqueChapterMap)
    const chChecks = await runPool(chapterEntries, CONCURRENCY, async ([num, c]) => ({ num, c, chain: await checkChain(c.txid) }))
    const liveChapters = chChecks.filter(x => x.chain.onChain)
    console.log(`  ${slug}: ${chapterEntries.length} chapters discovered, ${liveChapters.length} mined`)

    for (const { num, c } of liveChapters) {
      tree[slug].chapters[num] = { chapter_txid: c.txid, paragraphs: {} }
      // Fetch paragraphs under this chapter — use app + tag=kind:paragraph + tag=chapter:N
      const paragraphs = await fetchAllByTags(APP_TAG, ['kind:paragraph', `work:${slug}`, `chapter:${num}`])
      const thisChapter = paragraphs.filter(p => p.parent_txid === c.txid)
      const uniquePara: Record<string, Post> = {}
      for (const p of thisChapter) {
        const pn = tagValue(p, 'paragraph') || p.txid.slice(0, 8)
        uniquePara[pn] = p
      }
      for (const [pn, p] of Object.entries(uniquePara)) tree[slug].chapters[num].paragraphs[pn] = p.txid
    }
  }

  // Phase 4: write outputs
  const ROOTS_OUT = `.${APP}-roots-chain.json`
  const PROGRESS_OUT = `.${APP}-progress-chain`
  if (!existsSync(PROGRESS_OUT)) mkdirSync(PROGRESS_OUT, { recursive: true })

  writeFileSync(ROOTS_OUT, JSON.stringify(roots, null, 2))

  let totalChapters = 0, totalParagraphs = 0
  for (const [slug, data] of Object.entries(tree)) {
    const prog = {
      work: slug,
      root_txid: data.work_txid,
      chapter_txids: Object.fromEntries(Object.entries(data.chapters).map(([n, c]) => [n, c.chapter_txid])),
      paragraph_txids: Object.fromEntries(Object.entries(data.chapters).map(([n, c]) => [n, c.paragraphs])),
      stats: {
        chapters: Object.keys(data.chapters).length,
        paragraphs: Object.values(data.chapters).reduce((s, c) => s + Object.keys(c.paragraphs).length, 0),
      },
    }
    writeFileSync(`${PROGRESS_OUT}/${slug}.json`, JSON.stringify(prog, null, 2))
    totalChapters += prog.stats.chapters
    totalParagraphs += prog.stats.paragraphs
  }

  const report = {
    app: APP_TAG,
    generated: new Date().toISOString(),
    works: { discovered: works.length, live: liveWorks.length, orphan: deadWorks.length },
    chapters: totalChapters,
    paragraphs: totalParagraphs,
    outputs: { roots: ROOTS_OUT, progress: PROGRESS_OUT },
  }
  writeFileSync(`/tmp/${APP}-chain-walk.json`, JSON.stringify(report, null, 2))

  console.log(`\n[chain-walk] DONE`)
  console.log(`  works: ${liveWorks.length} live, ${deadWorks.length} orphan`)
  console.log(`  chapters: ${totalChapters}`)
  console.log(`  paragraphs: ${totalParagraphs}`)
  console.log(`  → ${ROOTS_OUT}`)
  console.log(`  → ${PROGRESS_OUT}/`)
  console.log(`  → /tmp/${APP}-chain-walk.json`)
}

main().catch(e => { console.error('[chain-walk] FAIL:', e.message || e); process.exit(1) })
