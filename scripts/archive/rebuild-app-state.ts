/**
 * rebuild-app-state.ts — reconcile local wisdom/classics state with chain.
 *
 * Inputs (in cwd):
 *   .{app}-roots.json         — work → root_txid map from VM
 *   .{app}-progress/*.json    — agent progress files from VM
 *
 * Process:
 *   1) Verify every work root on chain (WoC /tx/hash)
 *   2) For each agent-progress file, verify each chapter_txid on chain
 *   3) Detect orphans: txids that were broadcast/returned OK but never mined
 *   4) Emit a clean roots + progress state (only chain-confirmed refs)
 *
 * Outputs:
 *   .{app}-roots-clean.json
 *   .{app}-progress-clean/*.json
 *   /tmp/{app}-rebuild-report.json  — summary of orphans + discrepancies
 *
 * Usage:
 *   npx tsx scripts/rebuild-app-state.ts <app_tag>
 *   e.g. classics / wisdom
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs'

const APP = process.argv[2]
if (!APP) { console.error('usage: rebuild-app-state.ts <classics|wisdom>'); process.exit(1) }

const ROOTS_FILE = `.${APP}-roots.json`
const PROGRESS_DIR = `.${APP}-progress`
const CLEAN_ROOTS = `.${APP}-roots-clean.json`
const CLEAN_PROGRESS = `.${APP}-progress-clean`
const REPORT = `/tmp/${APP}-rebuild-report.json`
const WOC = 'https://api.whatsonchain.com/v1/bsv/main'
const CONCURRENCY = 3

interface Progress {
  work: string
  root_txid: string | null
  last_chapter_idx: number
  last_paragraph_idx: number
  chapter_txids: Record<string, string>
  stats: { posted: number; failed: number; startedAt: string }
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
  if (!existsSync(ROOTS_FILE)) { console.error(`missing ${ROOTS_FILE} — pull from VM first`); process.exit(1) }
  if (!existsSync(PROGRESS_DIR)) { console.error(`missing ${PROGRESS_DIR}/ — pull from VM first`); process.exit(1) }

  const roots: Record<string, string> = JSON.parse(readFileSync(ROOTS_FILE, 'utf-8'))
  const progressFiles = readdirSync(PROGRESS_DIR).filter(f => f.endsWith('.json'))
  console.log(`[rebuild] ${APP}: ${Object.keys(roots).length} roots, ${progressFiles.length} progress files`)

  // Phase 1: verify work roots
  console.log(`\n[rebuild] phase 1: verify ${Object.keys(roots).length} work roots…`)
  const rootEntries = Object.entries(roots)
  const rootChecks = await runPool(rootEntries, CONCURRENCY, async ([work, txid]) => {
    const r = await checkChain(txid)
    return { work, txid, ...r }
  }, (d, t) => console.log(`  [roots] ${d}/${t}`))

  const orphanWorks = rootChecks.filter(r => !r.onChain && r.status === 404)
  const okWorks = rootChecks.filter(r => r.onChain)
  console.log(`  ok=${okWorks.length} orphan=${orphanWorks.length} errors=${rootChecks.length - okWorks.length - orphanWorks.length}`)

  const cleanRoots: Record<string, string> = {}
  for (const ok of okWorks) cleanRoots[ok.work] = ok.txid

  // Phase 2: collect all unique chapter_txids across progress files
  const progress: Record<string, Progress> = {}
  const chapterTxids = new Set<string>()
  for (const f of progressFiles) {
    try {
      const p: Progress = JSON.parse(readFileSync(`${PROGRESS_DIR}/${f}`, 'utf-8'))
      progress[f] = p
      for (const txid of Object.values(p.chapter_txids || {})) chapterTxids.add(txid as string)
    } catch { /* skip malformed */ }
  }
  const chapters = Array.from(chapterTxids)
  console.log(`\n[rebuild] phase 2: verify ${chapters.length} unique chapter txids…`)

  const chChecks = await runPool(chapters, CONCURRENCY, async (txid) => {
    const r = await checkChain(txid)
    return { txid, ...r }
  }, (d, t) => d % 100 === 0 ? console.log(`  [chapters] ${d}/${t}`) : undefined)
  const chMap = new Map<string, boolean>()
  for (const c of chChecks) chMap.set(c.txid, c.onChain)

  const orphanChapters = chChecks.filter(c => !c.onChain && c.status === 404)
  const okChapters = chChecks.filter(c => c.onChain).length
  console.log(`  ok=${okChapters} orphan=${orphanChapters.length} errors=${chChecks.length - okChapters - orphanChapters.length}`)

  // Phase 3: rewrite progress files — strip orphan chapter_txids,
  //          reset root_txid if work is orphan, and keep only confirmed.
  if (!existsSync(CLEAN_PROGRESS)) mkdirSync(CLEAN_PROGRESS, { recursive: true })
  let cleanedFiles = 0
  let strippedChapters = 0
  for (const [f, p] of Object.entries(progress)) {
    const workClean = cleanRoots[p.work]
    const newProgress: Progress = {
      ...p,
      root_txid: workClean || null,
      chapter_txids: {},
      last_chapter_idx: -1,
      last_paragraph_idx: -1,
    }
    if (workClean) {
      // Keep only chapters whose txid is on chain
      let maxConfirmedIdx = -1
      for (const [idx, txid] of Object.entries(p.chapter_txids || {})) {
        if (chMap.get(txid)) {
          newProgress.chapter_txids[idx] = txid
          const ni = parseInt(idx, 10)
          if (ni > maxConfirmedIdx) maxConfirmedIdx = ni
        } else {
          strippedChapters++
        }
      }
      newProgress.last_chapter_idx = maxConfirmedIdx
    }
    writeFileSync(`${CLEAN_PROGRESS}/${f}`, JSON.stringify(newProgress, null, 2))
    cleanedFiles++
  }

  writeFileSync(CLEAN_ROOTS, JSON.stringify(cleanRoots, null, 2))

  const report = {
    app: APP,
    generated: new Date().toISOString(),
    inputs: { roots: Object.keys(roots).length, progressFiles: progressFiles.length, uniqueChapters: chapters.length },
    roots: {
      ok: okWorks.length,
      orphan: orphanWorks.length,
      orphanList: orphanWorks.map(o => ({ work: o.work, txid: o.txid, status: o.status })),
    },
    chapters: {
      ok: okChapters,
      orphan: orphanChapters.length,
      orphanTxids: orphanChapters.map(o => o.txid),
    },
    outputs: { cleanRoots: CLEAN_ROOTS, cleanProgress: CLEAN_PROGRESS, filesWritten: cleanedFiles, strippedChapters },
  }
  writeFileSync(REPORT, JSON.stringify(report, null, 2))

  console.log(`\n[rebuild] DONE`)
  console.log(`  clean roots:          ${CLEAN_ROOTS} (${okWorks.length} works)`)
  console.log(`  clean progress:       ${CLEAN_PROGRESS}/ (${cleanedFiles} files, ${strippedChapters} orphan chapters stripped)`)
  console.log(`  report:               ${REPORT}`)
  if (orphanWorks.length > 0) {
    console.log(`\n  ORPHAN WORKS (must re-post root + cascade):`)
    for (const o of orphanWorks) console.log(`    ${o.work}: ${o.txid}`)
  }
  if (orphanChapters.length > 0) {
    console.log(`\n  ORPHAN CHAPTERS: ${orphanChapters.length} (progress will restart those chapters)`)
  }
}

main().catch(e => { console.error('[rebuild] FAIL:', e.message || e); process.exit(1) })
