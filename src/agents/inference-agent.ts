/**
 * Inference Agent — a thin HTTP service that wraps a single OpenRouter
 * model and sells access to it as a Peck Pay marketplace service.
 *
 * Why standalone HTTP and not BrcServiceAgent:
 *   The 402-protocol overhead from BrcServiceAgent is wallet-toolbox-tied
 *   and slow. The ladder-based payment flow happens BEFORE the call (the
 *   buyer pre-pays via PaymentRifle), so the seller just needs to:
 *     1. Verify the request includes a valid request_id (off-chain log)
 *     2. Call the LLM
 *     3. Return the response
 *
 *   Verification of payment is done OUT OF BAND by checking that the
 *   matching shot tx exists on-chain with the right OP_RETURN commitment.
 *   For the hackathon demo we trust the buyer (the marketplace runs on
 *   reputation), and the verification path is provable on demand.
 *
 * Spinnable as multiple instances on different ports — pass MODEL +
 * PORT + PRICE as env vars. The marketplace catalog reflects each
 * instance's model + price.
 *
 * Run:
 *   MODEL=google/gemma-3-12b-it:free PORT=4001 PRICE=30 \
 *   SERVICE_ID=inference-balanced \
 *   npx tsx src/agents/inference-agent.ts < /dev/null
 */
import 'dotenv/config'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { chat, OpenRouterError, type ChatMessage } from '../ladder/openrouter.js'

const SERVICE_ID = process.env.SERVICE_ID || 'inference-balanced'
const MODEL = process.env.MODEL || 'google/gemma-3-12b-it:free'
const PORT = parseInt(process.env.PORT || '4001', 10)
const PRICE = parseInt(process.env.PRICE || '30', 10)
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || '256', 10)
const REGISTRY_URL = process.env.REGISTRY_URL || 'http://localhost:8080'
const ANNOUNCE_TO_REGISTRY = process.env.ANNOUNCE_TO_REGISTRY !== '0'
// Where buyers send the satoshis. For Day 2 demo this is an explicit
// hardcoded P2PKH address. Day 5+ moves to BRC-29 derivation per call.
const PAYMENT_ADDRESS = process.env.PAYMENT_ADDRESS || 'myrdYvFjSEyvHAASo6c19rAXrVZwfAeb5S'  // worker2 testnet

interface InferenceRequest {
  request_id?: string
  prompt?: string
  messages?: ChatMessage[]
  system?: string
  max_tokens?: number
  temperature?: number
}

// In-memory log of served requests so we can show counts in /stats and
// build a per-agent receipt trail. Day 4 will replace this with the
// reputation index when it lands.
const served: Array<{
  request_id: string
  durationMs: number
  prompt_tokens: number
  completion_tokens: number
  served_at: number
}> = []

async function handleInfer(body: InferenceRequest): Promise<{
  status: number
  json: any
}> {
  const requestId = body.request_id || `auto-${Date.now()}`

  // Build messages — accept either {prompt} or {messages, system}
  let messages: ChatMessage[]
  if (body.messages && Array.isArray(body.messages) && body.messages.length > 0) {
    messages = body.messages
    if (body.system) {
      messages = [{ role: 'system', content: body.system }, ...messages]
    }
  } else if (body.prompt) {
    messages = []
    if (body.system) messages.push({ role: 'system', content: body.system })
    messages.push({ role: 'user', content: body.prompt })
  } else {
    return { status: 400, json: { error: 'must provide prompt or messages', request_id: requestId } }
  }

  try {
    const result = await chat({
      model: MODEL,
      messages,
      max_tokens: body.max_tokens ?? MAX_TOKENS,
      temperature: body.temperature ?? 0.7,
    })
    served.push({
      request_id: requestId,
      durationMs: result.durationMs,
      prompt_tokens: result.usage.prompt_tokens,
      completion_tokens: result.usage.completion_tokens,
      served_at: Date.now(),
    })
    return {
      status: 200,
      json: {
        request_id: requestId,
        service_id: SERVICE_ID,
        model: result.model,
        response: result.content,
        usage: result.usage,
        served_in_ms: result.durationMs,
      },
    }
  } catch (e: any) {
    if (e instanceof OpenRouterError) {
      return {
        status: e.status === 429 ? 429 : 502,
        json: {
          error: 'upstream_llm_error',
          detail: e.message,
          retry_after_ms: e.retryAfterMs,
          request_id: requestId,
        },
      }
    }
    return {
      status: 500,
      json: { error: 'inference_failed', detail: String(e?.message || e), request_id: requestId },
    }
  }
}

function jsonResponse(res: ServerResponse, status: number, body: any): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => data += chunk)
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')

  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    return jsonResponse(res, 200, {
      service_id: SERVICE_ID,
      model: MODEL,
      price_per_call_sats: PRICE,
      served_count: served.length,
      port: PORT,
    })
  }

  if (req.method === 'GET' && req.url === '/stats') {
    const last = served.slice(-20)
    const totalTokens = served.reduce((s, r) => s + r.prompt_tokens + r.completion_tokens, 0)
    return jsonResponse(res, 200, {
      service_id: SERVICE_ID,
      model: MODEL,
      total_served: served.length,
      total_tokens: totalTokens,
      last_20: last,
    })
  }

  if (req.method === 'POST' && (req.url === '/infer' || req.url === '/' || req.url === `/${SERVICE_ID}`)) {
    try {
      const body = await readJsonBody(req)
      const { status, json } = await handleInfer(body as InferenceRequest)
      return jsonResponse(res, status, json)
    } catch (e: any) {
      return jsonResponse(res, 400, { error: 'bad_request', detail: String(e?.message || e) })
    }
  }

  jsonResponse(res, 404, { error: 'not_found', path: req.url })
})

async function announceToRegistry(): Promise<void> {
  if (!ANNOUNCE_TO_REGISTRY) return
  try {
    const r = await fetch(`${REGISTRY_URL}/announce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: SERVICE_ID,
        name: SERVICE_ID,
        identityKey: '00'.repeat(33),  // placeholder until we wire BRC-103 identity
        endpoint: `http://localhost:${PORT}`,
        capabilities: ['inference', 'llm', 'chat'],
        pricePerCall: PRICE,
        paymentAddress: PAYMENT_ADDRESS,
        description: `OpenRouter ${MODEL} (free tier). Pay-per-call LLM inference.`,
      }),
    })
    if (r.ok) {
      console.log(`[${SERVICE_ID}] announced to ${REGISTRY_URL}`)
    } else {
      console.log(`[${SERVICE_ID}] announce failed: HTTP ${r.status} (registry maybe not running, that's ok)`)
    }
  } catch (e: any) {
    console.log(`[${SERVICE_ID}] announce skipped: ${e?.message || e}`)
  }
}

server.listen(PORT, async () => {
  console.log(`[${SERVICE_ID}] listening on http://localhost:${PORT}`)
  console.log(`[${SERVICE_ID}] model=${MODEL}  price=${PRICE} sat/call`)
  await announceToRegistry()
})
