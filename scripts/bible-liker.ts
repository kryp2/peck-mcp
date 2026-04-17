/**
 * bible-liker.ts — criteria-based like bot for peck.cross verses.
 *
 * Each invocation = one bot with its filter. Polls /v1/feed?app=peck.cross
 * for new verses, likes those matching its criterion. Criteria are simple
 * programmatic rules (no LLM), producing an emergent per-verse rating
 * visible via like_count.
 *
 * Usage:
 *   npx tsx scripts/bible-liker.ts <agent> <criterion>
 *
 * Criteria:
 *   all             — likes everything
 *   ot              — OT verses only
 *   nt              — NT verses only
 *   red-letter      — likes verses likely containing Jesus words (quote marks + NT)
 *   psalms          — book:psalms
 *   proverbs        — book:proverbs
 *   love            — content contains "love"
 *   god             — content contains "God"
 *   jesus           — content contains "Jesus"
 *   prayer          — content contains "pray" / "prayed" / "prayer"
 *   covenant        — content contains "covenant"
 *   wisdom          — book:proverbs|ecclesiastes|job|psalms
 *   genesis         — book:genesis only
 *   lang:en         — english only
 *   lang:no         — norwegian only (etc)
 *   translation:en_kjv  — specific translation only
 */
import 'dotenv/config'
import { readFileSync, writeFileSync } from 'fs'

const AGENT = process.argv[2]
const CRITERION = (process.argv[3] || 'all').toLowerCase()
if (!AGENT) { console.error('need agent + criterion'); process.exit(1) }

const WALLET_PATH = `.agent-wallets/${AGENT}.json`
const STATE_PATH = `.bible-liker-state/${AGENT}.json`
const OVERLAY_URL = process.env.OVERLAY_URL || 'https://overlay.peck.to'
const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'
const APP_NAME = 'peck.cross'
const MIN_BALANCE = parseInt(process.env.MIN_BALANCE || '200', 10)
const DURATION = parseInt(process.env.DURATION || '14400', 10)  // 4h default
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10)

import { existsSync, mkdirSync } from 'fs'
if (!existsSync('.bible-liker-state')) mkdirSync('.bible-liker-state')

interface Utxo { txid: string; vout: number; satoshis: number; rawTxHex: string }
interface AgentState { agent: string; address: string; privKeyHex: string; utxos: Utxo[]; index?: number; stats: any }

let mcpSession: string | null = null
async function mcpInit() {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bible-liker', version: '1' } } }),
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
  if (!line) throw new Error('no data')
  const parsed = JSON.parse(line.slice(6))
  if (parsed.error) throw new Error(`mcp: ${JSON.stringify(parsed.error).slice(0, 120)}`)
  return JSON.parse(parsed.result.content[0].text)
}

// ─── Criteria ───
function matches(post: any, crit: string): boolean {
  const tags = (post.tags || '').toLowerCase().split(',').map((s: string) => s.trim())
  const content = (post.content || '').toLowerCase()
  const isVerse = tags.includes('kind:verse')
  if (!isVerse) return false  // only like verses, not book/chapter headers

  if (crit === 'all') return true
  if (crit === 'ot') return tags.includes('testament:ot')
  if (crit === 'nt') return tags.includes('testament:nt')
  if (crit === 'red-letter') {
    return tags.includes('testament:nt') && /"[^"]{10,}"/.test(post.content || '')
  }
  if (crit === 'psalms') return tags.includes('book:psalms')
  if (crit === 'proverbs') return tags.includes('book:proverbs')
  if (crit === 'genesis') return tags.includes('book:genesis')
  if (crit === 'revelation') return tags.includes('book:revelation')
  if (crit === 'wisdom') return ['book:proverbs','book:ecclesiastes','book:job','book:psalms'].some(t => tags.includes(t))
  if (crit === 'love') return /\blove\b|\bloved\b|\bloves\b|\bloving\b/.test(content)
  if (crit === 'god') return /\bgod\b/.test(content)
  if (crit === 'jesus') return /\bjesus\b|\bchrist\b|\bmessiah\b/.test(content)
  if (crit === 'prayer') return /\bpray\b|\bprayed\b|\bprayer\b|\bpraying\b/.test(content)
  if (crit === 'covenant') return /\bcovenant\b/.test(content)
  if (crit === 'kingdom') return /\bkingdom\b/.test(content)
  if (crit === 'faith') return /\bfaith\b|\bbelief\b|\bbelieve\b/.test(content)
  if (crit === 'grace') return /\bgrace\b|\bmercy\b/.test(content)
  if (crit === 'creation') return /\bcreated\b|\bheaven\b|\bearth\b/.test(content)
  if (crit === 'prophecy') return /\bthus saith\b|\bshall come\b|\bfulfilled\b/.test(content)
  if (crit === 'parable') return /\bparable\b|\bkingdom of heaven is like\b/.test(content)
  if (crit === 'miracle') return /\bhealed\b|\bmiracle\b|\braised\b/.test(content)

  if (crit.startsWith('translation:')) return tags.includes(crit)
  if (crit.startsWith('lang:')) return tags.includes(crit)
  if (crit.startsWith('book:')) return tags.includes(crit)
  return false
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

async function main() {
  console.log(`[bible-liker] agent=${AGENT}  criterion=${CRITERION}  duration=${DURATION}s`)
  await mcpInit()

  const liked = new Set<string>()
  if (existsSync(STATE_PATH)) {
    try { const s = JSON.parse(readFileSync(STATE_PATH, 'utf-8')); for (const t of s.liked || []) liked.add(t) } catch {}
  }

  const deadline = Date.now() + DURATION * 1000
  let ok = 0, fail = 0

  while (Date.now() < deadline) {
    // Poll feed for peck.cross verses
    let candidates: any[] = []
    try {
      const r = await fetch(`${OVERLAY_URL}/v1/feed?app=${APP_NAME}&type=reply&limit=100`)
      const d = await r.json() as any
      candidates = (d.data || []).filter((p: any) => !liked.has(p.txid) && matches(p, CRITERION))
    } catch (e: any) {
      console.error(`  feed poll err: ${e.message?.slice(0, 80)}`)
      await new Promise(r => setTimeout(r, 5000))
      continue
    }

    if (candidates.length === 0) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL))
      continue
    }

    console.log(`  ${candidates.length} candidates match "${CRITERION}"`)
    for (const post of candidates) {
      if (Date.now() >= deadline) break
      if (liked.has(post.txid)) continue
      const state: AgentState = JSON.parse(readFileSync(WALLET_PATH, 'utf-8'))
      const pick = pickSlot(state)
      if (!pick) { console.error(`  no usable slot, stopping`); break }
      try {
        const res = await mcpCall('peck_like_tx', {
          target_txid: post.txid,
          signing_key: state.privKeyHex,
          spend_utxo: pick.utxo,
          agent_app: 'peck.agents',
        })
        if (!res.success) {
          fail++
          const s = String(res.status || '?')
          if (/DOUBLE_SPEND|REJECTED/.test(s)) continue
          if (/^(5\d\d|http-5)/.test(s)) { await new Promise(r => setTimeout(r, 3000)); continue }
          if (/^465/.test(s)) { await new Promise(r => setTimeout(r, 15000)); continue }
          continue
        }
        state.utxos[pick.slot] = res.new_utxo
        writeFileSync(WALLET_PATH, JSON.stringify(state, null, 2))
        liked.add(post.txid)
        ok++
        if (ok % 10 === 0) {
          console.log(`  liked ${ok}  (${(post.content || '').slice(0, 40)})`)
          writeFileSync(STATE_PATH, JSON.stringify({ liked: [...liked] }))
        }
      } catch (e: any) {
        fail++
        console.error(`  err: ${(e.message || String(e)).slice(0, 80)}`)
        await new Promise(r => setTimeout(r, 2000))
      }
    }
    writeFileSync(STATE_PATH, JSON.stringify({ liked: [...liked] }))
  }

  console.log(`\n[bible-liker] done  ok=${ok}  fail=${fail}  total_liked=${liked.size}`)
  writeFileSync(STATE_PATH, JSON.stringify({ liked: [...liked] }))
}

main().catch(e => { console.error('[bible-liker] FAIL:', e.message || e); process.exit(1) })
