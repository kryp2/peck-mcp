/**
 * OpenRouter wrapper — single function `chat()` that hits the OpenRouter
 * chat completions API and returns a normalized response.
 *
 * Why OpenRouter:
 *   - One API key for hundreds of models
 *   - OpenAI-compatible request shape
 *   - Many `:free` tier models with $0 cost (rate limited)
 *   - Lets the marketplace expose multiple LLM agents at different
 *     price/quality points without integrating multiple SDKs
 *
 * Free tier model picks (verified live 2026-04-08):
 *   - google/gemma-3-4b-it:free       — fastest, smallest, ~5 sat tier
 *   - google/gemma-3-12b-it:free      — balanced, ~30 sat tier
 *   - openai/gpt-oss-20b:free         — small open OpenAI, ~30 sat tier
 *   - openai/gpt-oss-120b:free        — premium open OpenAI, ~100 sat tier
 *   - qwen/qwen3-next-80b-a3b-instruct:free — big Qwen, ~80 sat tier
 *   - qwen/qwen3-coder:free           — code specialist, ~50 sat tier
 *
 * Rate limit: ~20 req/min per model on free tier. Sharding across models
 * scales the marketplace's inference capacity linearly.
 */
import 'dotenv/config'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  max_tokens?: number
  temperature?: number
}

export interface ChatResponse {
  model: string
  content: string
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    cost: number
  }
  durationMs: number
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs?: number,
    public readonly raw?: any,
  ) {
    super(message)
  }
}

/**
 * Send a chat completion request. Throws OpenRouterError on hard failure.
 * Caller is responsible for retries (we surface retryAfterMs from headers
 * when the API rate-limits us).
 */
export async function chat(req: ChatRequest): Promise<ChatResponse> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    throw new OpenRouterError('OPENROUTER_API_KEY not set in env', 0)
  }

  const t0 = Date.now()
  const r = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      // OpenRouter requires these for analytics + quota attribution
      'HTTP-Referer': 'https://github.com/kryp2/peck-mcp',
      'X-Title': 'Peck Pay',
    },
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      max_tokens: req.max_tokens ?? 256,
      temperature: req.temperature ?? 0.7,
    }),
  })

  const data = await r.json().catch(() => ({})) as any
  const durationMs = Date.now() - t0

  if (!r.ok || data.error) {
    const retryAfter = r.headers.get('retry-after')
    throw new OpenRouterError(
      data.error?.message || `HTTP ${r.status}`,
      r.status,
      retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined,
      data,
    )
  }

  const choice = data.choices?.[0]
  if (!choice?.message?.content) {
    throw new OpenRouterError(
      `OpenRouter returned no content: ${JSON.stringify(data).slice(0, 300)}`,
      r.status,
    )
  }

  const usage = data.usage || {}
  return {
    model: data.model || req.model,
    content: choice.message.content,
    usage: {
      prompt_tokens: usage.prompt_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
      cost: usage.cost ?? 0,
    },
    durationMs,
  }
}

/**
 * Predefined model tiers for the marketplace. Each tier maps to a Peck
 * Pay service id, an OpenRouter model id, and a sat-price that reflects
 * relative quality + size.
 *
 * These are starting points; the user can adjust prices in the catalog
 * based on real reputation/latency data once the system is running.
 */
export interface InferenceTier {
  serviceId: string
  model: string
  pricePerCallSats: number
  description: string
}

export const FREE_INFERENCE_TIERS: InferenceTier[] = [
  {
    serviceId: 'inference-tiny',
    model: 'google/gemma-3-4b-it:free',
    pricePerCallSats: 5,
    description: 'Tiny LLM (Gemma 3 4B). Fast, cheap, basic quality.',
  },
  {
    serviceId: 'inference-balanced',
    model: 'google/gemma-3-12b-it:free',
    pricePerCallSats: 30,
    description: 'Balanced LLM (Gemma 3 12B). Good for most everyday tasks.',
  },
  {
    serviceId: 'inference-coder',
    model: 'qwen/qwen3-coder:free',
    pricePerCallSats: 50,
    description: 'Code specialist (Qwen 3 Coder). Best for programming questions.',
  },
  {
    serviceId: 'inference-big',
    model: 'openai/gpt-oss-120b:free',
    pricePerCallSats: 100,
    description: 'Premium open LLM (gpt-oss 120B). Highest quality on the free tier.',
  },
]
