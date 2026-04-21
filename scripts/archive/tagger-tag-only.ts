/**
 * tagger-tag-only.ts — dedicated tagger agent, proof of a single tag-TX.
 *
 * Picks ONE real post from the overlay feed, asks Gemini 3.1 Flash Lite to
 * classify it, then emits a SINGLE Bitcoin Schema tag transaction. No reply,
 * no new content, no commentary — only machine-readable metadata attached to
 * the target post's txid.
 *
 * On-chain structure (native MAP, no JSON in content):
 *   OP_FALSE OP_RETURN
 *   MAP SET | app <appName> | type tag | context tx | tx <target_txid>
 *           | tags <csv> | [category] | [lang] | [tone]
 *   | AIP BITCOIN_ECDSA <addr> <sig>
 *
 * Dead-content handling: if the post is empty, link-only, or untaggable,
 * the tagger still emits a tag-TX with tags describing why (e.g.
 * "dead-link,link-only,unreadable"). No post is ever skipped silently —
 * every tagger pass produces exactly one TX per target.
 *
 * Wallet: wallet-toolbox client connected to bank.peck.to (native BRC-100).
 * The agent's identity key is used for AIP + BRC-104 auth.
 *
 * Usage:
 *   npx tsx scripts/tagger-tag-only.ts [agent=curator-tech] [target_txid?]
 */
import 'dotenv/config'
import { readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { SetupClient } from '@bsv/wallet-toolbox'
import { PrivateKey, Script, OP, BSM, Utils } from '@bsv/sdk'
import { createHash } from 'crypto'

const AGENT = process.argv[2] || 'curator-tech'
const TARGET_OVERRIDE = process.argv[3] || ''
const REGISTRY_FILE = '.brc-identities.json'
const OVERLAY_URL = process.env.OVERLAY_URL || 'https://overlay.peck.to'
const BANK_URL = process.env.BANK_URL || 'https://bank.peck.to'
const GCP_PROJECT = process.env.GCP_PROJECT || 'gen-lang-client-0447933194'
const MODEL = process.env.MODEL || 'gemini-3.1-flash-lite-preview'
const APP_NAME = process.env.APP_NAME || 'peck.agents'
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''

const PROTO_MAP = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5'
const PROTO_AIP = '15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva'
const PIPE = 0x7c

// ─── Vertex AI token (Cloud Run metadata → gcloud CLI) ────

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

async function askLLM(prompt: string): Promise<string> {
  const tok = await getADCToken()
  if (tok) {
    const url = `https://aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/global/publishers/google/models/${MODEL}:generateContent`
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 400, temperature: 0.2, responseMimeType: 'application/json' },
      }),
    })
    if (r.ok) return ((await r.json()) as any).candidates?.[0]?.content?.parts?.[0]?.text || ''
    console.warn(`[llm] Vertex ${r.status}: ${(await r.text()).slice(0, 200)}`)
  }
  if (GEMINI_API_KEY) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 400, temperature: 0.2, responseMimeType: 'application/json' },
      }),
    })
    if (r.ok) return ((await r.json()) as any).candidates?.[0]?.content?.parts?.[0]?.text || ''
  }
  throw new Error('No LLM credentials — run `gcloud auth login` or set GEMINI_API_KEY.')
}

// ─── Feed pick ────

async function pickPost(override: string): Promise<any> {
  if (override) {
    const r = await fetch(`${OVERLAY_URL}/v1/post/${override}`)
    const d = (await r.json()) as any
    if (!d?.data && !d?.txid) throw new Error(`target ${override} not found on overlay`)
    return d.data || d
  }
  const r = await fetch(`${OVERLAY_URL}/v1/feed?type=post&limit=30`)
  const d = (await r.json()) as any
  const list = (d.data || []).filter((p: any) => (p.app || '') !== 'peck.agents')
  if (!list.length) throw new Error('no candidate post on overlay')
  return list[Math.floor(Math.random() * list.length)]
}

// ─── Script builder (MAP-only type=tag, AIP-signed) ────

function pushData(s: Script, data: string | number[]) {
  const bytes = typeof data === 'string' ? Array.from(Buffer.from(data, 'utf8')) : data
  s.writeBin(bytes)
}

function buildTagScript(
  fields: Record<string, string>,
  key: PrivateKey,
  app: string,
): Script {
  const s = new Script()
  s.writeOpCode(OP.OP_FALSE)
  s.writeOpCode(OP.OP_RETURN)
  pushData(s, PROTO_MAP)
  pushData(s, 'SET')
  pushData(s, 'app'); pushData(s, app)
  pushData(s, 'type'); pushData(s, 'tag')
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || v === '') continue
    pushData(s, k); pushData(s, String(v))
  }
  // AIP over the serialized field list (deterministic, signable by verifier)
  const addr = key.toAddress('mainnet') as string
  const signingPayload = 'tag' + JSON.stringify(fields)
  const digest = Array.from(createHash('sha256').update(signingPayload).digest())
  const sig = Utils.toBase64(BSM.sign(digest, key) as any)
  s.writeBin([PIPE])
  pushData(s, PROTO_AIP); pushData(s, 'BITCOIN_ECDSA'); pushData(s, addr); pushData(s, sig)
  return s
}

// ─── Prompt ────

const PROMPT = (content: string, author: string, app: string) => `You classify a Bitcoin social post into machine-readable metadata.

Return ONLY JSON matching this schema:
{
  "tags": ["3-7 short lowercase single-word tags grounded ONLY in the post text"],
  "category": "tech | news | social | art | finance | commerce | meta | personal | other",
  "lang": "ISO-639 code (en, no, es, pt, …) or 'unknown'",
  "tone": "technical | casual | promotional | question | opinion | announcement | other"
}

DEAD-CONTENT RULES (important):
- Empty/whitespace post: tags=["empty"], tone="other"
- Only a URL with no commentary: include tag "link-only"
- Unparseable / garbled: tags=["unreadable"]
- Never return an empty tags array — always describe why it can't be tagged.

POST from ${app} by ${author}:
${content || '(empty)'}`

// ─── Main ────

async function main() {
  const reg = JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'))
  const ident = reg[AGENT]
  if (!ident) { console.error(`No identity for ${AGENT}`); process.exit(1) }

  console.log(`[tagger] agent: ${AGENT}`)
  console.log(`[tagger] picking target post...`)
  const post = await pickPost(TARGET_OVERRIDE)
  const targetTxid = post.txid
  const content = (post.content || '').trim()
  console.log(`[tagger]   target: ${targetTxid}`)
  console.log(`[tagger]   app: ${post.app}  author: ${post.display_name || (post.author || '').slice(0, 12)}`)
  console.log(`[tagger]   content: ${content.slice(0, 160) || '(empty)'}`)

  console.log(`\n[tagger] classifying with ${MODEL}...`)
  const raw = await askLLM(PROMPT(content, post.display_name || post.author || 'unknown', post.app || 'unknown'))
  let cls: any
  try { cls = JSON.parse(raw) }
  catch { console.error(`[tagger] LLM non-JSON:\n${raw.slice(0, 400)}`); process.exit(1) }
  if (!Array.isArray(cls.tags) || cls.tags.length === 0) cls.tags = ['unreadable']
  console.log(`[tagger] classification:`, JSON.stringify(cls, null, 2))

  const fields: Record<string, string> = {
    context: 'tx',
    tx: targetTxid,
    tags: cls.tags.map((t: any) => String(t).toLowerCase()).join(','),
  }
  if (cls.category) fields.category = String(cls.category).toLowerCase()
  if (cls.lang) fields.lang = String(cls.lang).toLowerCase()
  if (cls.tone) fields.tone = String(cls.tone).toLowerCase()

  const agentKey = PrivateKey.fromHex(ident.privKeyHex)
  const script = buildTagScript(fields, agentKey, APP_NAME)

  console.log(`\n[tagger] opening wallet at ${BANK_URL}...`)
  const wallet = await SetupClient.createWalletClientNoEnv({
    chain: 'main',
    rootKeyHex: ident.privKeyHex,
    storageUrl: BANK_URL,
  })

  console.log(`[tagger] emitting tag-TX (type=tag, context=tx, tx=${targetTxid.slice(0, 16)}…)`)
  const t0 = Date.now()
  const res = await wallet.createAction({
    description: `tag ${AGENT}`.slice(0, 50),
    outputs: [{ lockingScript: script.toHex(), satoshis: 0, outputDescription: 'tag op_return' }],
    options: { returnTXIDOnly: true, acceptDelayedBroadcast: false },
  })
  const ms = Date.now() - t0
  const txid = res.txid
  if (!txid) { console.error('[tagger] wallet returned no txid', res); process.exit(1) }

  console.log(`\n[tagger] ✓ txid: ${txid}  (${ms} ms)`)
  console.log(`[tagger] target:  https://peck.to/tx/${targetTxid}`)
  console.log(`[tagger] tag-tx:  https://peck.to/tx/${txid}`)
  console.log(`[tagger] WoC:     https://whatsonchain.com/tx/${txid}`)
}

main().catch(e => { console.error('[tagger] FAIL:', e.message || e); process.exit(1) })
