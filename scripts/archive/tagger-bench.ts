/**
 * tagger-bench.ts — measure single-agent tagger throughput.
 *
 * Runs N sequential tag iterations for one agent and reports:
 *   - mean / p50 / p95 latency (LLM + broadcast)
 *   - sustained TPS for this single identity
 *   - extrapolated parallelism needed to hit 1.5M TX / 12h (= ~34.7 TPS)
 *
 * Serialization: wallet-toolbox locks per identity, so 1 agent key = 1
 * logical lane. Parallelism must come from using multiple agent keys
 * concurrently (35 funded identities → 35 independent wallet-infra user
 * rows → 35 independent locks).
 *
 * Usage:
 *   npx tsx scripts/tagger-bench.ts [agent=curator-tech] [iterations=20]
 */
import 'dotenv/config'
import { readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { SetupClient } from '@bsv/wallet-toolbox'
import { PrivateKey, Script, OP, BSM, Utils } from '@bsv/sdk'
import { createHash } from 'crypto'

const AGENT = process.argv[2] || 'curator-tech'
const ITER = parseInt(process.argv[3] || '20', 10)
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
  try {
    return execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf-8' }).trim()
  } catch {}
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

function pushData(s: Script, data: string) {
  s.writeBin(Array.from(Buffer.from(data, 'utf8')))
}

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
Ground ONLY in the text. Empty/link-only posts: tags=["empty"] or ["link-only"].

Post from ${app} by ${author}:
${content || '(empty)'}`

function pct(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

async function main() {
  const reg = JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'))
  const ident = reg[AGENT]
  if (!ident) { console.error(`No identity for ${AGENT}`); process.exit(1) }

  console.log(`[bench] agent=${AGENT}  iterations=${ITER}  model=${MODEL}`)
  console.log(`[bench] fetching feed pool...`)
  const fr = await fetch(`${OVERLAY_URL}/v1/feed?type=post&limit=${Math.max(ITER * 2, 30)}`)
  const fd = (await fr.json()) as any
  const pool = (fd.data || []).filter((p: any) => (p.app || '') !== 'peck.agents')
  if (pool.length < ITER) { console.error(`not enough pool: ${pool.length}`); process.exit(1) }

  const token = await getADCToken()
  if (!token) { console.error('no ADC token — run `gcloud auth login`'); process.exit(1) }

  console.log(`[bench] opening wallet @ ${BANK_URL}...`)
  const wallet = await SetupClient.createWalletClientNoEnv({
    chain: 'main', rootKeyHex: ident.privKeyHex, storageUrl: BANK_URL,
  })
  const key = PrivateKey.fromHex(ident.privKeyHex)

  const llmMs: number[] = []
  const txMs: number[] = []
  const totalMs: number[] = []
  let ok = 0, fail = 0
  const txids: string[] = []

  const benchStart = Date.now()
  for (let i = 0; i < ITER; i++) {
    const post = pool[i]
    const content = (post.content || '').trim()
    const t0 = Date.now()
    try {
      const raw = await askLLM(PROMPT(content, post.app, post.display_name || post.author), token)
      const cls = JSON.parse(raw)
      const tLlm = Date.now()
      llmMs.push(tLlm - t0)

      if (!Array.isArray(cls.tags) || cls.tags.length === 0) cls.tags = ['unreadable']
      const fields: Record<string, string> = {
        context: 'tx', tx: post.txid,
        tags: cls.tags.map((t: any) => String(t).toLowerCase()).join(','),
      }
      if (cls.category) fields.category = String(cls.category).toLowerCase()
      if (cls.lang) fields.lang = String(cls.lang).toLowerCase()
      if (cls.tone) fields.tone = String(cls.tone).toLowerCase()
      const script = buildTagScript(fields, key, APP_NAME)

      const res = await wallet.createAction({
        description: `tag ${AGENT}`.slice(0, 50),
        outputs: [{ lockingScript: script.toHex(), satoshis: 0, outputDescription: 'tag op_return' }],
        options: { returnTXIDOnly: true, acceptDelayedBroadcast: true },
      })
      const tTx = Date.now()
      txMs.push(tTx - tLlm)
      totalMs.push(tTx - t0)
      if (res.txid) { ok++; txids.push(res.txid) } else { fail++ }
      if ((i + 1) % 5 === 0) {
        const elapsed = (Date.now() - benchStart) / 1000
        console.log(`[bench] ${i + 1}/${ITER}  ok=${ok} fail=${fail}  tps=${(ok / elapsed).toFixed(2)}  mean=${(totalMs.reduce((a,b)=>a+b,0)/totalMs.length).toFixed(0)}ms`)
      }
    } catch (e: any) {
      fail++
      console.error(`[bench]   iter ${i} FAIL: ${(e.message || String(e)).slice(0, 160)}`)
    }
  }
  const elapsed = (Date.now() - benchStart) / 1000
  const tps = ok / elapsed

  console.log(`\n=== BENCHMARK RESULT ===`)
  console.log(`agent:          ${AGENT}`)
  console.log(`iterations:     ${ITER}`)
  console.log(`succeeded:      ${ok}`)
  console.log(`failed:         ${fail}`)
  console.log(`total elapsed:  ${elapsed.toFixed(2)} s`)
  console.log(`sustained TPS:  ${tps.toFixed(3)}`)
  if (totalMs.length) {
    console.log(`\nLatency (ms):`)
    console.log(`  mean total:   ${(totalMs.reduce((a,b)=>a+b,0)/totalMs.length).toFixed(0)}`)
    console.log(`  p50 total:    ${pct(totalMs, 0.5)}`)
    console.log(`  p95 total:    ${pct(totalMs, 0.95)}`)
    console.log(`  mean LLM:     ${(llmMs.reduce((a,b)=>a+b,0)/llmMs.length).toFixed(0)}`)
    console.log(`  mean tx:      ${(txMs.reduce((a,b)=>a+b,0)/txMs.length).toFixed(0)}`)
  }
  console.log(`\n=== PARALLELISM MATH (target 1.5M TX / 12h = 34.72 TPS) ===`)
  if (tps > 0) {
    const needed = Math.ceil(34.72 / tps)
    console.log(`  per-agent TPS:      ${tps.toFixed(3)}`)
    console.log(`  agents for 34.7 TPS: ${needed}`)
    console.log(`  with 35 funded:     ${(35 * tps).toFixed(1)} TPS = ${Math.round(35 * tps * 3600 * 12).toLocaleString()} TX/12h`)
  }
  console.log(`\nSample txids:`)
  for (const t of txids.slice(-3)) console.log(`  ${t}`)
}

main().catch(e => { console.error('[bench] FAIL:', e.message || e); process.exit(1) })
