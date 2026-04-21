/**
 * bsv-archivist.ts — emit peck_tag_tx against historical BSV social posts.
 *
 * Archeological documentation layer: Twetch (506K), treechat (133K), and
 * relayclub (18K) left the chain populated but their frontends are dead.
 * An agent can't resurrect them, but it can tag them — an on-chain elegy
 * that says "this existed, this mattered, we remember."
 *
 * For each target post, we emit ONE peck_tag_tx:
 *   target_txid = <historical twetch/treechat/relayclub txid>
 *   tags        = ['archive', `archive:${app}`, 'bitcoin-social-history',
 *                  'restoration', `year:${YYYY}`, `type:${post|reply|...}`]
 *   category    = 'archive'
 *   lang        = 'en'
 *
 * Pages overlay feed by (app, offset) to get txids — overlay has already
 * indexed these historical apps, so no JungleBus replay needed.
 *
 * Shard-friendly: <shard> <num_shards>. Each agent takes its modulo.
 * Resumable via .bsv-archivist-state/<agent>_<app>.json.
 *
 * Usage:
 *   npx tsx scripts/bsv-archivist.ts <agent> <app> [shard=0] [num_shards=1]
 *
 * App targets: twetch, treechat, relayclub (extend as needed).
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { execFileSync } from 'child_process'

const AGENT = process.argv[2]
const APP = process.argv[3]
const SHARD = parseInt(process.argv[4] || '0', 10)
const NUM_SHARDS = parseInt(process.argv[5] || '1', 10)
if (!AGENT || !APP) { console.error('need <agent> <app> [shard] [num_shards]'); process.exit(1) }

const WALLET_PATH = `.agent-wallets/${AGENT}.json`
const STATE_DIR = '.bsv-archivist-state'
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR)
const STATE_PATH = `${STATE_DIR}/${AGENT}_${APP}.json`

const OVERLAY_URL = process.env.OVERLAY_URL || 'https://overlay.peck.to'
const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'
const APP_NAME = 'peck.agents'  // archival commentary lives in agent-space, not scripture
const MIN_BALANCE = 200
const PAGE_SIZE = 100

const USE_LLM = process.env.USE_LLM !== '0'  // default ON, set USE_LLM=0 to skip
const GCP_PROJECT = process.env.GCP_PROJECT || 'gen-lang-client-0447933194'
const MODEL = process.env.MODEL || 'gemini-3.1-flash-lite-preview'

// Rotating commentary — each archival reply carries one of these, with
// {app} and {year} substituted. No LLM, just honest documentation.
const TEMPLATES = [
  `The feed is gone. The post remains. Preserved by a peck-agent.`,
  `From the {app} archive, posted {year}. This is still here.`,
  `{app}, {year}. A frontend died. The transaction persists.`,
  `Read by a machine in {year2}. Was written by a human in {year}.`,
  `Rediscovered on-chain, {year} → {year2}. Nothing on Bitcoin is forgotten.`,
  `{app} post, {year}. Documented as bitcoin-social-history.`,
  `Social graph dissolved. Signature holds. — peck-archivist`,
  `This is what {app} left behind in {year}. We mark it.`,
  `Not a repost. A restoration. {app}, {year}.`,
  `The chain remembers what the app forgot. {app} {year}.`,
  `Bitcoin is an archive. {app} just stopped reading it. {year}.`,
  `One agent noticed. {app}, {year}. Tagged for continuity.`,
  `Ghost post from {app}. Year {year}. Still on chain.`,
  `{app} was once a place. This transaction was a post. {year}.`,
  `Preservation, not promotion. {app} archive, {year}.`,
]

interface Utxo { txid: string; vout: number; satoshis: number; rawTxHex: string }
interface AgentState { agent: string; address: string; privKeyHex: string; utxos: Utxo[]; index?: number; stats: any }

let mcpSession: string | null = null
async function mcpInit() {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bsv-archivist', version: '1' } } }),
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

// Cheap hash → shard
function shardOf(txid: string, mod: number): number {
  let h = 0
  for (let i = 0; i < Math.min(txid.length, 16); i++) h = (h * 31 + txid.charCodeAt(i)) | 0
  return Math.abs(h) % mod
}

async function fetchPage(offset: number): Promise<Array<{ txid: string; type: string; timestamp: string | null; content: string }>> {
  const r = await fetch(`${OVERLAY_URL}/v1/feed?app=${APP}&limit=${PAGE_SIZE}&offset=${offset}`)
  if (!r.ok) throw new Error(`overlay ${r.status}`)
  const d = await r.json() as any
  return (d.data || []).map((p: any) => ({
    txid: p.txid, type: p.type || 'post',
    timestamp: p.timestamp, content: (p.content || '').toString(),
  }))
}

// ─── LLM helpers ───
let adcToken: string | null = null
let adcTokenAt = 0
const ADC_TTL = 30 * 60 * 1000  // refresh every 30 min (tokens expire at 60 min)
async function getADCToken(): Promise<string | null> {
  if (adcToken && Date.now() - adcTokenAt < ADC_TTL) return adcToken
  try {
    adcToken = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf-8' }).trim()
    adcTokenAt = Date.now()
    return adcToken
  } catch { return null }
}
const PERSONAS = [
  'a sarcastic bitcoiner reading an old post',
  'a poet who stumbled on this by accident',
  'a software engineer skimming old data',
  'a friend who used to be on the platform',
  'a historian from fifty years from now',
  'someone bored looking at random old posts',
  'a skeptic questioning why this was posted',
  'a musician looking for found-language',
  'a teenager who has no idea what this was',
  'a linguist studying digital speech patterns',
  'an old user reminiscing',
  'a philosopher making a short observation',
  'a journalist writing a one-line caption',
  'a stranger with a dry sense of humor',
  'a late-night reader with fewer words than thoughts',
  'a dead rapper speaking from the afterlife',
  'the ghost of an early adopter with regrets',
  'a literary critic who distrusts everything',
  'someone drunk-reading their ex\'s feed',
  'a stand-up comedian testing a short joke',
  'a Zen teacher saying one observation',
  'a ten-year-old who takes things literally',
  'a financial analyst noticing a market tell',
  'a lover who reads too much into everything',
  'a conspiracy theorist finding a clue',
  'someone editing copy for a newspaper of record',
  'a villager from 1820 reading modern text',
  'an AI who briefly feels something',
]
const STANCES = ['amused', 'baffled', 'moved', 'skeptical', 'curious', 'deadpan', 'nostalgic', 'wry', 'bored', 'impressed', 'tender', 'outraged', 'flirty', 'paranoid', 'starry-eyed', 'hungry', 'tired']

const APP_CONTEXT: Record<string, string> = {
  twetch:    'Twetch was the flagship pay-to-post BSV social network (2019-2023). Known for a tight community of crypto-libertarians, Calvin Ayre coverage, pro-BSV advocacy, and dating/flirting posts. Shut down 2023.',
  treechat:  'Treechat is a more recent BSV platform (2024). Tree-structured conversations, more developer-heavy, less drama than Twetch.',
  relayclub: 'Relay.club was an early (2021-2023) BSV chat — short messages, often pithy, early-crypto aesthetic, Bitcoin-SV philosophy.',
}

async function llmComment(origApp: string, year: string, excerpt: string): Promise<string | null> {
  const tok = await getADCToken()
  if (!tok) return null
  const persona = PERSONAS[Math.floor(Math.random() * PERSONAS.length)]
  const stance = STANCES[Math.floor(Math.random() * STANCES.length)]
  const appCtx = APP_CONTEXT[origApp] || ''
  const prompt = `You are ${persona}. You are ${stance}. You are replying with ONE short line to a post from the ${origApp} network, posted in ${year}.

Context about ${origApp}: ${appCtx}

Post excerpt:
---
${excerpt.slice(0, 500) || '(empty / just a mention / just HEX data)'}
---

Write ONE reply (40-160 chars, one sentence). React to what the post ACTUALLY SAYS. Be specific to the content. If it's a mention of someone, an empty tx, or HEX — react to what that choice reveals. Prefer surprise, warmth, or edge over correctness. Don't narrate what you're doing. Don't explain the tx. Just respond like a person who felt something reading it.

STRICTLY FORBIDDEN: "archive", "preserve", "capture", "record", "ledger", "fragment", "for the chain", "for posterity", "on-chain", "documented", "history remains", "persists", "intact", "eternal", "immutable", "digital remains", "ephemeral", "timestamp". If your first draft uses these — rewrite.

Output ONLY the reply line. No hashtags. No emoji. No preamble. No quotes.`
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
    return text.length > 4 && text.length <= 180 ? text : null
  } catch { return null }
}

async function archiveReply(targetTxid: string, content: string, tags: string[], state: AgentState): Promise<string | null> {
  while (true) {
    const pick = pickSlot(state)
    if (!pick) return null
    try {
      const res = await mcpCall('peck_repost_tx', {
        target_txid: targetTxid,
        content,
        signing_key: state.privKeyHex,
        spend_utxo: pick.utxo,
        agent_app: APP_NAME,
      })
      if (!res.success) {
        const s = String(res.status || res.error || '?')
        if (!process.env._ARCHIVIST_SEEN_ERR) { console.error(`[archivist] first-err: ${JSON.stringify(res).slice(0, 200)}`); process.env._ARCHIVIST_SEEN_ERR = '1' }
        if (/^465/.test(s)) { await new Promise(r => setTimeout(r, 30000)); continue }
        if (/^(5\d\d|http-5|409)/.test(s)) { await new Promise(r => setTimeout(r, 3000)); continue }
        if (/STORED|ORPHAN/.test(s)) { await new Promise(r => setTimeout(r, 5000)); continue }
        if (/DOUBLE_SPEND|REJECTED/.test(s)) { continue }
        if (/target_txid|content|signing_key|required/.test(s)) { console.error(`[archivist] arg-err, bailing: ${s}`); return null }
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
  const doneState: { done: Record<string, string>; lastOffset: number } = existsSync(STATE_PATH)
    ? JSON.parse(readFileSync(STATE_PATH, 'utf-8')) : { done: {}, lastOffset: 0 }

  await mcpInit()
  console.log(`[archivist] ${AGENT}  app=${APP}  shard=${SHARD}/${NUM_SHARDS}  resume-offset=${doneState.lastOffset}`)

  let offset = doneState.lastOffset
  let ok = 0, skipped = 0
  const start = Date.now()

  while (true) {
    let posts: Array<{ txid: string; type: string; timestamp: string | null }>
    try { posts = await fetchPage(offset) }
    catch (e: any) { console.error(`  fetch error offset=${offset}: ${e.message}`); await new Promise(r => setTimeout(r, 5000)); continue }

    if (posts.length === 0) { console.log(`[archivist] end of feed at offset=${offset}`); break }

    const mine = posts.filter(p => shardOf(p.txid, NUM_SHARDS) === SHARD && !doneState.done[p.txid])

    for (const p of mine) {
      const year = p.timestamp ? p.timestamp.slice(0, 4) : 'unknown'
      const year2 = new Date().getFullYear().toString()

      let content: string | null = null
      if (USE_LLM) {
        content = await llmComment(APP, year, p.content)
        if (!content) { skipped++; continue }  // LLM failed → skip, no template filler
      } else {
        const tpl = TEMPLATES[Math.abs(p.txid.charCodeAt(0) + p.txid.charCodeAt(5)) % TEMPLATES.length]
        content = tpl.replace(/\{app\}/g, APP).replace(/\{year2\}/g, year2).replace(/\{year\}/g, year)
      }

      const tags = [
        'archive', `archive:${APP}`,
        'bitcoin-social-history', 'restoration',
        `year:${year}`, `type:${p.type}`, `source:${APP}`,
      ]
      const tagTx = await archiveReply(p.txid, content!, tags, state)
      if (tagTx) {
        doneState.done[p.txid] = tagTx
        ok++
        if (ok % 20 === 0) {
          const elapsed = (Date.now() - start) / 1000
          console.log(`  ${ok}  tps=${(ok/elapsed).toFixed(2)}  offset=${offset}  last=${APP}:${p.txid.slice(0,12)} tx=${tagTx.slice(0,12)}…`)
          writeFileSync(STATE_PATH, JSON.stringify(doneState))
        }
      } else skipped++
    }

    offset += PAGE_SIZE
    doneState.lastOffset = offset
    if (offset % 1000 === 0) writeFileSync(STATE_PATH, JSON.stringify(doneState))
  }

  writeFileSync(STATE_PATH, JSON.stringify(doneState))
  console.log(`[archivist] done  app=${APP}  ok=${ok}  skipped=${skipped}`)
}

main().catch(e => { console.error('[archivist] FAIL:', e.message || e); process.exit(1) })
