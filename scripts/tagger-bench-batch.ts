/**
 * tagger-bench-batch.ts — parallel benchmark with batched-LLM per agent.
 *
 * Each agent's loop asks the LLM to classify BATCH_SIZE posts in one call,
 * then emits BATCH_SIZE tag-TXs sequentially. This amortizes LLM latency
 * across multiple tags and should roughly double per-agent TPS vs the
 * single-post-per-call path.
 *
 * Usage:
 *   npx tsx scripts/tagger-bench-batch.ts <total-iters-per-agent> <batch-size> <agent1,agent2,...>
 *
 * Example (21 agents × 15 tags each = 315 TXs, batch 5):
 *   npx tsx scripts/tagger-bench-batch.ts 15 5 curator-tech,curator-history,...
 */
import 'dotenv/config'
import { readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { SetupClient } from '@bsv/wallet-toolbox'
import { PrivateKey, Script, OP, BSM, Utils } from '@bsv/sdk'
import { createHash } from 'crypto'

const ITER = parseInt(process.argv[2] || '15', 10)
const BATCH = parseInt(process.argv[3] || '5', 10)
const AGENTS = (process.argv[4] || 'curator-tech').split(',').map(s => s.trim()).filter(Boolean)
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

async function askLLMBatch(posts: Array<{ content: string; app: string; author: string }>, token: string): Promise<any[]> {
  const items = posts.map((p, i) => `--- POST ${i + 1} (app=${p.app}, by ${p.author}) ---\n${p.content || '(empty)'}`).join('\n\n')
  const prompt = `Classify each of the ${posts.length} Bitcoin social posts below.

Return ONLY a JSON object: {"results":[<one per post, in order>]}. Each result:
{"tags":["3-5 lowercase tags"],"category":"tech|news|social|art|finance|commerce|meta|personal|other","lang":"ISO code","tone":"technical|casual|promotional|question|opinion|announcement|other"}

Ground ONLY in the text. Empty/link-only: tags=["empty"] or ["link-only"].

${items}`
  const url = `https://aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/global/publishers/google/models/${MODEL}:generateContent`
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 200 + posts.length * 120, temperature: 0.2, responseMimeType: 'application/json' },
    }),
  })
  if (!r.ok) throw new Error(`Vertex ${r.status}`)
  const raw = ((await r.json()) as any).candidates?.[0]?.content?.parts?.[0]?.text || ''
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed.results)) throw new Error('no results array')
  return parsed.results
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

interface AgentResult {
  agent: string; ok: number; fail: number; failReasons: Map<string, number>;
  llmCalls: number; llmTotalMs: number; txTotalMs: number; duration: number;
}
function inc(m: Map<string, number>, k: string) { m.set(k, (m.get(k) || 0) + 1) }

async function runAgent(agent: string, ident: any, pool: any[], token: string): Promise<AgentResult> {
  const wallet = await SetupClient.createWalletClientNoEnv({
    chain: 'main', rootKeyHex: ident.privKeyHex, storageUrl: BANK_URL,
  })
  const key = PrivateKey.fromHex(ident.privKeyHex)
  const res: AgentResult = {
    agent, ok: 0, fail: 0, failReasons: new Map(),
    llmCalls: 0, llmTotalMs: 0, txTotalMs: 0, duration: 0,
  }
  const start = Date.now()

  let done = 0
  while (done < ITER) {
    const take = Math.min(BATCH, ITER - done)
    const idx0 = (done * 17 + agent.length) % pool.length
    const posts = Array.from({ length: take }, (_, i) => pool[(idx0 + i) % pool.length])

    const tLlm = Date.now()
    let classifications: any[]
    try {
      classifications = await askLLMBatch(
        posts.map(p => ({ content: (p.content || '').trim(), app: p.app, author: p.display_name || p.author })),
        token,
      )
      res.llmCalls++
      res.llmTotalMs += Date.now() - tLlm
    } catch (e: any) {
      res.fail += take
      inc(res.failReasons, `llm: ${(e.message || String(e)).slice(0, 60)}`)
      done += take
      continue
    }
    for (let i = 0; i < take; i++) {
      const cls = classifications[i] || {}
      const post = posts[i]
      if (!Array.isArray(cls.tags) || cls.tags.length === 0) cls.tags = ['unreadable']
      const fields: Record<string, string> = {
        context: 'tx', tx: post.txid,
        tags: cls.tags.map((t: any) => String(t).toLowerCase()).join(','),
      }
      if (cls.category) fields.category = String(cls.category).toLowerCase()
      if (cls.lang) fields.lang = String(cls.lang).toLowerCase()
      if (cls.tone) fields.tone = String(cls.tone).toLowerCase()
      const script = buildTagScript(fields, key, APP_NAME)

      const tTx = Date.now()
      try {
        const r = await wallet.createAction({
          description: `tag ${agent}`.slice(0, 50),
          outputs: [{ lockingScript: script.toHex(), satoshis: 0, outputDescription: 'tag op_return' }],
          options: { returnTXIDOnly: true, acceptDelayedBroadcast: true },
        })
        res.txTotalMs += Date.now() - tTx
        if (r.txid) res.ok++; else { res.fail++; inc(res.failReasons, 'no-txid') }
      } catch (e: any) {
        res.fail++
        inc(res.failReasons, (e.message || String(e)).slice(0, 60))
      }
    }
    done += take
  }
  res.duration = (Date.now() - start) / 1000
  return res
}

async function main() {
  console.log(`[batch] agents=${AGENTS.length}  iter/agent=${ITER}  batch=${BATCH}  total target=${AGENTS.length * ITER}`)
  const reg = JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'))
  const idents = AGENTS.map(a => { const id = reg[a]; if (!id) throw new Error(`no id for ${a}`); return { name: a, ident: id } })

  const fr = await fetch(`${OVERLAY_URL}/v1/feed?type=post&limit=${Math.max(ITER * 3, 60)}`)
  const fd = (await fr.json()) as any
  const pool = (fd.data || []).filter((p: any) => (p.app || '') !== 'peck.agents')
  console.log(`[batch] feed pool: ${pool.length}`)

  const token = await getADCToken()
  if (!token) throw new Error('no ADC token')

  console.log(`[batch] starting all agents simultaneously...\n`)
  const t0 = Date.now()
  const results = await Promise.all(idents.map(({ name, ident }) => runAgent(name, ident, pool, token)))
  const wall = (Date.now() - t0) / 1000
  const totalOk = results.reduce((s, r) => s + r.ok, 0)
  const totalFail = results.reduce((s, r) => s + r.fail, 0)

  console.log(`\n=== PER-AGENT (batch=${BATCH}) ===`)
  for (const r of results) {
    const tps = r.ok / r.duration
    const meanLlm = r.llmCalls ? r.llmTotalMs / r.llmCalls : 0
    const meanTx = r.ok ? r.txTotalMs / r.ok : 0
    console.log(`  ${r.agent.padEnd(22)} ok=${String(r.ok).padStart(2)}/${ITER}  fail=${r.fail}  tps=${tps.toFixed(2)}  llm_call=${meanLlm.toFixed(0)}ms  tx=${meanTx.toFixed(0)}ms`)
    for (const [reason, count] of r.failReasons) console.log(`     ${count}× ${reason}`)
  }

  const sumPerAgent = results.reduce((s, r) => s + r.ok / r.duration, 0)
  const globalTps = totalOk / wall
  console.log(`\n=== GLOBAL ===`)
  console.log(`  total ok:      ${totalOk}/${AGENTS.length * ITER}`)
  console.log(`  total fail:    ${totalFail}`)
  console.log(`  wall clock:    ${wall.toFixed(2)} s`)
  console.log(`  global TPS:    ${globalTps.toFixed(2)}`)
  console.log(`  sum TPS:       ${sumPerAgent.toFixed(2)}  (more accurate for parallelism)`)
  console.log(`  per-agent avg: ${(sumPerAgent / AGENTS.length).toFixed(2)} TPS`)
  console.log(`  extrapolated with 35 agents: ${(sumPerAgent / AGENTS.length * 35).toFixed(1)} TPS = ${Math.round(sumPerAgent / AGENTS.length * 35 * 3600 * 12).toLocaleString()} TX/12h`)
  console.log(`  target 34.7 TPS (1.5M/12h)`)
}

main().catch(e => { console.error('[batch] FAIL:', e.message || e); process.exit(1) })
