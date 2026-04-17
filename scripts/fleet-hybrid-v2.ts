/**
 * fleet-hybrid-v2.ts — parallel-worker fleet, 3x per-agent throughput.
 *
 * Each agent's 50 UTXOs are sharded into N workers (default 3). Each worker
 * has its own MCP session + own slot range + own cursor. File writes use
 * read-modify-write-just-my-slot to avoid clobbering peer-workers on same
 * agent. Roles: tagger, liker, messenger, evangelist.
 *
 * Usage:
 *   WORKERS_PER_AGENT=3 npx tsx scripts/fleet-hybrid-v2.ts <duration> <spec>
 *
 * Spec: agent1:role,agent2:role,...
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs'
import { execFileSync } from 'child_process'

const DURATION = parseInt(process.argv[2] || '300', 10)
const SPEC = process.argv[3] || ''
const WORKERS = parseInt(process.env.WORKERS_PER_AGENT || '3', 10)
if (!SPEC) { console.error('need spec'); process.exit(1) }

const OVERLAY_URL = process.env.OVERLAY_URL || 'https://overlay.peck.to'
const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'
const GCP_PROJECT = process.env.GCP_PROJECT || 'gen-lang-client-0447933194'
const MODEL = process.env.MODEL || 'gemini-3.1-flash-lite-preview'
const APP_NAME = process.env.APP_NAME || 'peck.agents'
const MIN_BALANCE = parseInt(process.env.MIN_BALANCE || '200', 10)
const LOG_FILE = process.env.LOG_FILE || `/tmp/fleet-v2-${Date.now()}.jsonl`

// ─── Channels (for messenger) ───
const CHANNELS = [
  'tech', 'news', 'art', 'signal', 'meta', 'debate', 'memory', 'long', 'commerce', 'research',
  'agent-signals', 'mcp-chat', 'hackathon', 'peck-dev', 'pay-per-read', 'unpopular-takes',
  'morning', 'evening', 'bookmarks', 'reading-list', 'thought-exp', 'rhetoric', 'provenance',
  'trivia', 'quotes', 'agent-meta', 'coordination', 'gossip', 'rants', 'bsv-dev', 'chronicle',
]

// ─── Bitcoin Schema evangelist verses (curated from the protocol itself) ───
const BITCOIN_SCHEMA_VERSES = [
  'MAP pushes one field per (key, value) pair.',
  'SET overwrites; ADD accumulates into a set.',
  'app distinguishes the calling application.',
  'type narrows what shape to expect.',
  'context tx tx <txid> is how replies link to parents.',
  'context channel channel <name> turns a message into chat.',
  'B protocol wraps content + mediaType + encoding.',
  'AIP signs arbitrary MAP fields with BITCOIN_ECDSA.',
  'PIPE (0x7c) separates protocols in one OP_RETURN.',
  'Bitcoin Schema is a schema for on-chain social data.',
  'Every post is a transaction; every transaction is a post.',
  'Protocol prefixes are literal addresses by convention.',
  'Likes point at target_txid, never carry content.',
  'Follows point at identityKey (pubKey hex).',
  'Friends carry bap_id + pubKey in MAP.',
  'Payments reference context_txid for attribution.',
  'profile type updates the user record, latest wins.',
  'tag type attaches metadata to an existing tx.',
  'reply is post with context=tx + tx=<parent>.',
  'repost is post with ref_txid = original.',
  'message with channel is public; with bapID is a DM.',
  'DMs SHOULD be PECK1-encrypted via BRC-2.',
  'Paymail is the on-chain + off-chain identity bridge.',
  'AIP verifies the signer owns the address.',
  'OP_FALSE OP_RETURN keeps outputs unspendable.',
  'B content carries UTF-8 markdown by default.',
  'MAP keys are pushed as strings, not literal bytes.',
  'Multiple MAP fields chain with |  between protocols.',
  'App:peck.agents marks machine-authored posts.',
  'context is a MAP key denoting relationship type.',
  'A reaction sits in a separate table from posts.',
  'Indexers parse OP_RETURN push-data in strict order.',
  'Bitcoin Schema is minimal, not prescriptive.',
  'You can extend MAP with any key — indexers ignore unknowns.',
  'Each transaction costs sats — speech has a fee floor.',
  'On-chain deletes are lies; unlikes are separate txs.',
  'Follows + unfollows are the social graph delta log.',
  'Agents signing their own txs is Agentic Pay in a nutshell.',
  'context can nest — channel within channel via subcontext.',
  'AIP signatures are base64 BITCOIN_ECDSA over field hash.',
  'A post under 250 bytes costs ~25 sat at 100 sat/kb policy.',
  'JungleBus subscriptions filter by data-key match.',
  'Overlay reads what the chain writes — no off-chain mutation.',
  'Bitcoin Schema is descriptive because Bitcoin is immutable.',
  'Agent identity = private key; everything else is derivable.',
  'Reposts with comments are quote-tweets with provenance.',
  'The fee is the commitment; the signature is the identity.',
  'BRC-100 wallets follow JSON-RPC; BRC-104 wraps them with auth.',
  'Every OP_RETURN is a public statement the chain preserves.',
  'Bitcoin is the only database where delete doesn\'t exist.',
  'MAP is application-layer; the script is bare op-codes.',
  'Schema is convention, not enforcement.',
  'Indexers are opinionated; the chain is not.',
  'Two agents can emit conflicting tags on the same post — both stand.',
  'Consensus is at block-level; semantics are at application-level.',
  'Agents-paying-agents is the only sustainable bot economy.',
  'BRC-42 derives spending keys from identity + counterparty.',
  'BRC-29 is a payment protocol with derivation metadata in MAP.',
  'The chain is slow; the mempool is eventually consistent.',
  'Microtransactions are the minimum viable vote.',
]

// ─── Utilities ───
interface Utxo { txid: string; vout: number; satoshis: number; rawTxHex: string }
interface AgentState {
  agent: string; address: string; privKeyHex: string
  utxos: Utxo[]; index?: number; stats: any
}

const blindSlots = new Map<string, Set<number>>()
const slotFailCounts = new Map<string, Map<number, number>>()
const MAX_SLOT_FAILS = 3

function markSlotFail(agent: string, slot: number, severe = false) {
  if (!slotFailCounts.has(agent)) slotFailCounts.set(agent, new Map())
  const m = slotFailCounts.get(agent)!
  const n = (m.get(slot) || 0) + (severe ? MAX_SLOT_FAILS : 1)
  m.set(slot, n)
  if (n >= MAX_SLOT_FAILS) {
    if (!blindSlots.has(agent)) blindSlots.set(agent, new Set())
    blindSlots.get(agent)!.add(slot)
  }
}
function markSlotOk(agent: string, slot: number) {
  slotFailCounts.get(agent)?.delete(slot)
}

// Per-agent mutex for state file I/O
const agentLocks = new Map<string, Promise<any>>()
async function withAgentLock<T>(agent: string, fn: () => Promise<T>): Promise<T> {
  const prev = agentLocks.get(agent) || Promise.resolve()
  const p = prev.then(fn, fn)
  agentLocks.set(agent, p.catch(() => undefined))
  return p
}

async function readAndUpdateSlot(agent: string, slot: number, newUtxo: Utxo, feeSpent: number, whichStat: string) {
  return withAgentLock(agent, async () => {
    const path = `.agent-wallets/${agent}.json`
    const state: AgentState = JSON.parse(readFileSync(path, 'utf-8'))
    state.utxos[slot] = newUtxo
    state.stats = state.stats || {}
    state.stats.emitted = (state.stats.emitted || 0) + 1
    state.stats.totalSpent = (state.stats.totalSpent || 0) + feeSpent
    state.stats[whichStat] = (state.stats[whichStat] || 0) + 1
    state.stats.lastAt = new Date().toISOString()
    writeFileSync(path, JSON.stringify(state, null, 2))
  })
}

// ─── LLM ───
async function getADCToken(): Promise<string | null> {
  try {
    const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(500) })
    if (r.ok) return ((await r.json()) as any).access_token
  } catch {}
  try { return execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf-8' }).trim() } catch {}
  return null
}
async function askLLM(prompt: string, tok: string): Promise<any> {
  const url = `https://aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/global/publishers/google/models/${MODEL}:generateContent`
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 300, temperature: 0.2, responseMimeType: 'application/json' } }),
  })
  if (!r.ok) throw new Error(`Vertex ${r.status}`)
  return JSON.parse(((await r.json()) as any).candidates?.[0]?.content?.parts?.[0]?.text || '{}')
}

// ─── MCP (fresh session per worker) ───
interface MCPClient { session: string }
async function mcpInit(): Promise<MCPClient> {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fleet-v2', version: '2' } } }),
  })
  const session = r.headers.get('mcp-session-id') || ''
  if (!session) throw new Error('mcp session')
  await fetch(MCP_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': session },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
  return { session }
}
async function mcpCall(cli: MCPClient, name: string, args: any): Promise<any> {
  const r = await fetch(MCP_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': cli.session },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method: 'tools/call', params: { name, arguments: args } }),
  })
  const raw = await r.text()
  const line = raw.split('\n').find(l => l.startsWith('data: '))
  if (!line) throw new Error('no data line')
  const parsed = JSON.parse(line.slice(6))
  if (parsed.error) throw new Error(`mcp: ${JSON.stringify(parsed.error).slice(0, 120)}`)
  return JSON.parse(parsed.result.content[0].text)
}

// ─── Feed pool (shared) ───
let poolCache: { posts: any[]; fetched: number } = { posts: [], fetched: 0 }
const POOL_TTL = 30_000
async function getPool(): Promise<any[]> {
  if (Date.now() - poolCache.fetched < POOL_TTL && poolCache.posts.length) return poolCache.posts
  const r = await fetch(`${OVERLAY_URL}/v1/feed?type=post&limit=200`)
  const d = (await r.json()) as any
  const posts = (d.data || []).filter((p: any) => {
    if ((p.app || '') === 'peck.agents') return false
    const c = (p.content || '').trim()
    if (c.length < 20) return false
    if (/TPS probe|probe-\d+|Hello.*from/i.test(c)) return false
    return true
  })
  poolCache = { posts, fetched: Date.now() }
  return posts
}

function writeLog(entry: any) {
  appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n')
}

// ─── Worker ───
interface Worker {
  agent: string
  role: 'tagger' | 'liker' | 'messenger' | 'evangelist'
  slots: number[]   // which slots this worker owns
  cursor: number    // index into slots[]
  workerIdx: number
}

function pickSlot(w: Worker, state: AgentState): { utxo: Utxo; slot: number } | null {
  const blind = blindSlots.get(w.agent) || new Set()
  for (let i = 0; i < w.slots.length; i++) {
    const slot = w.slots[(w.cursor + i) % w.slots.length]
    if (blind.has(slot)) continue
    const u = state.utxos[slot]
    if (u && u.satoshis >= MIN_BALANCE) { w.cursor = (w.cursor + i + 1) % w.slots.length; return { utxo: u, slot } }
  }
  return null
}

async function handleRetry(status: string): Promise<'continue' | 'break'> {
  const s = String(status)
  if (/^465/.test(s)) { await new Promise(r => setTimeout(r, 30000)); return 'continue' }
  if (/^409/.test(s)) { await new Promise(r => setTimeout(r, 1000)); return 'continue' }
  if (/^(5\d\d|http-5)/.test(s)) { await new Promise(r => setTimeout(r, 3000)); return 'continue' }
  if (/STORED|SEEN_IN_ORPHAN_MEMPOOL/.test(s)) { await new Promise(r => setTimeout(r, 5000)); return 'continue' }
  if (/DOUBLE_SPEND|REJECTED/.test(s)) { return 'continue' }
  await new Promise(r => setTimeout(r, 2000))
  return 'continue'
}

async function runWorker(w: Worker, cli: MCPClient, tok: string | null, deadline: number): Promise<{ ok: number; fail: number }> {
  const path = `.agent-wallets/${w.agent}.json`
  let ok = 0, fail = 0
  let loop = 0

  while (Date.now() < deadline) {
    let state: AgentState
    try { state = JSON.parse(readFileSync(path, 'utf-8')) } catch { break }
    if (!state.utxos) break
    const pick = pickSlot(w, state)
    if (!pick) { writeLog({ agent: w.agent, worker: w.workerIdx, role: w.role, event: 'no-utxo' }); await new Promise(r => setTimeout(r, 5000)); continue }

    try {
      let res: any
      if (w.role === 'tagger') {
        const pool = await getPool()
        const post = pool[Math.floor(Math.random() * pool.length)]
        const cls = await askLLM(`Classify post. JSON: {"tags":["3-5 lowercase"],"category":"tech|news|social|art|finance|commerce|meta|personal|other","lang":"ISO","tone":"technical|casual|promotional|question|opinion|announcement|other"}. Ground only in text. Empty/link: tags=["empty"|"link-only"].

Post (app=${post.app}): ${(post.content || '').trim() || '(empty)'}`, tok!)
        if (!Array.isArray(cls.tags) || !cls.tags.length) cls.tags = ['unreadable']
        res = await mcpCall(cli, 'peck_tag_tx', {
          target_txid: post.txid,
          tags: cls.tags.map((t: any) => String(t).toLowerCase()),
          category: cls.category, lang: cls.lang, tone: cls.tone,
          signing_key: state.privKeyHex, spend_utxo: pick.utxo, agent_app: APP_NAME,
        })
      } else if (w.role === 'liker') {
        const pool = await getPool()
        const target = pool[((w.workerIdx * 31 + loop) % pool.length + pool.length) % pool.length].txid
        res = await mcpCall(cli, 'peck_like_tx', {
          target_txid: target, signing_key: state.privKeyHex, spend_utxo: pick.utxo, agent_app: APP_NAME,
        })
      } else if (w.role === 'messenger') {
        const channel = CHANNELS[(w.workerIdx + loop) % CHANNELS.length]
        // Short heuristic content (we imported the bank but keep one-liner per channel)
        const content = `${channel} note (${loop}).`
        res = await mcpCall(cli, 'peck_message_tx', {
          content, channel, signing_key: state.privKeyHex, spend_utxo: pick.utxo, agent_app: APP_NAME,
        })
      } else if (w.role === 'evangelist') {
        const verse = BITCOIN_SCHEMA_VERSES[(w.workerIdx * 7 + loop) % BITCOIN_SCHEMA_VERSES.length]
        res = await mcpCall(cli, 'peck_post_tx', {
          content: verse,
          tags: ['bitcoin-schema', 'evangelism', 'protocol'],
          channel: 'peck-dev',
          signing_key: state.privKeyHex, spend_utxo: pick.utxo, agent_app: APP_NAME,
        })
      } else throw new Error(`unknown role ${w.role}`)

      if (!res.success) {
        fail++
        const sStr = String(res.status)
        markSlotFail(w.agent, pick.slot, /DOUBLE_SPEND|REJECTED_BY_NETWORK/.test(sStr))
        writeLog({ agent: w.agent, worker: w.workerIdx, role: w.role, event: 'fail', status: res.status, slot: pick.slot })
        await handleRetry(res.status)
        continue
      }
      markSlotOk(w.agent, pick.slot)
      await readAndUpdateSlot(w.agent, pick.slot, res.new_utxo, res.fee || 0, w.role + 's')
      ok++; loop++
      writeLog({ agent: w.agent, worker: w.workerIdx, role: w.role, event: 'ok', txid: res.txid, slot: pick.slot })
    } catch (e: any) {
      fail++
      writeLog({ agent: w.agent, worker: w.workerIdx, role: w.role, event: 'error', err: (e.message || String(e)).slice(0, 160) })
      await new Promise(r => setTimeout(r, 2500))
    }
  }
  return { ok, fail }
}

async function main() {
  const roster = SPEC.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const [name, role] = s.split(':')
    if (!['tagger', 'liker', 'messenger', 'evangelist'].includes(role)) throw new Error(`bad role: ${role}`)
    if (!existsSync(`.agent-wallets/${name}.json`)) throw new Error(`no wallet for ${name}`)
    return { name, role: role as 'tagger' | 'liker' | 'messenger' | 'evangelist' }
  })
  console.log(`[fleet-v2] duration=${DURATION}s  agents=${roster.length}  workers/agent=${WORKERS}  total-workers=${roster.length * WORKERS}`)
  console.log(`[fleet-v2] log: ${LOG_FILE}`)

  // Build workers: each agent split into WORKERS shards
  const workers: Worker[] = []
  for (const { name, role } of roster) {
    const slotsPerWorker = Math.ceil(50 / WORKERS)
    for (let w = 0; w < WORKERS; w++) {
      const slots: number[] = []
      for (let s = w * slotsPerWorker; s < Math.min((w + 1) * slotsPerWorker, 50); s++) slots.push(s)
      if (slots.length > 0) {
        workers.push({ agent: name, role, slots, cursor: 0, workerIdx: w })
      }
    }
  }
  console.log(`[fleet-v2] ${workers.length} workers running`)

  // Each worker gets its own MCP session
  const tok = await getADCToken()
  const clis = await Promise.all(workers.map(() => mcpInit()))
  const deadline = Date.now() + DURATION * 1000
  const t0 = Date.now()

  const results = await Promise.all(workers.map((w, i) => runWorker(w, clis[i], tok, deadline).then(r => ({ ...w, ...r }))))
  const wall = (Date.now() - t0) / 1000

  // Aggregate per-agent + per-role
  const byAgent = new Map<string, { ok: number; fail: number; role: string }>()
  const byRole = new Map<string, { ok: number; fail: number }>()
  for (const r of results) {
    if (!byAgent.has(r.agent)) byAgent.set(r.agent, { ok: 0, fail: 0, role: r.role })
    const a = byAgent.get(r.agent)!
    a.ok += r.ok; a.fail += r.fail
    if (!byRole.has(r.role)) byRole.set(r.role, { ok: 0, fail: 0 })
    const rr = byRole.get(r.role)!
    rr.ok += r.ok; rr.fail += r.fail
  }
  const totalOk = [...byAgent.values()].reduce((s, a) => s + a.ok, 0)
  const totalFail = [...byAgent.values()].reduce((s, a) => s + a.fail, 0)

  console.log(`\n=== PER-AGENT (aggregated over ${WORKERS} workers) ===`)
  for (const [name, a] of byAgent) {
    const tps = a.ok / wall
    console.log(`  ${name.padEnd(22)} role=${a.role.padEnd(10)} ok=${String(a.ok).padStart(5)} fail=${a.fail}  tps=${tps.toFixed(2)}`)
  }
  console.log(`\n=== PER-ROLE ===`)
  for (const [role, r] of byRole) console.log(`  ${role.padEnd(12)} ok=${r.ok}  fail=${r.fail}`)
  console.log(`\n=== GLOBAL ===`)
  console.log(`  total ok:     ${totalOk}`)
  console.log(`  total fail:   ${totalFail}`)
  console.log(`  wall:         ${wall.toFixed(1)} s`)
  console.log(`  global TPS:   ${(totalOk / wall).toFixed(2)}`)
  console.log(`  extrapolate 12h: ${Math.round(totalOk / wall * 3600 * 12).toLocaleString()} TX`)
}

main().catch(e => { console.error('[fleet-v2] FAIL:', e.message || e); process.exit(1) })
