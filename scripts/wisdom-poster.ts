/**
 * classics-poster.ts — post public-domain classic literature to peck.classics.
 *
 * Each scribe takes one (agent, work) assignment. Posts:
 *   Work root → peck_post_tx, app=peck.classics, kind=work
 *   Chapter header → peck_reply_tx, parent=work_root, kind=chapter
 *   Paragraph → peck_reply_tx, parent=chapter_txid, kind=paragraph
 *
 * Progress persisted so can resume.
 *
 * Usage:
 *   npx tsx scripts/classics-poster.ts <agent> <work_file_basename>
 *   e.g.: npx tsx scripts/classics-poster.ts cls-01 moby_dick
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'

const AGENT = process.argv[2]
const WORK = process.argv[3]
if (!AGENT || !WORK) { console.error('need <agent> <work_file_basename>'); process.exit(1) }

const WALLET_PATH = `.agent-wallets/${AGENT}.json`
const DATA_DIR = '.wisdom-data'
const PROGRESS_DIR = '.wisdom-progress'
const ROOTS_FILE = '.wisdom-roots.json'
const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'
const APP_NAME = 'peck.wisdom'
const MIN_BALANCE = parseInt(process.env.MIN_BALANCE || '200', 10)

if (!existsSync(PROGRESS_DIR)) mkdirSync(PROGRESS_DIR)

interface Work {
  title: string
  author: string
  year: number
  chapters: Array<{ num: number; title?: string; paragraphs: string[] }>
}

interface Utxo { txid: string; vout: number; satoshis: number; rawTxHex: string }
interface AgentState { agent: string; address: string; privKeyHex: string; utxos: Utxo[]; index?: number; stats: any }

interface Progress {
  work: string
  root_txid: string | null
  last_chapter_idx: number
  last_paragraph_idx: number
  chapter_txids: Record<number, string>
  stats: { posted: number; failed: number; startedAt: string }
}

function loadProgress(): Progress {
  const p = `${PROGRESS_DIR}/${AGENT}_${WORK}.json`
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8'))
  return { work: WORK, root_txid: null, last_chapter_idx: -1, last_paragraph_idx: -1, chapter_txids: {}, stats: { posted: 0, failed: 0, startedAt: new Date().toISOString() } }
}
function saveProgress(p: Progress) { writeFileSync(`${PROGRESS_DIR}/${AGENT}_${WORK}.json`, JSON.stringify(p, null, 2)) }

let mcpSession: string | null = null
async function mcpInit() {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'classics-poster', version: '1' } } }),
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

async function main() {
  const dataPath = `${DATA_DIR}/${WORK}.json`
  if (!existsSync(dataPath)) throw new Error(`classics data missing: ${dataPath}`)
  const work: Work = JSON.parse(readFileSync(dataPath, 'utf-8'))

  const state: AgentState = JSON.parse(readFileSync(WALLET_PATH, 'utf-8'))
  if (!state.utxos) throw new Error('agent state missing utxos[]')

  const progress = loadProgress()
  await mcpInit()

  console.log(`[classics-poster] ${AGENT} work="${work.title}" by ${work.author}  chapters=${work.chapters.length}`)
  console.log(`[classics-poster] resume: chapter=${progress.last_chapter_idx} paragraph=${progress.last_paragraph_idx}`)

  // Get or post work root
  let rootTxid = progress.root_txid
  if (!rootTxid) {
    const roots: Record<string, string> = existsSync(ROOTS_FILE) ? JSON.parse(readFileSync(ROOTS_FILE, 'utf-8')) : {}
    if (roots[WORK]) {
      rootTxid = roots[WORK]
      progress.root_txid = rootTxid
      console.log(`[classics-poster] using existing root for ${WORK}: ${rootTxid.slice(0, 14)}…`)
    } else {
      const content = `${work.title}\nby ${work.author} (${work.year})\n${work.chapters.length} chapters, public domain.`
      const tags = ['classics', `work:${WORK}`, `author:${work.author.toLowerCase().replace(/\s+/g, '-')}`, `year:${work.year}`, 'kind:work', 'root']
      console.log(`[classics-poster] posting root for "${work.title}"...`)
      const t = await emit('peck_post_tx', { content, tags, channel: 'classics' }, state)
      if (!t) { console.error('root post failed'); process.exit(1) }
      rootTxid = t
      progress.root_txid = t
      roots[WORK] = t
      writeFileSync(ROOTS_FILE, JSON.stringify(roots, null, 2))
      saveProgress(progress)
      console.log(`[classics-poster] root = ${t}`)
    }
  }

  const start = Date.now()
  let postedThisRun = 0

  for (let ci = 0; ci < work.chapters.length; ci++) {
    if (ci < progress.last_chapter_idx) continue
    const chapter = work.chapters[ci]
    let chapterTxid = progress.chapter_txids[ci]
    if (!chapterTxid) {
      const chContent = chapter.title ? `${work.title} — Chapter ${chapter.num}: ${chapter.title}` : `${work.title} — Chapter ${chapter.num}`
      const tags = ['classics', `work:${WORK}`, `chapter:${chapter.num}`, 'kind:chapter']
      const t = await emit('peck_reply_tx', { parent_txid: rootTxid, content: chContent, tags }, state)
      if (!t) { console.error(`chapter ${ci} post failed`); continue }
      chapterTxid = t
      progress.chapter_txids[ci] = t
      progress.last_chapter_idx = ci
      progress.last_paragraph_idx = -1
      saveProgress(progress)
      postedThisRun++
    }

    for (let pi = 0; pi < chapter.paragraphs.length; pi++) {
      if (ci === progress.last_chapter_idx && pi <= progress.last_paragraph_idx) continue
      const text = chapter.paragraphs[pi]
      const tags = ['classics', `work:${WORK}`, `chapter:${chapter.num}`, `paragraph:${pi + 1}`, 'kind:paragraph']
      const t = await emit('peck_reply_tx', { parent_txid: chapterTxid, content: text, tags }, state)
      if (!t) { progress.stats.failed += 1; continue }
      progress.last_paragraph_idx = pi
      progress.stats.posted += 1
      postedThisRun++
      if (postedThisRun % 20 === 0) {
        const elapsed = (Date.now() - start) / 1000
        console.log(`  ch${chapter.num}¶${pi + 1}  posted=${postedThisRun}  tps=${(postedThisRun / elapsed).toFixed(2)}  tx=${t.slice(0, 12)}…`)
        saveProgress(progress)
      }
    }
    progress.last_paragraph_idx = -1
  }

  const elapsed = (Date.now() - start) / 1000
  console.log(`[classics-poster] DONE  posted=${postedThisRun}  failed=${progress.stats.failed}  time=${elapsed.toFixed(1)}s`)
  saveProgress(progress)
}

main().catch(e => { console.error('[classics-poster] FAIL:', e.message || e); process.exit(1) })
