/**
 * tagger-nosend.ts — tag one post using wallet-toolbox for signing only,
 * broadcasting directly to ARC GorillaPool ourselves.
 *
 * Flow:
 *   1. wallet.createAction({ outputs:[tag], options: { noSend: true } })
 *      → returns a fully signed atomic BEEF, status=nosend, no broadcast
 *   2. Extract the raw tx from the BEEF
 *   3. POST rawTx to arc.gorillapool.io/v1/tx directly
 *   4. Real txStatus returned (SEEN_ON_NETWORK / error) — no optimistic lie
 *   5. Truth: the txid we computed from the signed tx IS the on-chain txid
 *
 * Bypasses:
 *   - wallet-infra Monitor's retry-and-resign queue (root cause of txid mutation)
 *   - "sending" status limbo
 *   - Optimistic chaining on unbroadcast parents
 *
 * Keeps:
 *   - BRC-100 identity + BRC-29 funding via bank.peck.to
 *   - wallet-toolbox's UTXO selection + BRC-29 derivation (no secret keys leave host)
 *   - AIP signature by agent's privkey
 *
 * Usage:
 *   npx tsx scripts/tagger-nosend.ts [agent=curator-tech]
 */
import 'dotenv/config'
import { readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { SetupClient } from '@bsv/wallet-toolbox'
import { PrivateKey, Script, OP, BSM, Utils, Beef, Transaction } from '@bsv/sdk'
import { createHash } from 'crypto'

const AGENT = process.argv[2] || 'curator-tech'
const REGISTRY_FILE = '.brc-identities.json'
const OVERLAY_URL = process.env.OVERLAY_URL || 'https://overlay.peck.to'
const BANK_URL = process.env.BANK_URL || 'https://bank.peck.to'
const GCP_PROJECT = process.env.GCP_PROJECT || 'gen-lang-client-0447933194'
const MODEL = process.env.MODEL || 'gemini-3.1-flash-lite-preview'
const APP_NAME = process.env.APP_NAME || 'peck.agents'
const ARC_URL = process.env.ARC_URL || 'https://arc.gorillapool.io/v1/tx'

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

async function askLLM(prompt: string): Promise<any> {
  const tok = await getADCToken()
  if (!tok) throw new Error('no ADC token')
  const url = `https://aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/global/publishers/google/models/${MODEL}:generateContent`
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 300, temperature: 0.2, responseMimeType: 'application/json' },
    }),
  })
  if (!r.ok) throw new Error(`Vertex ${r.status}`)
  return JSON.parse(((await r.json()) as any).candidates?.[0]?.content?.parts?.[0]?.text || '{}')
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

async function pickPost(): Promise<any> {
  const r = await fetch(`${OVERLAY_URL}/v1/feed?type=post&limit=30`)
  const d = (await r.json()) as any
  const list = (d.data || []).filter((p: any) => (p.app || '') !== 'peck.agents')
  if (!list.length) throw new Error('no post')
  return list[Math.floor(Math.random() * list.length)]
}

async function broadcastRawTx(rawHex: string): Promise<{ txid: string; status: string; body: any }> {
  const bin = Buffer.from(rawHex, 'hex')
  const r = await fetch(ARC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bin,
  })
  const body = await r.json().catch(() => ({}))
  return { txid: (body as any).txid || '', status: (body as any).txStatus || String(r.status), body }
}

async function main() {
  const reg = JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'))
  const ident = reg[AGENT]
  if (!ident) { console.error(`no id for ${AGENT}`); process.exit(1) }

  const key = PrivateKey.fromHex(ident.privKeyHex)
  console.log(`[nosend] agent: ${AGENT}`)

  console.log(`[nosend] opening wallet...`)
  const wallet = await SetupClient.createWalletClientNoEnv({
    chain: 'main', rootKeyHex: ident.privKeyHex, storageUrl: BANK_URL,
  })

  const post = await pickPost()
  console.log(`[nosend] target: ${post.txid}  app=${post.app}`)

  const cls = await askLLM(`Classify this post. JSON only: {"tags":["3-5 lowercase"],"category":"tech|news|social|art|finance|commerce|meta|personal|other","lang":"ISO","tone":"technical|casual|promotional|question|opinion|announcement|other"}. Ground only in text. Empty/link: tags=["empty"|"link-only"].

Post (app=${post.app}): ${(post.content || '').trim() || '(empty)'}`)
  if (!Array.isArray(cls.tags) || !cls.tags.length) cls.tags = ['unreadable']
  console.log(`[nosend] classification:`, JSON.stringify(cls))

  const fields: Record<string, string> = {
    context: 'tx', tx: post.txid,
    tags: cls.tags.map((t: any) => String(t).toLowerCase()).join(','),
  }
  if (cls.category) fields.category = String(cls.category).toLowerCase()
  if (cls.lang) fields.lang = String(cls.lang).toLowerCase()
  if (cls.tone) fields.tone = String(cls.tone).toLowerCase()

  const script = buildTagScript(fields, key, APP_NAME)

  console.log(`[nosend] createAction noSend=true...`)
  const t0 = Date.now()
  const res = await wallet.createAction({
    description: `tag ${AGENT}`.slice(0, 50),
    outputs: [{ lockingScript: script.toHex(), satoshis: 0, outputDescription: 'tag op_return' }],
    options: { noSend: true, acceptDelayedBroadcast: false, trustSelf: 'known' as any },
  })
  const tSign = Date.now() - t0
  if (!res.tx) throw new Error('no signed tx returned')
  const atomicBeef = res.tx as number[]
  // Atomic BEEF = 4-byte header (01010101) + 32-byte subject txid + BEEF body
  const subjectTxid = Buffer.from(atomicBeef.slice(4, 36)).reverse().toString('hex')
  const beefBody = Buffer.from(atomicBeef.slice(36))
  // Parse out the signed tx hex — atomic beef's subject tx is the one we built
  const beef = Beef.fromBinary(Array.from(beefBody))
  const tx = beef.findAtomicTransaction(subjectTxid)
  if (!tx) throw new Error('cannot find subject tx in beef')
  const rawHex = tx.toHex()
  const computedTxid = tx.id('hex') as string
  console.log(`[nosend] signed in ${tSign}ms  txid=${computedTxid}  size=${rawHex.length / 2}B`)

  console.log(`[nosend] broadcasting directly to ${ARC_URL} ...`)
  const tB = Date.now()
  const br = await broadcastRawTx(rawHex)
  const tBcast = Date.now() - tB
  console.log(`[nosend] arc responded in ${tBcast}ms  status=${br.status}  txid=${br.txid}`)

  if (br.txid !== computedTxid) {
    console.error(`[nosend] ⚠️ ARC reported different txid: ${br.txid} vs signed ${computedTxid}`)
  } else {
    console.log(`[nosend] ✓ txid matches`)
  }
  if (br.status === 'SEEN_ON_NETWORK' || br.status === 'ANNOUNCED_TO_NETWORK' || br.status === 'SEEN_IN_ORPHAN_MEMPOOL') {
    console.log(`[nosend] ✓ on network`)
    console.log(`[nosend] verify: https://peck.to/tx/${computedTxid}`)
  } else {
    console.log(`[nosend] ARC body:`, JSON.stringify(br.body).slice(0, 300))
  }
}

main().catch(e => { console.error('[nosend] FAIL:', e.message || e); process.exit(1) })
