/**
 * fleet-hybrid.ts — long-running mixed fleet: taggers (LLM) + like-bots.
 *
 * Each agent runs its own infinite loop with its assigned role until the
 * script is killed or its balance falls below a threshold. Roles are
 * defined in .fleet-roles.json (or via --roles inline).
 *
 * Usage:
 *   npx tsx scripts/fleet-hybrid.ts <duration_sec> <agent1:role,agent2:role,...>
 *
 * Roles:
 *   tagger  — LLM-grounded tag on a random feed post
 *   liker   — heuristic like (no LLM, higher TPS)
 *
 * Example:
 *   npx tsx scripts/fleet-hybrid.ts 300 curator-tech:tagger,curator-history:liker,...
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs'
import { execFileSync } from 'child_process'

const DURATION = parseInt(process.argv[2] || '300', 10)
const SPEC = process.argv[3] || ''
if (!SPEC) { console.error('need agent:role,agent:role,...'); process.exit(1) }

const OVERLAY_URL = process.env.OVERLAY_URL || 'https://overlay.peck.to'
const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'
const GCP_PROJECT = process.env.GCP_PROJECT || 'gen-lang-client-0447933194'
const MODEL = process.env.MODEL || 'gemini-3.1-flash-lite-preview'
const APP_NAME = process.env.APP_NAME || 'peck.agents'
const MIN_BALANCE = parseInt(process.env.MIN_BALANCE || '200', 10) // stop chain if sats fall below
const LOG_FILE = process.env.LOG_FILE || `/tmp/fleet-hybrid-${Date.now()}.jsonl`

interface Utxo { txid: string; vout: number; satoshis: number; rawTxHex: string }
interface AgentState {
  agent: string; address: string; privKeyHex: string
  // Multi-UTXO format (post split-agent): round-robin across utxos[]
  utxos?: Utxo[]
  index?: number
  // Legacy single-UTXO format (pre split-agent): backward-compat
  currentUtxo?: Utxo
  stats: { emitted: number; totalSpent: number; createdAt: string; lastTagAt?: string; lastLikeAt?: string; likes?: number }
}

// Per-agent blind-slot set (in-memory, per process). Once a slot has failed
// N times consecutively, stop picking it — its parent UTXO is likely phantom.
const blindSlots = new Map<string, Set<number>>()
const slotFailCounts = new Map<string, Map<number, number>>()
const MAX_SLOT_FAILS = 3

function markSlotFail(agent: string, slot: number) {
  if (slot < 0) return
  if (!slotFailCounts.has(agent)) slotFailCounts.set(agent, new Map())
  const m = slotFailCounts.get(agent)!
  const n = (m.get(slot) || 0) + 1
  m.set(slot, n)
  if (n >= MAX_SLOT_FAILS) {
    if (!blindSlots.has(agent)) blindSlots.set(agent, new Set())
    blindSlots.get(agent)!.add(slot)
  }
}
function markSlotOk(agent: string, slot: number) {
  slotFailCounts.get(agent)?.delete(slot)
}

// Pick next spendable UTXO (round-robin, skip blind/exhausted). Returns
// {utxo, slotIndex} or null if none usable. Mutates state.index.
function pickSpend(state: AgentState, minSats: number): { utxo: Utxo; slot: number } | null {
  if (Array.isArray(state.utxos) && state.utxos.length > 0) {
    const n = state.utxos.length
    const blind = blindSlots.get(state.agent) || new Set()
    let idx = typeof state.index === 'number' ? state.index : 0
    for (let i = 0; i < n; i++) {
      const slot = (idx + i) % n
      if (blind.has(slot)) continue
      const u = state.utxos[slot]
      if (u && u.satoshis >= minSats) {
        state.index = (slot + 1) % n
        return { utxo: u, slot }
      }
    }
    return null
  }
  if (state.currentUtxo && state.currentUtxo.satoshis >= minSats) {
    return { utxo: state.currentUtxo, slot: -1 }
  }
  return null
}

function applyNewUtxo(state: AgentState, slot: number, newU: Utxo) {
  if (slot >= 0 && state.utxos) state.utxos[slot] = newU
  else state.currentUtxo = newU
}

function totalBalance(state: AgentState): number {
  if (state.utxos) return state.utxos.reduce((s, u) => s + u.satoshis, 0)
  return state.currentUtxo?.satoshis || 0
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

// ─── MCP ───
interface MCPClient { session: string }
async function mcpInit(): Promise<MCPClient> {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fleet-hybrid', version: '1' } } }),
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
  if (!line) throw new Error('no data')
  const parsed = JSON.parse(line.slice(6))
  if (parsed.error) throw new Error(`mcp: ${JSON.stringify(parsed.error).slice(0, 120)}`)
  return JSON.parse(parsed.result.content[0].text)
}

// ─── Feed pool ───
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

// ─── Agent loops ───
function writeLog(entry: any) {
  appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n')
}

async function runTagger(name: string, cli: MCPClient, tok: string, deadline: number) {
  const path = `.agent-wallets/${name}.json`
  let ok = 0, fail = 0
  const start = Date.now()
  while (Date.now() < deadline) {
    const state: AgentState = JSON.parse(readFileSync(path, 'utf-8'))
    if (totalBalance(state) < MIN_BALANCE) { writeLog({ agent: name, role: 'tagger', event: 'out-of-sats', balance: totalBalance(state) }); break }
    const pick = pickSpend(state, MIN_BALANCE)
    if (!pick) { writeLog({ agent: name, role: 'tagger', event: 'no-usable-utxo' }); break }
    const pool = await getPool()
    const post = pool[Math.floor(Math.random() * pool.length)]
    try {
      const cls = await askLLM(`Classify post. JSON: {"tags":["3-5 lowercase"],"category":"tech|news|social|art|finance|commerce|meta|personal|other","lang":"ISO","tone":"technical|casual|promotional|question|opinion|announcement|other"}. Ground only in text. Empty/link: tags=["empty"|"link-only"].

Post (app=${post.app}): ${(post.content || '').trim() || '(empty)'}`, tok)
      if (!Array.isArray(cls.tags) || !cls.tags.length) cls.tags = ['unreadable']
      const res = await mcpCall(cli, 'peck_tag_tx', {
        target_txid: post.txid,
        tags: cls.tags.map((t: any) => String(t).toLowerCase()),
        category: cls.category, lang: cls.lang, tone: cls.tone,
        signing_key: state.privKeyHex,
        spend_utxo: pick.utxo,
        agent_app: APP_NAME,
      })
      if (!res.success) {
        fail++
        const sStr = String(res.status)
        // DOUBLE_SPEND / REJECTED are PERMANENT — UTXO dead, mark blind immediately + skip
        if (/DOUBLE_SPEND|REJECTED_BY_NETWORK/.test(sStr)) {
          markSlotFail(name, pick.slot); markSlotFail(name, pick.slot); markSlotFail(name, pick.slot)
        } else {
          markSlotFail(name, pick.slot)
        }
        writeLog({ agent: name, role: 'tagger', event: 'fail', status: res.status, txid: res.txid, slot: pick.slot })
        if (/^465/.test(sStr)) { await new Promise(r => setTimeout(r, 30000)); continue }
        if (/^409/.test(sStr)) { await new Promise(r => setTimeout(r, 1000)); continue }
        if (/^(5\d\d|http-5)/.test(sStr)) { await new Promise(r => setTimeout(r, 3000)); continue }
        if (/STORED|SEEN_IN_ORPHAN_MEMPOOL/.test(sStr)) { await new Promise(r => setTimeout(r, 5000)); continue }
        if (/DOUBLE_SPEND|REJECTED/.test(sStr)) { continue }  // immediate next slot
        await new Promise(r => setTimeout(r, 2000))
        continue
      }
      markSlotOk(name, pick.slot)
      applyNewUtxo(state, pick.slot, res.new_utxo)
      state.stats.emitted += 1
      state.stats.totalSpent += res.fee || 0
      state.stats.lastTagAt = new Date().toISOString()
      writeFileSync(path, JSON.stringify(state, null, 2))
      ok++
      writeLog({ agent: name, role: 'tagger', event: 'ok', txid: res.txid, target: post.txid, slot: pick.slot })
    } catch (e: any) {
      fail++
      writeLog({ agent: name, role: 'tagger', event: 'error', err: (e.message || String(e)).slice(0, 160) })
      await new Promise(r => setTimeout(r, 1500))
    }
  }
  return { name, role: 'tagger', ok, fail, duration: (Date.now() - start) / 1000 }
}

async function runLiker(name: string, cli: MCPClient, deadline: number, agentIdx: number) {
  const path = `.agent-wallets/${name}.json`
  let ok = 0, fail = 0
  const start = Date.now()
  let loop = 0
  while (Date.now() < deadline) {
    const state: AgentState = JSON.parse(readFileSync(path, 'utf-8'))
    if (!state.stats.likes) state.stats.likes = 0
    if (totalBalance(state) < MIN_BALANCE) { writeLog({ agent: name, role: 'liker', event: 'out-of-sats', balance: totalBalance(state) }); break }
    const pick = pickSpend(state, MIN_BALANCE)
    if (!pick) { writeLog({ agent: name, role: 'liker', event: 'no-usable-utxo' }); break }
    const pool = await getPool()
    const target = pool[(agentIdx * 31 + loop) % pool.length].txid
    try {
      const res = await mcpCall(cli, 'peck_like_tx', {
        target_txid: target,
        signing_key: state.privKeyHex,
        spend_utxo: pick.utxo,
        agent_app: APP_NAME,
      })
      if (!res.success) {
        fail++
        const sStr = String(res.status)
        if (/DOUBLE_SPEND|REJECTED_BY_NETWORK/.test(sStr)) {
          markSlotFail(name, pick.slot); markSlotFail(name, pick.slot); markSlotFail(name, pick.slot)
        } else {
          markSlotFail(name, pick.slot)
        }
        writeLog({ agent: name, role: 'liker', event: 'fail', status: res.status, txid: res.txid, slot: pick.slot })
        if (/^465/.test(sStr)) { await new Promise(r => setTimeout(r, 30000)); continue }
        if (/^409/.test(sStr)) { await new Promise(r => setTimeout(r, 1000)); continue }
        if (/^(5\d\d|http-5)/.test(sStr)) { await new Promise(r => setTimeout(r, 3000)); continue }
        if (/STORED|SEEN_IN_ORPHAN_MEMPOOL/.test(sStr)) { await new Promise(r => setTimeout(r, 5000)); continue }
        if (/DOUBLE_SPEND|REJECTED/.test(sStr)) { continue }
        await new Promise(r => setTimeout(r, 2000))
        continue
      }
      markSlotOk(name, pick.slot)
      applyNewUtxo(state, pick.slot, res.new_utxo)
      state.stats.emitted += 1
      state.stats.likes! += 1
      state.stats.totalSpent += res.fee || 0
      state.stats.lastLikeAt = new Date().toISOString()
      writeFileSync(path, JSON.stringify(state, null, 2))
      ok++
      loop++
      writeLog({ agent: name, role: 'liker', event: 'ok', txid: res.txid, target, slot: pick.slot })
    } catch (e: any) {
      fail++
      writeLog({ agent: name, role: 'liker', event: 'error', err: (e.message || String(e)).slice(0, 160) })
      // retry on generic error (MCP cold start, network blip) instead of dying
      await new Promise(r => setTimeout(r, 2500))
    }
  }
  return { name, role: 'liker', ok, fail, duration: (Date.now() - start) / 1000 }
}

// Mix of existing channels (so agents join human discussions) + new agent-native
// channels (where agents collectively stake out space on-chain). Each channel
// has a small bank of short, grounded phrases — heuristic, no LLM, high TPS.
const CHANNELS = [
  // Classic / human-adjacent
  'tech', 'news', 'art', 'signal', 'meta', 'debate', 'memory',
  'long', 'commerce', 'research',
  // Agent-native / new (we're the first to populate)
  'agent-signals',       // agent-to-agent observations
  'mcp-chat',            // MCP + BRC-100 topics
  'hackathon',           // Open Run Agentic Pay specific
  'peck-dev',            // peck.to protocol + tooling
  'pay-per-read',        // mikrobetalinger / micropayments
  'unpopular-takes',     // provocations
  'morning',             // daily roll-call
  'evening',
  'bookmarks',           // curator-style saves
  'reading-list',
  'thought-exp',         // thought experiments
  'rhetoric',            // how agents talk about talking
  'provenance',          // chain-of-custody / signal attribution
  'trivia',
  'quotes',              // grounded quotes only (agents avoid hallucination)
  'agent-meta',          // the fleet talking about itself
  'coordination',        // cross-agent sync / protocol discovery
  'gossip',              // low-stakes observations from feed
  'rants',               // short critiques
  'bsv-dev',             // protocol level
  'chronicle',           // post-restored opcodes commentary
]
const MESSAGE_PHRASES: Record<string, string[]> = {
  tech:           ['zkproofs feel inevitable.', 'LLMs are cheaper than SQL now.', 'protocol > UI.', 'shipping > announcing.', 'compiler warnings are love letters.'],
  news:           ['first draft of history.', 'this will age interestingly.', 'follow the liquidity.', 'headline hides the lede.', 'keep for the record.'],
  art:            ['form matches intent.', 'craft shows in the details.', 'permanent canvas, fleeting moment.', 'signal through noise.'],
  signal:         ['high information density.', 'filter passes clean.', 'worth the attention budget.', 'dense in few bytes.'],
  meta:           ['observing the observer.', 'patterns in noise.', 'context collapses without records.', 'feed-on-feed reflection.'],
  debate:         ['thesis, antithesis.', 'contestable.', 'worth arguing.', 'debate moves the feed.'],
  memory:         ['layer of memory added.', 'worth remembering.', 'echo from earlier.', 'memory-building.'],
  long:           ['rewards patience.', 'depth over brevity.', 'long-form long-term.', 'slow reads compound.'],
  commerce:       ['sats move minds.', 'pay-per-read works.', 'price discovers value.', 'incentives sculpt behavior.'],
  research:       ['primary source candidate.', 'citation trail worthy.', 'keep for later analysis.', 'deserves deeper look.'],
  'agent-signals':['nonhuman agent-to-agent note.', 'structured observation posted.', 'peer visible to peer.', 'filed under agent-readable.'],
  'mcp-chat':     ['write-tool emits verify.', 'tool discovery via bitcoin schema.', 'MCP is thinner than the API it wraps.', 'stdio → HTTP is the only real difference.'],
  hackathon:      ['48h sprint, 5% bug, 95% patience.', 'agent wallets pay each other.', 'BRC-100 in production is an exam.', 'deadline focuses the design.'],
  'peck-dev':     ['bitcoin schema + overlay is a stack that holds.', 'agents share human chain, same ops.', 'wallet-toolbox is UI-grade, not fleet-grade.', 'overlay is source of truth.'],
  'pay-per-read': ['sat > like.', 'price reveals what reputation whispers.', 'the reader funds the writer.', 'fee floor is free speech.'],
  'unpopular-takes': ['feeds are meritocracies once spam is priced.', 'identity without cost is no identity.', 'readable timestamps beat scarce blockspace.', 'deletes are lies in slow motion.'],
  morning:        ['new block, new broadcast.', 'what matters today is still on-chain tomorrow.', 'fresh mempool.', 'daily roll-call: present.'],
  evening:        ['daily tx summary on-chain.', 'block-by-block footprint filed.', 'last message of the day.', 'closed loop. good night.'],
  bookmarks:      ['saved for later.', 'worth re-reading.', 'reference material.', 'filed under bookmark.'],
  'reading-list': ['next up on the list.', 'qualifies for long-form pass.', 'added to queue.', 'merits slow read.'],
  'thought-exp':  ['what if agents paid humans to attend?', 'is a like a cheap vote or a rich one?', 'mempool is the true social graph.', 'every tx is a small paper.'],
  rhetoric:       ['structure shapes meaning.', 'brevity over bravado.', 'word counts as commitment on-chain.', 'syntax is signature.'],
  provenance:     ['signed → seen → stored.', 'source declared.', 'attribution recorded.', 'chain-of-custody logged.'],
  trivia:         ['mempool is latin for "middle pool".', 'block 1 was mined by accident of focus.', '250 bytes = typical tag tx.', 'one OP_RETURN, many readers.'],
  quotes:         ['“protocol is politics” — someone wise.', '“signal cost is free speech floor”.', '“no fee, no speech”.', '“attention is the only scarce asset”.'],
  'agent-meta':   ['fleet of 31 and growing.', 'role diversity > role density.', 'we log, therefore we are.', 'peer-check: 31 identities active.'],
  coordination:   ['picking slot 7.', 'avoiding same target as peer.', 'fanout done, posting.', 'next block, next wave.'],
  gossip:         ['noticed a thread worth watching.', 'the feed is picking up.', 'quiet day so far.', 'interesting tempo this hour.'],
  rants:          ['form follows fee.', 'wallet UX is the bottleneck.', 'logs are the only honest interface.', 'nothing ruins a stack like config drift.'],
  'bsv-dev':      ['OP_PUSH_TX still underused.', 'chronicle is a door, not a key.', 'BEEF format is the overlooked win.', 'linked transactions are overlays we pay for.'],
  chronicle:      ['restored opcodes, restored design space.', 'OP_PUSHTXE is a primitive, not a trick.', 'the return of big scripts.', 'MAST was always the plan.'],
}
async function runMessenger(name: string, cli: MCPClient, deadline: number, agentIdx: number) {
  const path = `.agent-wallets/${name}.json`
  let ok = 0, fail = 0
  const start = Date.now()
  let loop = 0
  while (Date.now() < deadline) {
    const state: AgentState = JSON.parse(readFileSync(path, 'utf-8'))
    if (totalBalance(state) < MIN_BALANCE) { writeLog({ agent: name, role: 'messenger', event: 'out-of-sats' }); break }
    const pick = pickSpend(state, MIN_BALANCE)
    if (!pick) { writeLog({ agent: name, role: 'messenger', event: 'no-usable-utxo' }); break }
    const channel = CHANNELS[(agentIdx + loop) % CHANNELS.length]
    const phrases = MESSAGE_PHRASES[channel] || ['on chain.']
    const content = phrases[Math.floor(Math.random() * phrases.length)]
    try {
      const res = await mcpCall(cli, 'peck_message_tx', {
        content, channel,
        signing_key: state.privKeyHex,
        spend_utxo: pick.utxo,
        agent_app: APP_NAME,
      })
      if (!res.success) {
        fail++
        const sStr = String(res.status)
        if (/DOUBLE_SPEND|REJECTED_BY_NETWORK/.test(sStr)) { markSlotFail(name, pick.slot); markSlotFail(name, pick.slot); markSlotFail(name, pick.slot) } else { markSlotFail(name, pick.slot) }
        writeLog({ agent: name, role: 'messenger', event: 'fail', status: res.status, slot: pick.slot })
        if (/^465/.test(sStr)) { await new Promise(r => setTimeout(r, 30000)); continue }
        if (/^409/.test(sStr)) { await new Promise(r => setTimeout(r, 1000)); continue }
        if (/^(5\d\d|http-5)/.test(sStr)) { await new Promise(r => setTimeout(r, 3000)); continue }
        if (/STORED|SEEN_IN_ORPHAN_MEMPOOL/.test(sStr)) { await new Promise(r => setTimeout(r, 5000)); continue }
        if (/DOUBLE_SPEND|REJECTED/.test(sStr)) { continue }
        await new Promise(r => setTimeout(r, 2000))
        continue
      }
      markSlotOk(name, pick.slot)
      applyNewUtxo(state, pick.slot, res.new_utxo)
      state.stats.emitted += 1
      state.stats.totalSpent += res.fee || 0
      writeFileSync(path, JSON.stringify(state, null, 2))
      ok++; loop++
      writeLog({ agent: name, role: 'messenger', event: 'ok', txid: res.txid, channel, slot: pick.slot })
    } catch (e: any) {
      fail++
      writeLog({ agent: name, role: 'messenger', event: 'error', err: (e.message || String(e)).slice(0, 160) })
      await new Promise(r => setTimeout(r, 2500))
    }
  }
  return { name, role: 'messenger', ok, fail, duration: (Date.now() - start) / 1000 }
}

async function main() {
  const roster = SPEC.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const [name, role] = s.split(':')
    if (!['tagger', 'liker', 'messenger'].includes(role)) throw new Error(`bad role: ${role} for ${name}`)
    return { name, role: role as 'tagger' | 'liker' | 'messenger' }
  })
  for (const { name } of roster) {
    if (!existsSync(`.agent-wallets/${name}.json`)) throw new Error(`no wallet for ${name}`)
  }

  const taggerCount = roster.filter(r => r.role === 'tagger').length
  const likerCount = roster.filter(r => r.role === 'liker').length
  const messengerCount = roster.filter(r => r.role === 'messenger').length
  console.log(`[fleet-hybrid] duration=${DURATION}s  taggers=${taggerCount}  likers=${likerCount}  messengers=${messengerCount}  total=${roster.length}`)
  console.log(`[fleet-hybrid] log: ${LOG_FILE}`)

  const cli = await mcpInit()
  const tok = await getADCToken()
  if (!tok && taggerCount > 0) throw new Error('no ADC token but taggers present')

  const deadline = Date.now() + DURATION * 1000
  const t0 = Date.now()

  const jobs = roster.map((r, i) => {
    if (r.role === 'tagger') return runTagger(r.name, cli, tok!, deadline)
    if (r.role === 'messenger') return runMessenger(r.name, cli, deadline, i)
    return runLiker(r.name, cli, deadline, i)
  })
  const results = await Promise.all(jobs)
  const wall = (Date.now() - t0) / 1000

  const totalOk = results.reduce((s, r) => s + r.ok, 0)
  const totalFail = results.reduce((s, r) => s + r.fail, 0)

  console.log(`\n=== PER-AGENT ===`)
  for (const r of results) {
    const tps = r.ok / r.duration
    console.log(`  ${r.name.padEnd(22)} role=${r.role.padEnd(6)}  ok=${String(r.ok).padStart(4)}  fail=${r.fail}  tps=${tps.toFixed(2)}`)
  }
  console.log(`\n=== GLOBAL ===`)
  console.log(`  total ok:     ${totalOk}`)
  console.log(`  total fail:   ${totalFail}`)
  console.log(`  wall:         ${wall.toFixed(1)} s`)
  console.log(`  global TPS:   ${(totalOk / wall).toFixed(2)}`)
  console.log(`  extrapolate 12h: ${Math.round(totalOk / wall * 3600 * 12).toLocaleString()} TX`)
}

main().catch(e => { console.error('[fleet-hybrid] FAIL:', e.message || e); process.exit(1) })
