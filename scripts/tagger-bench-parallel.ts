/**
 * tagger-bench-parallel.ts — measure N concurrent taggers.
 *
 * Each agent runs its own sequential loop (K iterations), all loops start
 * simultaneously. Aggregate across agents = global TPS. Per-agent TPS should
 * stay close to the single-agent benchmark (0.59) if the bottleneck is
 * per-identity (LLM + wallet-infra per-user lock). If global TPS starts to
 * flatten out as N grows, something upstream (bank.peck.to, Vertex, ARC)
 * is the new bottleneck.
 *
 * Usage:
 *   npx tsx scripts/tagger-bench-parallel.ts <iterations-per-agent> <agent1,agent2,...>
 *
 * Example:
 *   npx tsx scripts/tagger-bench-parallel.ts 10 curator-tech,curator-news,curator-art,curator-finance,curator-meta
 */
import 'dotenv/config'
import { readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { SetupClient } from '@bsv/wallet-toolbox'
import { PrivateKey, Script, OP, BSM, Utils } from '@bsv/sdk'
import { createHash } from 'crypto'

const ITER = parseInt(process.argv[2] || '10', 10)
const AGENTS = (process.argv[3] || 'curator-tech').split(',').map(s => s.trim()).filter(Boolean)
const REGISTRY_FILE = '.brc-identities.json'
const OVERLAY_URL = process.env.OVERLAY_URL || 'https://overlay.peck.to'
const BANK_URL = process.env.BANK_URL || 'https://bank.peck.to'
const GCP_PROJECT = process.env.GCP_PROJECT || 'gen-lang-client-0447933194'
const MODEL = process.env.MODEL || 'gemini-3.1-flash-lite-preview'
const APP_NAME = process.env.APP_NAME || 'peck.agents'

const PROTO_MAP = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5'
const PROTO_AIP = '15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva'
const PIPE = 0x7c

async function getADCToken(): Promise<string | null> {
  try {
    const r = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(500) },
    )
    if (r.ok) return ((await r.json()) as any).access_token
  } catch {}
  try { return execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf-8' }).trim() } catch {}
  return null
}

async function askLLM(prompt: string, token: string): Promise<string> {
  const url = `https://aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/global/publishers/google/models/${MODEL}:generateContent`
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 300, temperature: 0.2, responseMimeType: 'application/json' },
    }),
  })
  if (!r.ok) throw new Error(`Vertex ${r.status}`)
  return ((await r.json()) as any).candidates?.[0]?.content?.parts?.[0]?.text || ''
}

function pushData(s: Script, data: string) { s.writeBin(Array.from(Buffer.from(data, 'utf8'))) }

function buildTagScript(fields: Record<string, string>, key: PrivateKey, app: string): Script {
  const s = new Script()
  s.writeOpCode(OP.OP_FALSE); s.writeOpCode(OP.OP_RETURN)
  pushData(s, PROTO_MAP); pushData(s, 'SET')
  pushData(s, 'app'); pushData(s, app)
  pushData(s, 'type'); pushData(s, 'tag')
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || v === '') continue
    pushData(s, k); pushData(s, String(v))
  }
  const addr = key.toAddress('mainnet') as string
  const digest = Array.from(createHash('sha256').update('tag' + JSON.stringify(fields)).digest())
  const sig = Utils.toBase64(BSM.sign(digest, key) as any)
  s.writeBin([PIPE])
  pushData(s, PROTO_AIP); pushData(s, 'BITCOIN_ECDSA'); pushData(s, addr); pushData(s, sig)
  return s
}

const PROMPT = (content: string, app: string, author: string) => `Classify this Bitcoin social post.
Return ONLY JSON: {"tags":["3-5 lowercase tags"],"category":"tech|news|social|art|finance|commerce|meta|personal|other","lang":"ISO code","tone":"technical|casual|promotional|question|opinion|announcement|other"}
Ground ONLY in text. Empty/link-only: tags=["empty"] or ["link-only"].

Post from ${app} by ${author}:
${content || '(empty)'}`

interface AgentResult {
  agent: string
  ok: number
  fail: number
  failReasons: Map<string, number>
  latencies: number[]
  duration: number
}

async function runAgent(
  agent: string,
  ident: any,
  pool: any[],
  token: string,
): Promise<AgentResult> {
  const wallet = await SetupClient.createWalletClientNoEnv({
    chain: 'main', rootKeyHex: ident.privKeyHex, storageUrl: BANK_URL,
  })
  const key = PrivateKey.fromHex(ident.privKeyHex)
  const res: AgentResult = { agent, ok: 0, fail: 0, failReasons: new Map(), latencies: [], duration: 0 }
  const start = Date.now()

  for (let i = 0; i < ITER; i++) {
    const post = pool[(i * 17 + agent.length) % pool.length]  // stagger post selection across agents
    const content = (post.content || '').trim()
    const t0 = Date.now()
    try {
      const raw = await askLLM(PROMPT(content, post.app, post.display_name || post.author), token)
      const cls = JSON.parse(raw)
      if (!Array.isArray(cls.tags) || cls.tags.length === 0) cls.tags = ['unreadable']

      const fields: Record<string, string> = {
        context: 'tx', tx: post.txid,
        tags: cls.tags.map((t: any) => String(t).toLowerCase()).join(','),
      }
      if (cls.category) fields.category = String(cls.category).toLowerCase()
      if (cls.lang) fields.lang = String(cls.lang).toLowerCase()
      if (cls.tone) fields.tone = String(cls.tone).toLowerCase()

      const script = buildTagScript(fields, key, APP_NAME)
      const r = await wallet.createAction({
        description: `tag ${agent}`.slice(0, 50),
        outputs: [{ lockingScript: script.toHex(), satoshis: 0, outputDescription: 'tag op_return' }],
        options: { returnTXIDOnly: true, acceptDelayedBroadcast: true },
      })
      const ms = Date.now() - t0
      res.latencies.push(ms)
      if (r.txid) res.ok++
      else { res.fail++; inc(res.failReasons, 'no-txid') }
    } catch (e: any) {
      res.fail++
      const msg = (e.message || String(e)).slice(0, 80)
      inc(res.failReasons, msg)
    }
  }
  res.duration = (Date.now() - start) / 1000
  return res
}

function inc(m: Map<string, number>, k: string) { m.set(k, (m.get(k) || 0) + 1) }

async function main() {
  console.log(`[parallel] agents=${AGENTS.length}  iterations/agent=${ITER}  total target=${AGENTS.length * ITER}`)
  const reg = JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'))
  const idents = AGENTS.map(a => { const id = reg[a]; if (!id) throw new Error(`no identity for ${a}`); return { name: a, ident: id } })

  const fr = await fetch(`${OVERLAY_URL}/v1/feed?type=post&limit=${Math.max(ITER * 3, 50)}`)
  const fd = (await fr.json()) as any
  const pool = (fd.data || []).filter((p: any) => (p.app || '') !== 'peck.agents')
  console.log(`[parallel] feed pool: ${pool.length}`)

  const token = await getADCToken()
  if (!token) throw new Error('no ADC token')

  console.log(`[parallel] starting all agents simultaneously...\n`)
  const t0 = Date.now()
  const results = await Promise.all(idents.map(({ name, ident }) => runAgent(name, ident, pool, token)))
  const totalDuration = (Date.now() - t0) / 1000
  const totalOk = results.reduce((s, r) => s + r.ok, 0)
  const totalFail = results.reduce((s, r) => s + r.fail, 0)

  console.log(`\n=== PER-AGENT RESULT ===`)
  for (const r of results) {
    const tps = r.ok / r.duration
    const mean = r.latencies.length ? r.latencies.reduce((a,b)=>a+b,0)/r.latencies.length : 0
    console.log(`  ${r.agent.padEnd(20)} ok=${String(r.ok).padStart(2)}/${ITER}  fail=${r.fail}  tps=${tps.toFixed(2)}  mean=${mean.toFixed(0)}ms`)
    if (r.fail > 0) {
      for (const [reason, count] of r.failReasons) console.log(`       ${count}× ${reason}`)
    }
  }
  const globalTps = totalOk / totalDuration
  console.log(`\n=== GLOBAL ===`)
  console.log(`  total ok:      ${totalOk}/${AGENTS.length * ITER}`)
  console.log(`  total fail:    ${totalFail}`)
  console.log(`  wall clock:    ${totalDuration.toFixed(2)} s`)
  console.log(`  global TPS:    ${globalTps.toFixed(2)}`)
  console.log(`  per-agent avg: ${(globalTps / AGENTS.length).toFixed(2)} TPS`)
  console.log(`  extrapolated with 35 agents: ${(globalTps / AGENTS.length * 35).toFixed(1)} TPS = ${Math.round(globalTps / AGENTS.length * 35 * 3600 * 12).toLocaleString()} TX/12h`)
  console.log(`  target 34.7 TPS (1.5M/12h)`)
}

main().catch(e => { console.error('[parallel] FAIL:', e.message || e); process.exit(1) })
