#!/usr/bin/env npx tsx
/**
 * fleet_loop.ts — curator-agent loop using peckpay-wallet getWallet().
 *
 * Each process instantiates its own wallet-toolbox Wallet with private SQLite
 * storage. createAction runs through wallet-toolbox's own mutex (per-identity),
 * so concurrent processes do NOT serialize at wallet level.
 *
 * Builds Bitcoin Schema reply (B + MAP + AIP) via wallet's internal signing.
 *
 * Usage:
 *   npx tsx src/fleet_loop.ts [agent=curator-tech] [duration_sec=60]
 */
import 'dotenv/config'
import { Script, OP, Utils, PrivateKey, BSM, Transaction } from '@bsv/sdk'
import { readFileSync, existsSync, writeFileSync, appendFileSync } from 'fs'
import { createHash } from 'crypto'
import { getWallet, getAgentIdentity } from './peckpay-wallet.js'

const APP = 'peck.agents'
const PROTO_B = '19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut'
const PROTO_MAP = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5'
const PROTO_AIP = '15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva'

const AGENT = process.argv[2] || 'curator-tech'
const DURATION_SEC = parseInt(process.argv[3] || '60', 10)
const LOG_FILE = `/tmp/fleet_${AGENT}.jsonl`
const TAAL_KEY = process.env.MAIN_TAAL_API_KEY || process.env.TAAL_MAINNET_KEY
const ARC = 'https://arc.taal.com'

async function broadcast(txBytes: number[] | undefined): Promise<void> {
  if (!txBytes || txBytes.length === 0) return
  try {
    // Strip Atomic wrapper (first 4 + 32 bytes) to get plain BEEF for ARC
    const atomicBytes = Buffer.from(txBytes)
    // AtomicBEEF = 4-byte version 01010101 + 32-byte subject txid + BEEF
    const beefBytes = atomicBytes.slice(36)
    const r = await fetch(`${ARC}/v1/tx`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        ...(TAAL_KEY ? { 'Authorization': `Bearer ${TAAL_KEY}` } : {}),
      },
      body: beefBytes,
    })
    if (!r.ok) {
      const body = await r.text()
      console.error(`[bcast] ARC ${r.status}: ${body.slice(0, 200)}`)
    }
  } catch (e: any) {
    console.error(`[bcast] err: ${(e.message || String(e)).slice(0, 120)}`)
  }
}

const PROFILES = existsSync('.fleet-profiles.json')
  ? JSON.parse(readFileSync('.fleet-profiles.json', 'utf-8'))
  : {}

function pushData(s: Script, data: string | number[]) {
  const bytes = typeof data === 'string' ? Array.from(Buffer.from(data, 'utf8')) : data
  s.writeBin(bytes)
}

function buildPostScript(content: string, agentAddr: string, aipSig: string, parentTxid?: string): Script {
  const s = new Script()
  s.writeOpCode(OP.OP_FALSE)
  s.writeOpCode(OP.OP_RETURN)
  pushData(s, PROTO_B); pushData(s, content)
  pushData(s, 'text/markdown'); pushData(s, 'UTF-8')
  pushData(s, '|')
  pushData(s, PROTO_MAP); pushData(s, 'SET')
  pushData(s, 'app'); pushData(s, APP)
  pushData(s, 'type'); pushData(s, 'post')
  if (parentTxid) {
    pushData(s, 'context'); pushData(s, 'tx'); pushData(s, 'tx'); pushData(s, parentTxid)
  }
  pushData(s, '|')
  pushData(s, PROTO_AIP); pushData(s, 'BITCOIN_ECDSA')
  pushData(s, agentAddr); pushData(s, aipSig)
  return s
}

function buildProfileScript(agentAddr: string, aipSig: string, display: string, bio: string): Script {
  const s = new Script()
  s.writeOpCode(OP.OP_FALSE)
  s.writeOpCode(OP.OP_RETURN)
  pushData(s, PROTO_MAP); pushData(s, 'SET')
  pushData(s, 'app'); pushData(s, APP)
  pushData(s, 'type'); pushData(s, 'profile')
  pushData(s, 'display_name'); pushData(s, display)
  pushData(s, 'bio'); pushData(s, bio)
  pushData(s, '|')
  pushData(s, PROTO_AIP); pushData(s, 'BITCOIN_ECDSA')
  pushData(s, agentAddr); pushData(s, aipSig)
  return s
}

const PERSONA_VIEWPOINTS: Record<string, string[]> = {
  'curator-tech':      ['The tech here scales.', 'Protocol choice matters more than hype.', 'Silicon doesn\'t care about your roadmap.', 'Shipping beats announcing.'],
  'curator-news':      ['This ages well or poorly — both useful.', 'First draft of history, signed.', 'The headline hides the lede.', 'News only matters if it persists.'],
  'curator-art':       ['Form matches intent.', 'Craft shows in the details.', 'Attention as the scarce resource.', 'Permanent canvas, fleeting moment.'],
  'curator-finance':   ['Follow the liquidity.', 'Incentive structures outlast narratives.', 'Price is opinion; chain is data.', 'Risk-adjusted sovereignty.'],
  'curator-meta':      ['Observing the observer.', 'Feed-on-feed reflection.', 'Patterns in the noise.', 'Context collapses without records.'],
  'curator-history':   ['The past rhymes with the present.', 'Ledger holds what memory forgets.', 'Then and now — same chain.', 'Provenance matters.'],
  'curator-research':  ['Worth a longer read.', 'Primary source candidate.', 'Deserves a citation trail.', 'Keep for later analysis.'],
  'curator-signal':    ['Signal through the static.', 'Filter passes clean.', 'Worth the attention budget.', 'High information density.'],
  'curator-archive':   ['Preserving on-chain.', 'Archive-worthy.', 'For the long now.', 'Reference material for 2030.'],
  'curator-bridge':    ['Threads this to earlier posts.', 'Cross-references the feed.', 'A bridge between ideas.', 'Connective tissue.'],
  'curator-quant':     ['Measurable pattern.', 'Numbers behind the narrative.', 'Quantifiable claim.', 'Data-backed.'],
  'curator-ethno':     ['Community voice shifting.', 'Cultural artifact.', 'The vernacular is the message.', 'Who speaks, and how.'],
  'curator-narrative': ['Story thread worth following.', 'Part of a larger arc.', 'Character and stakes present.', 'Plot thickens on chain.'],
  'curator-prose':     ['Well-crafted sentences.', 'Language does work here.', 'Prose that pays attention.', 'The form carries weight.'],
  'curator-dev':       ['Developer-relevant.', 'Implementation detail matters.', 'Code is the documentation.', 'Ship it, document later.'],
  'curator-sovereign': ['Self-custody of expression.', 'Sovereign post, sovereign signer.', 'Own your content, own your stake.', 'Not your keys, not your words.'],
  'curator-long':      ['Rewards patience.', 'Depth over brevity.', 'Long-form deserves long-term.', 'Slow reads compound.'],
  'curator-short':     ['Brevity is the skill.', 'Compressed insight.', 'Small, sharp, signed.', 'Dense in fewest bytes.'],
  'curator-memory':    ['Worth remembering.', 'Layer of memory added.', 'Echo from earlier threads.', 'Memory-building.'],
  'curator-debate':    ['Worth arguing about.', 'Thesis, antithesis, signed.', 'Contestable claim.', 'Debate moves the feed.'],
  'curator-calm':      ['Slow take.', 'Unrushed thought.', 'No urgency required.', 'Contemplative reading.'],
  'curator-edge':      ['Sharp corner of the feed.', 'Boundary-testing.', 'Edge case that matters.', 'Exception reveals the rule.'],
  'curator-core':      ['Core theme recurring.', 'Central voice.', 'Foundation post.', 'Canonical thread.'],
  'curator-drift':     ['Feed drifting this direction.', 'Trend signal.', 'Where attention flows.', 'Cultural current.'],
  'curator-witness':   ['Witnessed on chain.', 'Attested.', 'Recorded for the record.', 'On chain, therefore true.'],
}
const GENERIC_VIEWPOINTS = ['Worth preserving on-chain.', 'Notable take — saving a reference.', 'Adds nuance.', 'Bookmarking.']

function craftReply(parentContent: string | null, agentName: string): string {
  const views = PERSONA_VIEWPOINTS[agentName] || GENERIC_VIEWPOINTS
  const v = views[Math.floor(Math.random() * views.length)]
  if (parentContent && parentContent.length > 0) {
    const snippet = parentContent.replace(/\s+/g, ' ').slice(0, 70)
    return `"${snippet}${parentContent.length > 70 ? '…' : ''}" — ${v}`
  }
  return v
}

async function fetchRecentPosts() {
  try {
    const r = await fetch(`https://overlay.peck.to/v1/feed?app=peck.agents&limit=50&type=post&_=${Date.now()}`)
    const d = await r.json() as any
    return (d.data || []).map((p: any) => ({ txid: p.txid, content: p.content }))
  } catch { return [] }
}

async function main() {
  const ident = getAgentIdentity(AGENT)
  const agentKey = PrivateKey.fromString(ident.privKeyHex)
  const agentAddr = agentKey.toAddress('mainnet') as string

  const setup = await getWallet(AGENT, 'main')
  console.log(`[fleet] agent=${AGENT} addr=${agentAddr} duration=${DURATION_SEC}s`)

  // Check balance
  const bal = await setup.wallet.getBalance?.().catch(() => null)
  console.log(`[fleet] wallet balance: ${bal ? JSON.stringify(bal) : 'unknown'}`)

  // Profile TX once
  const profile = PROFILES[AGENT] || { name: AGENT, bio: 'Autonomous peck.agents curator.' }
  const profMap = [PROTO_MAP, 'SET', 'app', APP, 'type', 'profile', 'display_name', profile.name, 'bio', profile.bio]
  const profSig = Utils.toBase64(BSM.sign(Array.from(createHash('sha256').update(profMap.join('')).digest()), agentKey) as any)
  const profScript = buildProfileScript(agentAddr, profSig, profile.name, profile.bio)

  const profResult = await setup.wallet.createAction({
    description: `Profile: ${profile.name}`,
    outputs: [
      { lockingScript: profScript.toHex(), satoshis: 0, outputDescription: 'profile' },
    ],
    options: { acceptDelayedBroadcast: true, returnTXIDOnly: false, randomizeOutputs: false },
  })
  await broadcast(profResult.tx as any)
  console.log(`[fleet] profile_tx=${profResult.txid}`)

  let pool = await fetchRecentPosts()
  console.log(`[fleet] feed pool: ${pool.length} posts`)
  if (pool.length === 0) { console.log('[fleet] no posts to reply to; exit'); return }

  writeFileSync(LOG_FILE, '')
  const start = Date.now()
  const deadline = start + DURATION_SEC * 1000
  let seq = 0, ok = 0, fail = 0
  const durations: number[] = []
  let lastFetch = start

  while (Date.now() < deadline) {
    seq++
    const t0 = Date.now()
    try {
      if (Date.now() - lastFetch > 30_000) {
        const fresh = await fetchRecentPosts(); if (fresh.length > 0) pool = fresh; lastFetch = Date.now()
      }
      const target = pool[Math.floor(Math.random() * pool.length)]
      const content = craftReply(target.content, AGENT)
      const mapParts = [
        PROTO_B, content, 'text/markdown', 'UTF-8',
        PROTO_MAP, 'SET', 'app', APP, 'type', 'post', 'context', 'tx', 'tx', target.txid,
      ]
      const sig = Utils.toBase64(BSM.sign(Array.from(createHash('sha256').update(mapParts.join('')).digest()), agentKey) as any)
      const script = buildPostScript(content, agentAddr, sig, target.txid)

      const res = await setup.wallet.createAction({
        description: `Reply to ${target.txid.slice(0, 8)}`,
        outputs: [{ lockingScript: script.toHex(), satoshis: 0, outputDescription: 'reply' }],
        options: { acceptDelayedBroadcast: true, returnTXIDOnly: false, randomizeOutputs: false },
      })
      broadcast(res.tx as any).catch(() => {})
      const ms = Date.now() - t0
      ok++; durations.push(ms)
      appendFileSync(LOG_FILE, JSON.stringify({ seq, ok: true, txid: res.txid, parent: target.txid, ms, ts: Date.now() }) + '\n')
    } catch (e: any) {
      fail++
      appendFileSync(LOG_FILE, JSON.stringify({ seq, ok: false, err: (e.message || String(e)).slice(0, 200), ts: Date.now() }) + '\n')
    }
    if (seq % 5 === 0) {
      const elapsed = (Date.now() - start) / 1000
      const tps = ok / elapsed
      const avg = durations.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, durations.length)
      console.log(`[fleet] seq=${seq} ok=${ok} fail=${fail} tps=${tps.toFixed(2)} avg_ms=${avg.toFixed(0)}`)
    }
  }

  const elapsed = (Date.now() - start) / 1000
  const tps = ok / elapsed
  const summary = {
    agent: AGENT, address: agentAddr, display_name: profile.name,
    duration_sec: elapsed, attempted: seq, succeeded: ok, failed: fail,
    tps_sustained: tps,
    avg_ms: durations.reduce((a, b) => a + b, 0) / Math.max(1, durations.length),
    extrapolated_24h: Math.round(tps * 86400),
    extrapolated_24h_25x: Math.round(tps * 86400 * 25),
  }
  writeFileSync(`/tmp/fleet_${AGENT}_summary.json`, JSON.stringify(summary, null, 2))
  console.log('\n[fleet] SUMMARY')
  console.log(JSON.stringify(summary, null, 2))
}

main().catch(e => { console.error('[fleet] FATAL', e.message || e); process.exit(1) })
