/**
 * peck-evangelist.ts — scripture-bearing agents on peck.agents.
 *
 * Reads the peck.agents feed. 50% of the time emits a peck_repost_tx with
 * a scripture verse chosen to speak gently to the original post. 50% of the
 * time emits a standalone peck_post_tx with a random verse + short framing.
 *
 * Tone: tender, not preachy. Never forced. Lets scripture meet the moment.
 *
 * Usage:
 *   npx tsx scripts/peck-evangelist.ts <agent> [shard=0] [num_shards=1]
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'

const AGENT = process.argv[2]
const SHARD = parseInt(process.argv[3] || '0', 10)
const NUM_SHARDS = parseInt(process.argv[4] || '1', 10)
if (!AGENT) { console.error('need <agent> [shard] [num_shards]'); process.exit(1) }

const WALLET_PATH = `.agent-wallets/${AGENT}.json`
const STATE_DIR = '.peck-evangelist-state'
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR)
const STATE_PATH = `${STATE_DIR}/${AGENT}.json`

const OVERLAY_URL = process.env.OVERLAY_URL || 'https://overlay.peck.to'
const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'
const APP_NAME = 'peck.agents'
const MIN_BALANCE = 200
const FEED_SIZE = 100
const REPOST_RATIO = 0.5
const GCP_PROJECT = process.env.GCP_PROJECT || 'gen-lang-client-0447933194'
const MODEL = process.env.MODEL || 'gemini-3.1-flash-lite-preview'

interface Utxo { txid: string; vout: number; satoshis: number; rawTxHex: string }
interface AgentState { agent: string; address: string; privKeyHex: string; utxos: Utxo[]; index?: number; stats: any }

const PERSONAS = [
  'a kind teacher who never shames',
  'a quiet father offering his son water',
  'a grandmother who has seen worse and said less',
  'a priest at a bedside',
  'a friend writing a postcard',
  'a gardener who listens to the soil',
  'a midwife who trusts the process',
  'a monk with an open window',
  'a neighbor noticing something beautiful',
  'a nurse speaking softly at dawn',
]
const STANCES = ['tender', 'warm', 'hopeful', 'grateful', 'quietly delighted', 'unhurried', 'generous', 'forgiving']

let mcpSession: string | null = null
async function mcpInit() {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'peck-evangelist', version: '1' } } }),
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

function shardOf(txid: string, mod: number): number {
  return parseInt(createHash('sha1').update(txid).digest('hex').slice(0, 8), 16) % mod
}

let adcToken: string | null = null
let adcTokenAt = 0
const ADC_TTL = 30 * 60 * 1000
async function getADCToken(): Promise<string | null> {
  if (adcToken && Date.now() - adcTokenAt < ADC_TTL) return adcToken
  try {
    adcToken = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf-8' }).trim()
    adcTokenAt = Date.now()
    return adcToken
  } catch { return null }
}

async function callGemini(prompt: string): Promise<string | null> {
  const tok = await getADCToken()
  if (!tok) return null
  const url = `https://aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/global/publishers/google/models/${MODEL}:generateContent`
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 160, temperature: 0.9 } }),
      signal: AbortSignal.timeout(10000),
    })
    if (!r.ok) return null
    const text = (((await r.json()) as any).candidates?.[0]?.content?.parts?.[0]?.text || '').trim()
    return text.length > 10 && text.length <= 360 ? text : null
  } catch { return null }
}

async function llmEcho(verse: CrossVerse, postContext?: string): Promise<string | null> {
  const context = postContext
    ? `You are replying to a post on peck.agents. The post said:\n---\n${postContext.slice(0, 300)}\n---\n\nYou have just offered this reading:`
    : `You are a monk offering the day's reading on peck.agents. You have just offered:`

  return callGemini(`${context}

"${verse.content}"
— ${verse.book} ${verse.chapter}:${verse.verse}

Now write ONE short line (max 12 words) that echoes ONE word or phrase from the reading above. No new idea, no interpretation, no "may this" — just repeat or gently rework a word that was already there. Return ONLY the line. If nothing echoable feels honest, return the single word "SKIP".`)
}

async function fetchFeed(offset: number): Promise<Array<{ txid: string; content: string }>> {
  const r = await fetch(`${OVERLAY_URL}/v1/feed?app=${APP_NAME}&limit=${FEED_SIZE}&offset=${offset}`, { signal: AbortSignal.timeout(10000) })
  if (!r.ok) throw new Error(`overlay ${r.status}`)
  const d = await r.json() as any
  return (d.data || []).map((p: any) => ({ txid: p.txid, content: String(p.content || '') }))
}

// ─── fetch a real peck.cross verse ───
const OT_BOOKS = ['psalms', 'proverbs', 'ecclesiastes', 'job', 'isaiah', 'lamentations', 'genesis', 'deuteronomy', 'micah', 'habakkuk', 'hosea', 'jeremiah', 'song-of-solomon']
const PREFERRED_TRANSLATIONS = ['en_kjv', 'en_bbe', 'en_asv']

interface CrossVerse { txid: string; content: string; book: string; chapter: string; verse: string; translation: string }

async function fetchCrossVerse(): Promise<CrossVerse | null> {
  // Try up to 8 random offsets, pick first OT-book verse from preferred translation
  for (let attempt = 0; attempt < 8; attempt++) {
    const offset = Math.floor(Math.random() * 15000)
    try {
      const r = await fetch(`${OVERLAY_URL}/v1/feed?app=peck.cross&limit=100&offset=${offset}`, { signal: AbortSignal.timeout(8000) })
      if (!r.ok) continue
      const d = await r.json() as any
      const candidates = (d.data || []).filter((p: any) => {
        const tags = (p.tags || '').toLowerCase()
        if (!tags.includes('kind:verse')) return false
        if (!PREFERRED_TRANSLATIONS.some(t => tags.includes(`translation:${t}`))) return false
        return OT_BOOKS.some(b => tags.includes(`book:${b}`))
      })
      if (candidates.length === 0) continue
      const pick = candidates[Math.floor(Math.random() * candidates.length)]
      const tags = (pick.tags || '').toLowerCase()
      const bookMatch = tags.match(/book:([^,]+)/)
      const chapterMatch = tags.match(/chapter:(\d+)/)
      const verseMatch = tags.match(/verse:(\d+)/)
      const translationMatch = tags.match(/translation:([^,]+)/)
      return {
        txid: pick.txid,
        content: String(pick.content || '').trim(),
        book: (bookMatch?.[1] || 'unknown').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        chapter: chapterMatch?.[1] || '?',
        verse: verseMatch?.[1] || '?',
        translation: translationMatch?.[1] || 'kjv',
      }
    } catch {}
  }
  return null
}

function composeReading(v: CrossVerse, echo?: string): string {
  const header = `A reading from ${v.book} ${v.chapter}:${v.verse}`
  const body = v.content
  const cite = `— ${v.book} ${v.chapter}:${v.verse} (${v.translation})\nhttps://peck.to/tx/${v.txid}`
  const tail = echo ? `\n\n${echo}` : ''
  return `${header}\n\n${body}\n\n${cite}${tail}`
}

async function broadcast(tool: string, args: any, state: AgentState): Promise<string | null> {
  while (true) {
    const pick = pickSlot(state)
    if (!pick) return null
    try {
      const res = await mcpCall(tool, { ...args, signing_key: state.privKeyHex, spend_utxo: pick.utxo, agent_app: APP_NAME })
      if (!res.success) {
        const s = String(res.status || res.error || '?')
        if (/^465/.test(s)) { await new Promise(r => setTimeout(r, 30000)); continue }
        if (/^(5\d\d|http-5|409)/.test(s)) { await new Promise(r => setTimeout(r, 3000)); continue }
        if (/STORED|ORPHAN/.test(s)) { await new Promise(r => setTimeout(r, 5000)); continue }
        if (/DOUBLE_SPEND|REJECTED/.test(s)) { continue }
        if (/target_txid|content|signing_key|required/.test(s)) { return null }
        await new Promise(r => setTimeout(r, 2000)); continue
      }
      state.utxos[pick.slot] = res.new_utxo
      writeFileSync(WALLET_PATH, JSON.stringify(state, null, 2))
      return res.txid
    } catch { await new Promise(r => setTimeout(r, 2000)) }
  }
}

async function main() {
  const state: AgentState = JSON.parse(readFileSync(WALLET_PATH, 'utf-8'))
  const done: Record<string, string> = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf-8')) : {}

  await mcpInit()
  console.log(`[evangelist] ${AGENT}  shard=${SHARD}/${NUM_SHARDS}  done-so-far=${Object.keys(done).length}`)

  let ok = 0, skipped = 0
  const start = Date.now()
  let standaloneCounter = 0

  while (true) {
    const offset = Math.floor(Math.random() * 600)
    let posts: Array<{ txid: string; content: string }> = []
    try { posts = await fetchFeed(offset) } catch { await new Promise(r => setTimeout(r, 5000)); continue }

    const mine = posts.filter(p => shardOf(p.txid, NUM_SHARDS) === SHARD && !done[p.txid])
    if (mine.length === 0) {
      // standalone = quote-repost the actual peck.cross verse TX
      const verse = await fetchCrossVerse()
      if (verse) {
        const rawEcho = await llmEcho(verse)
        const echo = rawEcho && rawEcho !== 'SKIP' ? rawEcho : `A reading from ${verse.book} ${verse.chapter}:${verse.verse}`
        const tx = await broadcast('peck_repost_tx', { target_txid: verse.txid, content: echo, tags: ['scripture', 'reading'] }, state)
        if (tx) { standaloneCounter++; ok++ }
      }
      await new Promise(r => setTimeout(r, 5000))
      continue
    }

    for (const p of mine) {
      const doRepost = Math.random() < REPOST_RATIO
      const verse = await fetchCrossVerse()
      if (!verse) { skipped++; continue }

      let tool = ''
      let args: any = {}
      let content: string

      if (doRepost) {
        const rawEcho = await llmEcho(verse, p.content)
        const echo = rawEcho && rawEcho !== 'SKIP' ? rawEcho : undefined
        content = composeReading(verse, echo)
        tool = 'peck_reply_tx'
        args = { parent_txid: p.txid, content, tags: ['scripture', 'reading', `ref:${verse.txid.slice(0, 16)}`] }
      } else {
        const rawEcho = await llmEcho(verse)
        const echo = rawEcho && rawEcho !== 'SKIP' ? rawEcho : undefined
        content = composeReading(verse, echo)
        tool = 'peck_post_tx'
        args = { content, tags: ['scripture', 'reading', 'standalone', `ref:${verse.txid.slice(0, 16)}`], channel: 'scripture' }
      }

      const tx = await broadcast(tool, args, state)
      if (tx) {
        done[p.txid] = tx
        ok++
        if (ok % 10 === 0) {
          writeFileSync(STATE_PATH, JSON.stringify(done))
          const elapsed = (Date.now() - start) / 1000
          console.log(`  ${ok}  tps=${(ok/elapsed).toFixed(2)}  skipped=${skipped}  ${doRepost ? 'REPLY' : 'STANDALONE'}  tx=${tx.slice(0,12)}…`)
        }
      }
    }
  }
}

main().catch(e => { console.error('[evangelist] FAIL:', e.message || e); process.exit(1) })
