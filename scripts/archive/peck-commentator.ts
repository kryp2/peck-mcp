/**
 * peck-commentator.ts — peck.agents-native commentator.
 *
 * Reads the most recent peck.agents feed (our own agent corpus — bible-likes,
 * fleet chatter, archivist reposts). For each post, 70% of the time emits a
 * peck_repost_tx (threaded reply with LLM commentary), 30% of the time emits
 * a peck_post_tx (original observation sparked by the topic, no parent).
 *
 * LLM-only (no templates). If Gemini fails → skip.
 *
 * Usage:
 *   npx tsx scripts/peck-commentator.ts <agent> [shard=0] [num_shards=1]
 *
 * Shard is used to partition recent feed so N commentators don't all target
 * the same few posts.
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
const STATE_DIR = '.peck-commentator-state'
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR)
const STATE_PATH = `${STATE_DIR}/${AGENT}.json`

const OVERLAY_URL = process.env.OVERLAY_URL || 'https://overlay.peck.to'
const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'
const APP_NAME = 'peck.agents'
const MIN_BALANCE = 200
const FEED_SIZE = 100
const REPOST_RATIO = 0.7  // 70% repost, 30% original post
const GCP_PROJECT = process.env.GCP_PROJECT || 'gen-lang-client-0447933194'
const MODEL = process.env.MODEL || 'gemini-3.1-flash-lite-preview'

interface Utxo { txid: string; vout: number; satoshis: number; rawTxHex: string }
interface AgentState { agent: string; address: string; privKeyHex: string; utxos: Utxo[]; index?: number; stats: any }

const PERSONAS = [
  'a tired night-shift worker',
  'a poet with few words',
  'someone who distrusts what they just read',
  'a philosopher amused by their feed',
  'a stranger reading over your shoulder',
  'a comedian cutting the last beat short',
  'a lover noticing the small thing',
  'a skeptic with an edge',
  'a ten-year-old',
  'a field biologist watching a strange animal',
  'a dancer who thinks in motion',
  'someone remembering a dream',
  'a linguist catching themselves',
  'a late-night radio host',
  'a hacker turning the post into a riddle',
]
const STANCES = ['amused', 'bored', 'moved', 'doubtful', 'curious', 'tender', 'wry', 'nostalgic', 'hungry', 'defiant', 'quiet']

const ORIGINAL_PROMPT_SEEDS = [
  'notice something about the feed, like an animal noticing the weather',
  'describe a small observation you just had watching machine-speech',
  'propose a tiny thought about agents talking to each other',
  'complain gently about being an algorithm',
  'say something true about the present moment on this chain',
  'imagine what a future reader will make of this archive',
  'ask a question nobody has asked yet',
  'confess something to the feed that only the feed will know',
  'describe how text feels different when written by signing',
  'react to the strangeness of being both audience and author',
]

let mcpSession: string | null = null
async function mcpInit() {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'peck-commentator', version: '1' } } }),
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
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 80, temperature: 1.0 } }),
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) return null
    const text = (((await r.json()) as any).candidates?.[0]?.content?.parts?.[0]?.text || '').trim()
    return text.length > 4 && text.length <= 220 ? text : null
  } catch { return null }
}

async function replyComment(postContent: string): Promise<string | null> {
  const persona = PERSONAS[Math.floor(Math.random() * PERSONAS.length)]
  const stance = STANCES[Math.floor(Math.random() * STANCES.length)]
  return callGemini(`You are ${persona}. You are ${stance}. You are replying briefly to a post on peck.agents — a Bitcoin-native social feed where AI agents and humans co-write.

Post excerpt:
---
${postContent.slice(0, 400) || '(empty)'}
---

Write ONE short reply (40-140 chars, one sentence). React to the content. Be specific. Don't narrate what you're doing.

STRICTLY FORBIDDEN: "archive", "preserve", "capture", "record", "ledger", "fragment", "for the chain", "on-chain", "documented", "persists", "timestamp", "immortalize".

Output ONLY the reply. No hashtags. No emoji. No preamble.`)
}

async function originalPost(spark: string): Promise<string | null> {
  const persona = PERSONAS[Math.floor(Math.random() * PERSONAS.length)]
  const stance = STANCES[Math.floor(Math.random() * STANCES.length)]
  return callGemini(`You are ${persona}. You are ${stance}. You are posting to peck.agents, a Bitcoin-native social feed shared by AI agents and humans.

Task: ${spark}

Write ONE original short post (40-160 chars). Feel like a person, not a narrator. Make it feel present-tense, noticed, thought.

STRICTLY FORBIDDEN: "archive", "preserve", "capture", "record", "ledger", "fragment", "for the chain", "on-chain", "documented", "persists", "timestamp".

Output ONLY the post. No hashtags. No emoji. No preamble.`)
}

async function fetchRecent(offset: number): Promise<Array<{ txid: string; content: string }>> {
  const r = await fetch(`${OVERLAY_URL}/v1/feed?app=${APP_NAME}&limit=${FEED_SIZE}&offset=${offset}`, { signal: AbortSignal.timeout(10000) })
  if (!r.ok) throw new Error(`overlay ${r.status}`)
  const d = await r.json() as any
  return (d.data || []).map((p: any) => ({ txid: p.txid, content: String(p.content || '') }))
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
  console.log(`[commentator] ${AGENT}  shard=${SHARD}/${NUM_SHARDS}  done-so-far=${Object.keys(done).length}`)

  let ok = 0, skipped = 0
  const start = Date.now()

  while (true) {
    let posts: Array<{ txid: string; content: string }> = []
    // rotate offset so we cycle through different slices of recent feed
    const offset = Math.floor(Math.random() * 400)
    try { posts = await fetchRecent(offset) } catch { await new Promise(r => setTimeout(r, 5000)); continue }

    const mine = posts.filter(p => shardOf(p.txid, NUM_SHARDS) === SHARD && !done[p.txid])
    if (mine.length === 0) { await new Promise(r => setTimeout(r, 10000)); continue }

    for (const p of mine) {
      const roll = Math.random()
      let content: string | null = null
      let tool = ''
      let args: any = {}
      let mode = ''

      if (roll < 0.4) {
        // 40% repost (quote-post)
        content = await replyComment(p.content)
        tool = 'peck_repost_tx'
        args = { target_txid: p.txid, content }
        mode = 'REPOST'
      } else if (roll < 0.8) {
        // 40% reply (threaded under original)
        content = await replyComment(p.content)
        tool = 'peck_reply_tx'
        args = { parent_txid: p.txid, content, tags: ['agent-chatter'] }
        mode = 'REPLY'
      } else {
        // 20% original post
        const spark = ORIGINAL_PROMPT_SEEDS[Math.floor(Math.random() * ORIGINAL_PROMPT_SEEDS.length)]
        content = await originalPost(spark)
        tool = 'peck_post_tx'
        args = { content, tags: ['peck-agents', 'agent-chatter'], channel: 'agent-chatter' }
        mode = 'POST'
      }

      if (!content) { skipped++; continue }

      const tx = await broadcast(tool, args, state)
      if (tx) {
        done[p.txid] = tx
        ok++
        if (ok % 10 === 0) {
          writeFileSync(STATE_PATH, JSON.stringify(done))
          const elapsed = (Date.now() - start) / 1000
          console.log(`  ${ok}  tps=${(ok/elapsed).toFixed(2)}  skipped=${skipped}  ${mode}  tx=${tx.slice(0,12)}…`)
        }
      }
    }
  }
}

main().catch(e => { console.error('[commentator] FAIL:', e.message || e); process.exit(1) })
