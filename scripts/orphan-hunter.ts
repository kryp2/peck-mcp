/**
 * orphan-hunter.ts — scan overlay feed for posts referencing parent_txids,
 * then verify each unique parent is actually on chain via WoC. Report broken
 * threads where the parent is missing (orphan / never mined / fell from mempool).
 *
 * Why: when a parent TX is broadcast but never confirmed, every child TX that
 * points at it via parent_txid (MAP context:tx or reply_to) becomes thread-
 * less in the indexer, even if the child itself is mined. This is the exact
 * class of bug Thomas flagged with no_1930_book_23 (fbb69469).
 *
 * Usage:
 *   npx tsx scripts/orphan-hunter.ts [--app <name>] [--limit <N>] [--offset <N>]
 *     [--concurrency <N>] [--out <path>]
 *
 * Examples:
 *   npx tsx scripts/orphan-hunter.ts --app peck.cross --limit 5000
 *   npx tsx scripts/orphan-hunter.ts --limit 20000 --out /tmp/orphan-full.json
 */
import 'dotenv/config'
import { writeFileSync } from 'fs'

const args = process.argv.slice(2)
function arg(name: string, def?: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : def
}

const APP = arg('app')
const LIMIT = parseInt(arg('limit', '5000')!, 10)
const OFFSET = parseInt(arg('offset', '0')!, 10)
const CONCURRENCY = parseInt(arg('concurrency', '8')!, 10)
const OUT = arg('out', '/tmp/orphan-report.json')!
const OVERLAY = process.env.OVERLAY_URL || 'https://overlay.peck.to'
const WOC = 'https://api.whatsonchain.com/v1/bsv/main'
const PAGE_SIZE = 200

interface Post {
  txid: string
  parent_txid: string | null
  ref_txid?: string | null
  app?: string
  type?: string
}

async function fetchPage(offset: number): Promise<Post[]> {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
  if (APP) params.set('app', APP)
  const url = `${OVERLAY}/v1/feed?${params}`
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) })
  if (!r.ok) throw new Error(`overlay ${r.status}`)
  const d = await r.json() as any
  return (d.data || []) as Post[]
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
      if (r.status === 429) {
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1) + Math.random() * 500))
        continue
      }
      // Other 5xx/4xx — retry once or twice then bail
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
  let done = 0
  let idx = 0
  async function runner() {
    while (true) {
      const i = idx++
      if (i >= items.length) return
      results[i] = await worker(items[i], i)
      done++
      if (onProgress && done % 50 === 0) onProgress(done, items.length)
    }
  }
  const pool: Promise<void>[] = []
  for (let i = 0; i < Math.min(concurrency, items.length); i++) pool.push(runner())
  await Promise.all(pool)
  if (onProgress) onProgress(done, items.length)
  return results
}

async function main() {
  console.log(`[orphan-hunter] app=${APP || '(all)'} limit=${LIMIT} offset=${OFFSET} concurrency=${CONCURRENCY}`)

  // Phase 1: scan feed, collect parent_txids
  const parentToChildren = new Map<string, string[]>()
  let scanned = 0
  let withoutParent = 0
  for (let off = OFFSET; off < OFFSET + LIMIT; off += PAGE_SIZE) {
    const page = await fetchPage(off)
    if (page.length === 0) break
    for (const p of page) {
      scanned++
      const parents = [p.parent_txid, p.ref_txid].filter(Boolean) as string[]
      if (parents.length === 0) { withoutParent++; continue }
      for (const parent of parents) {
        if (!parentToChildren.has(parent)) parentToChildren.set(parent, [])
        const children = parentToChildren.get(parent)!
        if (children.length < 5) children.push(p.txid) // keep sample
      }
    }
    if (page.length < PAGE_SIZE) break
    if (scanned % 1000 === 0) console.log(`  [scan] offset=${off + page.length} scanned=${scanned} unique_parents=${parentToChildren.size}`)
  }

  const uniqueParents = Array.from(parentToChildren.keys())
  console.log(`\n[orphan-hunter] scanned=${scanned} with_parent=${scanned - withoutParent} without_parent=${withoutParent} unique_parents=${uniqueParents.length}`)

  // Phase 2: batch-check each parent on WoC
  console.log(`[orphan-hunter] verifying ${uniqueParents.length} parents on chain (concurrency=${CONCURRENCY})...`)
  const results = await runPool(uniqueParents, CONCURRENCY, async (txid) => {
    const res = await checkChain(txid)
    return { txid, ...res }
  }, (d, t) => console.log(`  [check] ${d}/${t} (${Math.round(100 * d / t)}%)`))

  // Phase 3: compile report
  const orphans = results.filter(r => !r.onChain && r.status === 404)
  const errors = results.filter(r => !r.onChain && r.status !== 404)
  const onChainNoHeight = results.filter(r => r.onChain && r.height == null) // mempool / unconfirmed

  const orphanReport = orphans.map(o => ({
    parent_txid: o.txid,
    childCount: parentToChildren.get(o.txid)!.length,
    sampleChildren: parentToChildren.get(o.txid)!,
  })).sort((a, b) => b.childCount - a.childCount)

  const totalOrphanChildren = orphanReport.reduce((s, o) => s + o.childCount, 0)

  const report = {
    generated: new Date().toISOString(),
    app: APP || '(all)',
    scanned,
    uniqueParents: uniqueParents.length,
    onChainMined: results.filter(r => r.onChain && r.height != null).length,
    onChainUnconfirmed: onChainNoHeight.length,
    orphans: orphans.length,
    errors: errors.length,
    totalOrphanChildren,
    orphanList: orphanReport,
    errorList: errors.map(e => ({ parent_txid: e.txid, status: e.status, childCount: parentToChildren.get(e.txid)!.length })),
  }

  writeFileSync(OUT, JSON.stringify(report, null, 2))

  console.log(`\n[orphan-hunter] DONE`)
  console.log(`  scanned posts:         ${scanned}`)
  console.log(`  unique parents:        ${uniqueParents.length}`)
  console.log(`  parents on chain:      ${report.onChainMined} mined + ${report.onChainUnconfirmed} unconfirmed`)
  console.log(`  ORPHANED parents:      ${orphans.length} (${report.totalOrphanChildren} thread-less children)`)
  console.log(`  verify errors:         ${errors.length}`)
  console.log(`  report saved to:       ${OUT}`)
  if (orphans.length > 0) {
    console.log(`\n  TOP ORPHANS BY CHILD COUNT:`)
    for (const o of orphanReport.slice(0, 10)) {
      console.log(`    ${o.parent_txid.slice(0, 20)}…  children=${o.childCount}  sample=${o.sampleChildren[0].slice(0, 16)}…`)
    }
  }
}

main().catch(e => { console.error('[orphan-hunter] FAIL:', e.message || e); process.exit(1) })
