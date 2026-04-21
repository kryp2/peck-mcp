/**
 * tagger-once.ts — proof-of-concept tagger agent.
 *
 * Picks ONE real post from the overlay feed, asks Gemini 3.1 Flash Lite
 * (via Vertex AI) to analyze it, then emits a single grounded reply
 * containing the summary + LLM-inferred tags. Reply goes through the
 * MCP server's native BRC-100 path (bank.peck.to), so the agent's key
 * lives at bank.peck.to and no local UTXO bookkeeping happens here.
 *
 * This is the minimal end-to-end proof: real content in, real tags out,
 * real TX on chain, verifiable in the overlay feed.
 *
 * Usage:
 *   npx tsx scripts/tagger-once.ts [agent=curator-tech]
 *
 * Needs:
 *   - gcloud auth print-access-token (for local Vertex AI access), or
 *   - ADC (Cloud Run default), or
 *   - GEMINI_API_KEY env var (fallback to Gemini API endpoint)
 */
import 'dotenv/config'
import { readFileSync } from 'fs'
import { execFileSync } from 'child_process'

const AGENT = process.argv[2] || 'curator-tech'
const REGISTRY_FILE = '.brc-identities.json'
const MCP_URL = process.env.MCP_URL || 'https://mcp.peck.to/mcp'
const OVERLAY_URL = process.env.OVERLAY_URL || 'https://overlay.peck.to'
const GCP_PROJECT = process.env.GCP_PROJECT || 'gen-lang-client-0447933194'
const MODEL = process.env.MODEL || 'gemini-3.1-flash-lite-preview'
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''

// ─── Vertex AI token (ADC → metadata on Cloud Run, gcloud-cli locally) ────

async function getADCToken(): Promise<string | null> {
  // 1. Cloud Run metadata server
  try {
    const r = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(500) },
    )
    if (r.ok) return ((await r.json()) as any).access_token
  } catch {}
  // 2. Local gcloud CLI
  try {
    const tok = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf-8' }).trim()
    if (tok) return tok
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
        generationConfig: { maxOutputTokens: 400, temperature: 0.3, responseMimeType: 'application/json' },
      }),
    })
    if (r.ok) {
      const d = (await r.json()) as any
      return d.candidates?.[0]?.content?.parts?.[0]?.text || ''
    }
    console.warn(`[llm] Vertex ${r.status} ${(await r.text()).slice(0, 200)}`)
  }
  if (GEMINI_API_KEY) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 400, temperature: 0.3, responseMimeType: 'application/json' },
      }),
    })
    if (r.ok) {
      const d = (await r.json()) as any
      return d.candidates?.[0]?.content?.parts?.[0]?.text || ''
    }
  }
  throw new Error('No LLM credentials — run `gcloud auth login` or set GEMINI_API_KEY.')
}

// ─── MCP client (one-shot session) ────────────────────────────────────────

async function mcpCall(session: string, name: string, args: any): Promise<any> {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'mcp-session-id': session,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1e6),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  const raw = await r.text()
  const line = raw.split('\n').find(l => l.startsWith('data: '))
  if (!line) throw new Error(`MCP: no event-stream data\n${raw.slice(0, 200)}`)
  const parsed = JSON.parse(line.slice(6))
  if (parsed.error) throw new Error(`MCP error: ${JSON.stringify(parsed.error)}`)
  return parsed.result
}

async function mcpInit(): Promise<string> {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'peck-tagger-once', version: '0.1.0' },
      },
    }),
  })
  const sess = r.headers.get('mcp-session-id') || ''
  if (!sess) throw new Error('MCP: no session id returned')
  await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'mcp-session-id': sess,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
  return sess
}

// ─── Feed pick ─────────────────────────────────────────────────────────────

interface FeedPost {
  txid: string
  content: string
  app: string
  author: string
  display_name: string | null
}

async function pickGroundedPost(): Promise<FeedPost> {
  const r = await fetch(`${OVERLAY_URL}/v1/feed?type=post&limit=30`)
  const d = (await r.json()) as any
  const candidates = (d.data || [])
    .filter((p: any) => {
      const c = (p.content || '').trim()
      if (c.length < 50) return false                  // too thin to tag
      if (c.startsWith('http') && !/\s/.test(c)) return false  // just a URL
      if (/TPS probe/i.test(c)) return false            // our own noise
      if ((p.app || '') === 'peck.agents') return false // skip other agents for now
      return true
    })
  if (!candidates.length) throw new Error('No groundable post in last 30')
  return candidates[Math.floor(Math.random() * candidates.length)]
}

// ─── Prompt ────────────────────────────────────────────────────────────────

const PROMPT_TEMPLATE = (content: string, author: string, app: string) => `You are a grounded tagger for the BSV social graph. Analyze the post below and return ONLY a JSON object with fields:

{
  "summary": "one sentence (≤120 chars) restating the author's core claim — do not invent, do not editorialize",
  "tags": ["3-6 short lowercase tags drawn only from the post's actual content"],
  "category": "one of: tech, news, social, art, finance, commerce, meta, personal, other",
  "lang": "ISO-639 code of the post language (en, no, es, pt, …)",
  "tone": "one of: technical, casual, promotional, question, opinion, announcement"
}

RULES:
- Only tag what is explicit in the text.
- Do NOT invent references, dates, names, stats, or history not present.
- If the post is too short or ambiguous to tag, return {"summary":"SKIP","tags":[],"category":"other","lang":"unknown","tone":"other"}.

POST (from ${app} by ${author}):
${content}`

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const reg = JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'))
  const ident = reg[AGENT]
  if (!ident) { console.error(`No identity for ${AGENT}`); process.exit(1) }

  console.log(`[tagger] agent: ${AGENT}`)
  console.log(`[tagger] picking post from overlay...`)
  const post = await pickGroundedPost()
  console.log(`[tagger]   parent: ${post.txid}`)
  console.log(`[tagger]   app: ${post.app}  author: ${post.display_name || post.author.slice(0, 12)}`)
  console.log(`[tagger]   content: ${post.content.replace(/\n/g, ' ').slice(0, 160)}`)

  console.log(`\n[tagger] calling ${MODEL} via Vertex AI...`)
  const raw = await askLLM(PROMPT_TEMPLATE(post.content, post.display_name || post.author, post.app))
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.error(`[tagger] LLM returned non-JSON:\n${raw.slice(0, 500)}`)
    process.exit(1)
  }
  console.log(`[tagger] LLM output:`, JSON.stringify(parsed, null, 2))

  if (parsed.summary === 'SKIP' || !parsed.tags?.length) {
    console.log(`[tagger] SKIP — nothing groundable to tag. Done (no TX emitted).`)
    return
  }

  const replyContent = `${parsed.summary} [${parsed.category}/${parsed.lang}/${parsed.tone}]`
  const allTags = [...parsed.tags, parsed.category, parsed.lang, parsed.tone]
    .filter(Boolean).map(String).map(s => s.toLowerCase())

  console.log(`\n[tagger] posting reply...`)
  console.log(`[tagger]   content: "${replyContent}"`)
  console.log(`[tagger]   tags: [${allTags.join(', ')}]`)

  const sess = await mcpInit()
  const res = await mcpCall(sess, 'peck_reply_tx', {
    parent_txid: post.txid,
    content: replyContent,
    tags: allTags,
    signing_key: ident.privKeyHex,
    agent_app: 'peck.agents',
  })
  const txResp = JSON.parse(res.content[0].text)
  if (txResp.error) {
    console.error(`[tagger] ❌ MCP returned error:`, txResp)
    process.exit(1)
  }
  console.log(`[tagger] ✓ txid: ${txResp.txid}`)
  console.log(`[tagger] verify: ${txResp.peck_to || `https://peck.to/tx/${txResp.txid}`}`)
}

main().catch(e => { console.error('[tagger] FAIL:', e.message || e); process.exit(1) })
