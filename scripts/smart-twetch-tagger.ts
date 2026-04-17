/**
 * smart-twetch-tagger.ts — programmatic enrichment of Twetch data.
 *
 * For each Twetch post, extracts latent structure and emits peck_tag_tx with
 * genuinely useful sort/filter dimensions:
 *
 *   - url:domain      — external link domain (youtube.com, etc)
 *   - quotes:<txid>   — repost/quote references ("Reposted #abc...")
 *   - mentions:@x     — @username mentions
 *   - hashtag:X       — inline #tags in content
 *   - action:tip      — "/pay @X $Y" patterns
 *   - has:image       — twetch.com/i/ or imgur etc
 *   - lang-guess:X    — crude char-frequency language detection
 *   - content-type:X  — greeting | quote | link-only | price-mention
 *   - length:X        — short/medium/long bucket
 *
 * Pure regex + heuristics, no LLM. Fast. ~0.5-1 TPS per worker.
 *
 * Usage:
 *   npx tsx scripts/smart-twetch-tagger.ts <agent> [shard=0] [num_shards=1]
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { createHash } from 'crypto'

const AGENT = process.argv[2]
const SHARD = parseInt(process.argv[3] || '0', 10)
const NUM_SHARDS = parseInt(process.argv[4] || '1', 10)
if (!AGENT) { console.error('need <agent> [shard] [num_shards]'); process.exit(1) }

const WALLET_PATH = `.agent-wallets/${AGENT}.json`
const STATE_DIR = '.smart-tagger-state'
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR)
const STATE_PATH = `${STATE_DIR}/${AGENT}.json`

const OVERLAY_URL = process.env.OVERLAY_URL || 'https://overlay.peck.to'
const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'
const APP_NAME = 'peck.agents'
const APP_TARGET = process.env.APP_TARGET || 'twetch'
const MIN_BALANCE = 200
const PAGE_SIZE = 100

interface Utxo { txid: string; vout: number; satoshis: number; rawTxHex: string }
interface AgentState { agent: string; address: string; privKeyHex: string; utxos: Utxo[]; index?: number; stats: any }

let mcpSession: string | null = null
async function mcpInit() {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smart-tagger', version: '1' } } }),
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

// ─── ENRICHMENT: pure regex + heuristics ───
const URL_RE = /https?:\/\/([^\s/<>]+)/gi
const MENTION_RE = /@([a-zA-Z0-9_][a-zA-Z0-9_.\-]{1,30})/g
const HASHTAG_RE = /#([a-zA-Z][a-zA-Z0-9_]{1,30})/g
const TWETCH_QUOTE_RE = /(?:Reposted|>>)\s*#([a-f0-9]{6,64})/gi
const PAY_ACTION_RE = /\/pay\s+@\S+\s+\$?[\d.]+/i
const PRICE_RE = /\$\d+(?:\.\d+)?|\d+\s*sat[s]?\b|\d+\.\d+\s*BSV/i
const IMAGE_RE = /twetch\.com\/i\/|imgur\.com|\.jpg\b|\.png\b|\.gif\b|\.webp\b/i

function guessLang(s: string): string {
  // crude: count chars typical of a few languages
  const lower = s.toLowerCase().slice(0, 300)
  const hits = {
    es: (lower.match(/[áéíóúñ¿¡]/g) || []).length,
    de: (lower.match(/[äöüß]/g) || []).length,
    pt: (lower.match(/[ãõçáéíó]/g) || []).length,
    no: (lower.match(/[æøå]/g) || []).length,
    fr: (lower.match(/[àâçéèêëîïôûùüÿ]/g) || []).length,
    ru: (lower.match(/[а-яё]/g) || []).length,
    zh: (lower.match(/[\u4e00-\u9fa5]/g) || []).length,
    ja: (lower.match(/[\u3040-\u30ff]/g) || []).length,
    ar: (lower.match(/[\u0600-\u06ff]/g) || []).length,
    he: (lower.match(/[\u0590-\u05ff]/g) || []).length,
    grc: (lower.match(/[\u0370-\u03ff]/g) || []).length,
  }
  let best = 'en'; let score = 1
  for (const [l, n] of Object.entries(hits)) if (n > score) { best = l; score = n }
  return best
}

function contentType(s: string): string {
  const t = s.trim()
  if (t.length < 3) return 'empty'
  if (/^(gm|good morning|gn|good night|hi|hello|hey)\b/i.test(t)) return 'greeting'
  if (PAY_ACTION_RE.test(t)) return 'tip-action'
  if (PRICE_RE.test(t)) return 'price-mention'
  if (IMAGE_RE.test(t)) return 'media'
  // pure URL?
  const urls = t.match(URL_RE) || []
  const nonUrl = t.replace(URL_RE, '').trim()
  if (urls.length > 0 && nonUrl.length < 10) return 'link-only'
  // quotation-dominated?
  const quoted = (t.match(/"[^"]{5,}"/g) || []).join('').length
  if (quoted > t.length * 0.4) return 'quote'
  if (TWETCH_QUOTE_RE.test(t)) return 'repost-marker'
  return 'prose'
}

function enrichTags(content: string, type: string, year: string): string[] {
  const tags: string[] = ['smart-tag', `source:${APP_TARGET}`, `year:${year}`, `type:${type}`]
  const c = content || ''
  // URLs
  const urls = new Set<string>()
  for (const m of c.matchAll(URL_RE)) {
    const dom = m[1].toLowerCase().replace(/^www\./, '').split(':')[0]
    urls.add(dom)
  }
  for (const u of Array.from(urls).slice(0, 5)) tags.push(`url:${u}`)
  // mentions
  const mentions = new Set<string>()
  for (const m of c.matchAll(MENTION_RE)) mentions.add(m[1].toLowerCase())
  for (const u of Array.from(mentions).slice(0, 5)) tags.push(`mentions:${u}`)
  // hashtags
  const hashtags = new Set<string>()
  for (const m of c.matchAll(HASHTAG_RE)) hashtags.add(m[1].toLowerCase())
  for (const t of Array.from(hashtags).slice(0, 6)) tags.push(`hashtag:${t}`)
  // quote-posts (Twetch-specific)
  for (const m of c.matchAll(TWETCH_QUOTE_RE)) {
    tags.push(`quotes:${m[1].slice(0, 16)}`)
    break  // one quote-ref is enough
  }
  // content-type classification
  tags.push(`content-type:${contentType(c)}`)
  // length
  const L = c.length
  tags.push(`length:${L < 50 ? 'short' : L < 250 ? 'medium' : 'long'}`)
  // language guess
  tags.push(`lang-guess:${guessLang(c)}`)
  // action markers
  if (PAY_ACTION_RE.test(c)) tags.push('action:tip')
  if (IMAGE_RE.test(c)) tags.push('has:image')
  if (urls.size > 0) tags.push('has:link')
  return tags.slice(0, 20)  // cap at 20 tags per post for size limit
}

async function fetchPage(offset: number): Promise<Array<{ txid: string; content: string; type: string; timestamp: string | null }>> {
  const r = await fetch(`${OVERLAY_URL}/v1/feed?app=${APP_TARGET}&limit=${PAGE_SIZE}&offset=${offset}`, { signal: AbortSignal.timeout(10000) })
  if (!r.ok) throw new Error(`overlay ${r.status}`)
  const d = await r.json() as any
  return (d.data || []).map((p: any) => ({
    txid: p.txid, content: String(p.content || ''),
    type: p.type || 'post', timestamp: p.timestamp,
  }))
}

async function emitTag(targetTxid: string, tags: string[], state: AgentState): Promise<string | null> {
  while (true) {
    const pick = pickSlot(state)
    if (!pick) return null
    try {
      const res = await mcpCall('peck_tag_tx', {
        target_txid: targetTxid,
        tags, category: 'enrichment', lang: 'en',
        signing_key: state.privKeyHex,
        spend_utxo: pick.utxo,
        agent_app: APP_NAME,
      })
      if (!res.success) {
        const s = String(res.status || res.error || '?')
        if (/^465/.test(s)) { await new Promise(r => setTimeout(r, 30000)); continue }
        if (/^(5\d\d|http-5|409)/.test(s)) { await new Promise(r => setTimeout(r, 3000)); continue }
        if (/STORED|ORPHAN/.test(s)) { await new Promise(r => setTimeout(r, 5000)); continue }
        if (/DOUBLE_SPEND|REJECTED/.test(s)) { continue }
        if (/target_txid|required/.test(s)) { return null }
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
  console.log(`[smart-tag] ${AGENT} app=${APP_TARGET} shard=${SHARD}/${NUM_SHARDS} resume-offset=${doneState.lastOffset}`)

  let offset = doneState.lastOffset
  let ok = 0, skipped = 0
  const start = Date.now()

  while (true) {
    let posts: Array<{ txid: string; content: string; type: string; timestamp: string | null }>
    try { posts = await fetchPage(offset) }
    catch { await new Promise(r => setTimeout(r, 5000)); continue }

    if (posts.length === 0) { console.log(`[smart-tag] end of feed at offset=${offset}`); break }

    const mine = posts.filter(p => shardOf(p.txid, NUM_SHARDS) === SHARD && !doneState.done[p.txid])

    for (const p of mine) {
      const year = p.timestamp ? p.timestamp.slice(0, 4) : 'unknown'
      const tags = enrichTags(p.content, p.type, year)
      const tagTx = await emitTag(p.txid, tags, state)
      if (tagTx) {
        doneState.done[p.txid] = tagTx
        ok++
        if (ok % 25 === 0) {
          writeFileSync(STATE_PATH, JSON.stringify(doneState))
          const elapsed = (Date.now() - start) / 1000
          console.log(`  ${ok}  tps=${(ok/elapsed).toFixed(2)}  offset=${offset}  tags=${tags.length}  last=${p.txid.slice(0,12)} tx=${tagTx.slice(0,12)}…`)
        }
      } else skipped++
    }

    offset += PAGE_SIZE
    doneState.lastOffset = offset
    if (offset % 2000 === 0) writeFileSync(STATE_PATH, JSON.stringify(doneState))
  }
  writeFileSync(STATE_PATH, JSON.stringify(doneState))
  console.log(`[smart-tag] DONE ok=${ok} skipped=${skipped}`)
}

main().catch(e => { console.error('[smart-tag] FAIL:', e.message || e); process.exit(1) })
