/**
 * tagger-verify-rate.ts — measure silent-failure rate by verifying each
 * reported txid against JungleBus after emission.
 *
 * Runs N agents in parallel, batch-LLM, then waits 90s and checks each
 * reported txid via JungleBus to see if it's actually on-chain. Reports:
 *   - claimed success rate (from wallet-infra)
 *   - actual on-chain rate (from JungleBus)
 *   - delta = silent-failure rate
 *
 * Usage:
 *   npx tsx scripts/tagger-verify-rate.ts <iter-per-agent> <batch-size> <agents-csv>
 */
import 'dotenv/config'
import { readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { SetupClient } from '@bsv/wallet-toolbox'
import { PrivateKey, Script, OP, BSM, Utils } from '@bsv/sdk'
import { createHash } from 'crypto'

const ITER = parseInt(process.argv[2] || '5', 10)
const BATCH = parseInt(process.argv[3] || '5', 10)
const AGENTS = (process.argv[4] || '').split(',').map(s => s.trim()).filter(Boolean)
const VERIFY_WAIT_SEC = parseInt(process.env.VERIFY_WAIT_SEC || '90', 10)
const REGISTRY_FILE = '.brc-identities.json'
const OVERLAY_URL = process.env.OVERLAY_URL || 'https://overlay.peck.to'
const BANK_URL = process.env.BANK_URL || 'https://bank.peck.to'
const GCP_PROJECT = process.env.GCP_PROJECT || 'gen-lang-client-0447933194'
const MODEL = process.env.MODEL || 'gemini-3.1-flash-lite-preview'
const APP_NAME = process.env.APP_NAME || 'peck.agents'
const JB = 'https://junglebus.gorillapool.io/v1/transaction/get'

const PROTO_MAP = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5'
const PROTO_AIP = '15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva'
const PIPE = 0x7c

async function getADCToken(): Promise<string> {
  try {
    const r = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(500) },
    )
    if (r.ok) return ((await r.json()) as any).access_token
  } catch {}
  return execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf-8' }).trim()
}

async function askLLMBatch(posts: Array<{ content: string; app: string; author: string }>, token: string): Promise<any[]> {
  const items = posts.map((p, i) => `--- POST ${i + 1} (app=${p.app}, by ${p.author}) ---\n${p.content || '(empty)'}`).join('\n\n')
  const prompt = `Classify each of the ${posts.length} Bitcoin social posts below.
Return ONLY {"results":[<one per post>]}. Each result:
{"tags":["3-5 lowercase tags"],"category":"tech|news|social|art|finance|commerce|meta|personal|other","lang":"ISO code","tone":"technical|casual|promotional|question|opinion|announcement|other"}
Ground ONLY in text. Empty/link: tags=["empty"] or ["link-only"].
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
  for (const [k, v] of Object.entries(fields)) { if (v) { pushData(s, k); pushData(s, String(v)) } }
  const addr = key.toAddress('mainnet') as string
  const digest = Array.from(createHash('sha256').update('tag' + JSON.stringify(fields)).digest())
  const sig = Utils.toBase64(BSM.sign(digest, key) as any)
  s.writeBin([PIPE])
  pushData(s, PROTO_AIP); pushData(s, 'BITCOIN_ECDSA'); pushData(s, addr); pushData(s, sig)
  return s
}

async function runAgent(name: string, ident: any, pool: any[], token: string): Promise<string[]> {
  const wallet = await SetupClient.createWalletClientNoEnv({
    chain: 'main', rootKeyHex: ident.privKeyHex, storageUrl: BANK_URL,
  })
  const key = PrivateKey.fromHex(ident.privKeyHex)
  const txids: string[] = []
  let done = 0
  while (done < ITER) {
    const take = Math.min(BATCH, ITER - done)
    const idx0 = (done * 17 + name.length) % pool.length
    const posts = Array.from({ length: take }, (_, i) => pool[(idx0 + i) % pool.length])
    let cls: any[]
    try {
      cls = await askLLMBatch(posts.map(p => ({ content: (p.content || '').trim(), app: p.app, author: p.display_name || p.author })), token)
    } catch { done += take; continue }
    for (let i = 0; i < take; i++) {
      const c = cls[i] || {}
      if (!Array.isArray(c.tags) || !c.tags.length) c.tags = ['unreadable']
      const fields: Record<string, string> = {
        context: 'tx', tx: posts[i].txid,
        tags: c.tags.map((t: any) => String(t).toLowerCase()).join(','),
      }
      if (c.category) fields.category = String(c.category).toLowerCase()
      if (c.lang) fields.lang = String(c.lang).toLowerCase()
      if (c.tone) fields.tone = String(c.tone).toLowerCase()
      try {
        const r = await wallet.createAction({
          description: `tag ${name}`.slice(0, 50),
          outputs: [{ lockingScript: buildTagScript(fields, key, APP_NAME).toHex(), satoshis: 0, outputDescription: 'tag op_return' }],
          options: { returnTXIDOnly: true, acceptDelayedBroadcast: true },
        })
        if (r.txid) txids.push(r.txid)
      } catch {}
    }
    done += take
  }
  return txids
}

async function verifyOnChain(txid: string): Promise<'found' | 'not-found' | 'error'> {
  try {
    const r = await fetch(`${JB}/${txid}`)
    const text = await r.text()
    // 404 OR body "tx-not-found" — TX genuinely not on chain
    if (r.status === 404 || text.includes('tx-not-found')) return 'not-found'
    if (!r.ok) return 'error'
    try { const o = JSON.parse(text); if (o && o.id) return 'found' } catch {}
    return 'error'
  } catch { return 'error' }
}

// Serialize JungleBus calls to avoid rate-limiting 60+ parallel requests
async function verifyBatch(txids: string[], concurrency = 4): Promise<Array<{ txid: string; status: 'found'|'not-found'|'error' }>> {
  const out: Array<{ txid: string; status: 'found'|'not-found'|'error' }> = []
  for (let i = 0; i < txids.length; i += concurrency) {
    const chunk = txids.slice(i, i + concurrency)
    const r = await Promise.all(chunk.map(t => verifyOnChain(t).then(s => ({ txid: t, status: s }))))
    out.push(...r)
  }
  return out
}

async function main() {
  const reg = JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'))
  const idents = AGENTS.map(a => { const id = reg[a]; if (!id) throw new Error(`no id for ${a}`); return { name: a, ident: id } })

  const fr = await fetch(`${OVERLAY_URL}/v1/feed?type=post&limit=${Math.max(ITER * 3, 30)}`)
  const fd = (await fr.json()) as any
  const pool = (fd.data || []).filter((p: any) => (p.app || '') !== 'peck.agents')
  const token = await getADCToken()

  console.log(`[verify] agents=${idents.length}  iter=${ITER}  batch=${BATCH}  total=${idents.length * ITER}`)
  console.log(`[verify] emitting...`)
  const t0 = Date.now()
  const allTxidsNested = await Promise.all(idents.map(({ name, ident }) => runAgent(name, ident, pool, token)))
  const emitWall = (Date.now() - t0) / 1000
  const allTxids = allTxidsNested.flat()
  console.log(`[verify] ✓ emitted ${allTxids.length} txids in ${emitWall.toFixed(1)}s (${(allTxids.length / emitWall).toFixed(2)} TPS reported)`)

  console.log(`[verify] waiting ${VERIFY_WAIT_SEC}s for propagation to JungleBus...`)
  await new Promise(r => setTimeout(r, VERIFY_WAIT_SEC * 1000))

  console.log(`[verify] verifying each txid against JungleBus...`)
  const tV = Date.now()
  const results = await verifyBatch(allTxids, 4)
  const vWall = (Date.now() - tV) / 1000
  const found = results.filter(r => r.status === 'found').length
  const notFound = results.filter(r => r.status === 'not-found').length
  const err = results.filter(r => r.status === 'error').length

  console.log(`\n=== VERIFICATION RESULT ===`)
  console.log(`  reported emitted:  ${allTxids.length}`)
  console.log(`  on-chain (found):  ${found}  (${(found / allTxids.length * 100).toFixed(1)}%)`)
  console.log(`  NOT on-chain:      ${notFound}  (${(notFound / allTxids.length * 100).toFixed(1)}%)  ← SILENT FAILURES`)
  console.log(`  verify error:      ${err}`)
  console.log(`\n  real TPS (verified on-chain only): ${(found / emitWall).toFixed(2)}`)
  console.log(`  extrapolated to 1.5M over 12h: need ${Math.ceil(34.72 / (found / emitWall / idents.length))} agents at this quality`)

  if (notFound > 0) {
    console.log(`\nSample silent-failure txids (max 5):`)
    for (const r of results.filter(r => r.status === 'not-found').slice(0, 5)) {
      console.log(`  ${r.txid}`)
    }
  }
}

main().catch(e => { console.error('[verify] FAIL:', e.message || e); process.exit(1) })
