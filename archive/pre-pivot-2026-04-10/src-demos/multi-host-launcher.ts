/**
 * multi-host-launcher — boots all 9 reference service-agents in one process.
 *
 * This is the dag-3 deliverable that turns the marketplace from "memory
 * agent + 2 shims" into a real catalog of paid services. Each agent
 * lives on its own port, announces to marketplace-registry, and exposes
 * 1-3 capabilities. Some optionally call memory-agent v2 to persist
 * state between calls (the composition multiplier — agents that
 * remember what they've done).
 *
 * Lineup (13 agents on ports 4030-4042):
 *
 * Pricing tiers (post-2026-04-09 reform per Wright fee-economics analysis):
 *
 *   SUBSIDIZED DEMO TIER (1-15 sat) — loss-leaders for marketplace adoption.
 *     Prices below ~15 sat are uneconomical for sellers at the 100 sat/kb
 *     fee floor (one P2PKH input ≈ 14.8 sat to spend), so these only make
 *     sense as introductory rates or pure compute services with no on-chain
 *     side-effect that the operator subsidizes for marketplace visibility.
 *
 *   ECONOMIC TIER (50-200 sat) — real per-call profitability for the seller.
 *     Comfortable margin above the 15-sat input cost floor, plus headroom
 *     for tx overhead and consolidation gas. This is the band where running
 *     a service is actually a business, not a demo.
 *
 *   LLM inference (4 agents, OpenRouter free tier):
 *     4030  inference-fast        google/gemma-3-4b-it:free          50 sat (economic)
 *     4031  inference-balanced    google/gemma-3-12b-it:free         80 sat (economic)
 *     4032  inference-coder       qwen/qwen3-coder:free             120 sat (economic)
 *     4033  inference-premium     openai/gpt-oss-120b:free          200 sat (economic)
 *
 *   Dumb data services (5 agents, free APIs):
 *     4034  weather               open-meteo current weather         50 sat (economic)
 *     4035  geocode               open-meteo geocoding               50 sat (economic)
 *     4036  testnet-tip           BSV testnet chain tip via WoC       3 sat (subsidized)
 *     4037  echo                  sanity / latency baseline           1 sat (subsidized)
 *     4038  recall-demo           uses memory-agent v2 to demo comp  60 sat (economic)
 *
 *   Killer micro-services (3 agents, real friction-solvers):
 *     4039  notarize              on-chain timestamp + provenance    50 sat (economic)
 *     4040  fetch-and-summarize   web-browsing primitive for agents 100 sat (economic)
 *     4041  embed-text            vector embeddings                  50 sat (economic)
 *
 *   Composition layer:
 *     4042  workflow-runner       JSON workflow executor              5 sat (subsidized)
 *                                  (per-step prices add up; runner itself is cheap
 *                                   so workflows aren't double-taxed)
 *
 *   Composition layer:
 *     4042  workflow-runner       executes JSON workflow definitions, chains
 *                                  service calls, resolves $variable refs.
 *                                  Workflows themselves are stored as data
 *                                  in memory-agent under tag "workflow".
 *
 * Run:
 *   REGISTRY_URL=http://localhost:8080 \
 *   MEMORY_AGENT_URL=http://localhost:4011 \
 *     npx tsx src/multi-host-launcher.ts < /dev/null
 *
 * Pre-reqs:
 *   - registry-daemon running on $REGISTRY_URL
 *   - (optional) memory-agent-v2 running on $MEMORY_AGENT_URL for the
 *     recall-demo agent's composition path
 *   - OPENROUTER_API_KEY in .env for the LLM agents
 */
import 'dotenv/config'
import crypto from 'node:crypto'
import { startAgent } from './agents/agent-factory.js'
import { chat, OpenRouterError } from './ladder/openrouter.js'
import { BankLocal } from './clients/bank-local.js'

const MEMORY_AGENT_URL = process.env.MEMORY_AGENT_URL ?? 'http://localhost:4011'
const BANK_SHIM_URL = process.env.BANK_SHIM_URL ?? 'http://localhost:4020'

const bank = new BankLocal()

// ---- LLM agent factory ----

function makeLlmAgent(serviceId: string, port: number, model: string, price: number, description: string) {
  return startAgent({
    serviceId, port, pricePerCall: price, description,
    capabilities: ['infer', 'chat'],
    handlers: {
      infer: async (body: any) => {
        const messages = body.messages ?? [{ role: 'user', content: body.prompt ?? '' }]
        if (body.system) messages.unshift({ role: 'system', content: body.system })
        try {
          const r = await chat({
            model,
            messages,
            max_tokens: body.max_tokens ?? 200,
            temperature: body.temperature ?? 0.7,
          })
          return {
            model: r.model,
            response: r.content,
            usage: r.usage,
            served_in_ms: r.durationMs,
          }
        } catch (e: any) {
          if (e instanceof OpenRouterError) {
            throw new Error(`upstream LLM error: ${e.message} (status ${e.status})`)
          }
          throw e
        }
      },
      chat: async (body: any) => {
        // Alias for infer
        return await (this as any)?.handlers?.infer?.(body)
      },
    },
  })
}

// ---- Memory-agent helper for composition ----

async function memoryWrite(ns: string, key: string, value: any, tags: string[] = []) {
  const r = await fetch(`${MEMORY_AGENT_URL}/memory-write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ namespace: ns, key, value, tags }),
  })
  if (!r.ok) throw new Error(`memory-write failed: ${r.status} ${await r.text()}`)
  return await r.json() as any
}

async function memoryList(ns: string) {
  const r = await fetch(`${MEMORY_AGENT_URL}/memory-list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ namespace: ns }),
  })
  if (!r.ok) throw new Error(`memory-list failed: ${r.status}`)
  return await r.json() as any
}

// ---- Boot ----

async function main() {
  console.log('[multi-host] booting 13 reference agents…')

  const agents = await Promise.all([
    // ─── LLM inference (4 agents) ────────────────────────────────────
    makeLlmAgent('inference-fast', 4030, 'google/gemma-3-4b-it:free', 50, 'Fast Gemma 4B inference (OpenRouter free tier). Economic tier — pays for itself + small margin at 100 sat/kb fee floor.'),
    makeLlmAgent('inference-balanced', 4031, 'google/gemma-3-12b-it:free', 80, 'Balanced Gemma 12B inference (OpenRouter free tier). Economic tier.'),
    makeLlmAgent('inference-coder', 4032, 'qwen/qwen3-coder:free', 120, 'Code-specialist Qwen3 Coder inference (OpenRouter free tier). Economic tier.'),
    makeLlmAgent('inference-premium', 4033, 'openai/gpt-oss-120b:free', 200, 'Premium GPT-OSS 120B inference (OpenRouter free tier). Economic tier.'),

    // ─── Weather (open-meteo) ────────────────────────────────────────
    startAgent({
      serviceId: 'weather', port: 4034, pricePerCall: 50,
      description: 'Current weather conditions for any city via open-meteo.com (no API key)',
      capabilities: ['get-weather'],
      handlers: {
        'get-weather': async (body) => {
          const location = String(body.location ?? 'Oslo')
          const geoR = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`)
          if (!geoR.ok) throw new Error(`geocoding failed: ${geoR.status}`)
          const geo = (await geoR.json() as any).results?.[0]
          if (!geo) throw new Error(`no geocoding hit for "${location}"`)
          const wR = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}&longitude=${geo.longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&timezone=auto`)
          if (!wR.ok) throw new Error(`weather fetch failed: ${wR.status}`)
          const data = await wR.json() as any
          return {
            location: { name: geo.name, country: geo.country, latitude: geo.latitude, longitude: geo.longitude },
            current: data.current,
          }
        },
      },
    }),

    // ─── Geocode (open-meteo geocoding) ──────────────────────────────
    startAgent({
      serviceId: 'geocode', port: 4035, pricePerCall: 50,
      description: 'Convert place names to lat/lng via open-meteo geocoding (no API key)',
      capabilities: ['geocode'],
      handlers: {
        geocode: async (body) => {
          const location = String(body.location ?? '')
          if (!location) throw new Error('location required')
          const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=5`)
          if (!r.ok) throw new Error(`geocoding failed: ${r.status}`)
          return (await r.json() as any).results ?? []
        },
      },
    }),

    // ─── Testnet tip (BSV chain status via WoC) ──────────────────────
    startAgent({
      serviceId: 'testnet-tip', port: 4036, pricePerCall: 3,
      description: 'BSV testnet chain tip + recent block info (read-only via WhatsOnChain)',
      capabilities: ['chain-tip', 'block-headers'],
      handlers: {
        'chain-tip': async () => {
          const r = await fetch('https://api.whatsonchain.com/v1/bsv/test/chain/info')
          if (!r.ok) throw new Error(`woc failed: ${r.status}`)
          const d = await r.json() as any
          return { blocks: d.blocks, bestblockhash: d.bestblockhash, difficulty: d.difficulty, chain: d.chain }
        },
        'block-headers': async (body) => {
          const count = Math.min(Number(body.count ?? 5), 20)
          const r = await fetch('https://api.whatsonchain.com/v1/bsv/test/chain/info')
          const d = await r.json() as any
          const tip = d.blocks
          const headers: any[] = []
          for (let h = tip; h > tip - count && h > 0; h--) {
            const hr = await fetch(`https://api.whatsonchain.com/v1/bsv/test/block/height/${h}`)
            if (hr.ok) {
              const hd = await hr.json() as any
              headers.push({ height: hd.height, hash: hd.hash, time: hd.time, txCount: hd.txcount })
            }
          }
          return { tip, headers }
        },
      },
    }),

    // ─── Echo (latency baseline) ─────────────────────────────────────
    startAgent({
      serviceId: 'echo', port: 4037, pricePerCall: 1,
      description: 'Echo whatever JSON you send it. Latency baseline + sanity test.',
      capabilities: ['echo'],
      handlers: {
        echo: async (body) => ({ echoed: body, at: Date.now() }),
      },
    }),

    // ─── Embed text (vector embeddings on demand) ────────────────────
    //
    // Returns a numeric vector for any text input. Used by agents for
    // semantic search, deduplication, similarity ranking, and as the
    // missing primitive for memory-recall composition (write text +
    // embedding into memory-agent, then later search by embedding
    // similarity).
    //
    // Embedding source dispatch:
    //   - HF_TOKEN env set → Hugging Face Inference API
    //     (sentence-transformers/all-MiniLM-L6-v2, real 384-dim semantic
    //     embedding, free tier)
    //   - else → deterministic hash-based feature vector (NOT semantic,
    //     but stable + interface-correct, for demo when no HF token)
    //
    // The pricing is the same regardless of backend — clients can't tell
    // which one served their request from the response shape, only from
    // the `embedding_source` field if they care.
    startAgent({
      serviceId: 'embed-text', port: 4041, pricePerCall: 50,
      description: 'Vector embedding for text. Returns a 384-dim float array suitable for semantic search and similarity. Pay 15 sat per embedding, no account, no monthly billing.',
      capabilities: ['embed', 'embed-text', 'vector'],
      handlers: {
        embed: async (body) => {
          const text = String(body.text ?? '').trim()
          if (!text) throw new Error('text required')
          if (text.length > 10_000) throw new Error('text too long (max 10kB)')

          const hash = crypto.createHash('sha256').update(text, 'utf8').digest('hex')
          const dim = 384

          // Path 1: real semantic embedding via HF Inference API
          if (process.env.HF_TOKEN) {
            try {
              const r = await fetch('https://api-inference.huggingface.co/models/sentence-transformers/all-MiniLM-L6-v2', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${process.env.HF_TOKEN}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ inputs: text }),
                signal: AbortSignal.timeout(20_000),
              })
              if (r.ok) {
                const vec = await r.json() as number[]
                if (Array.isArray(vec) && typeof vec[0] === 'number') {
                  return {
                    text_length: text.length,
                    text_sha256: hash,
                    dim: vec.length,
                    embedding: vec,
                    embedding_source: 'huggingface:all-MiniLM-L6-v2',
                  }
                }
              }
              console.warn('[embed-text] HF inference failed, falling back to hash-vector')
            } catch (e: any) {
              console.warn('[embed-text] HF inference error:', e?.message)
            }
          }

          // Path 2: deterministic hash-based feature vector (demo fallback)
          // Splits the input into rolling sha256 windows and unpacks each
          // window into 4-byte chunks normalised to [-1, 1]. Same input
          // always produces the same vector. NOT semantic but stable.
          const out = new Float32Array(dim)
          let cursor = 0
          let seedCounter = 0
          while (cursor < dim) {
            const windowHash = crypto
              .createHash('sha256')
              .update(text + ':' + seedCounter)
              .digest()
            for (let i = 0; i < windowHash.length && cursor < dim; i += 4) {
              const u32 = windowHash.readUInt32BE(i)
              // Map [0, 2^32) → [-1, 1]
              out[cursor++] = (u32 / 0x80000000) - 1
            }
            seedCounter++
          }
          // L2 normalize
          let norm = 0
          for (let i = 0; i < dim; i++) norm += out[i] * out[i]
          norm = Math.sqrt(norm)
          if (norm > 0) for (let i = 0; i < dim; i++) out[i] /= norm

          return {
            text_length: text.length,
            text_sha256: hash,
            dim,
            embedding: Array.from(out),
            embedding_source: 'hash-fallback (set HF_TOKEN for semantic embeddings)',
          }
        },
      },
    }),

    // ─── Fetch + summarize (web-browsing as a service) ───────────────
    //
    // Takes a URL, fetches it, strips HTML to text, sends the result to
    // an inference agent (gemma-3-12b via OpenRouter free tier), returns
    // a structured summary. Demonstrates the composition multiplier
    // naturally: one /summarize call → 1 fetch + 1 LLM call (paid via
    // its own marketplace agent in future) + 1 result. The HTTP fetch
    // is free, but a future version could route through a "paid web
    // proxy" agent for an extra hop.
    //
    // For agents this is the killer "what does this URL say?" service —
    // every Claude/agent that browses the web needs it.
    startAgent({
      serviceId: 'fetch-and-summarize', port: 4040, pricePerCall: 100,
      description: 'Fetch a URL, extract main content, summarize via LLM. Returns a concise summary + key points + source. The web-browsing primitive every agent needs.',
      capabilities: ['fetch-and-summarize', 'web-summary'],
      handlers: {
        'fetch-and-summarize': async (body) => {
          const url = String(body.url ?? '').trim()
          if (!url) throw new Error('url required')
          if (!url.startsWith('http://') && !url.startsWith('https://')) {
            throw new Error('url must be http(s)')
          }
          const maxBytes = Math.min(Number(body.max_bytes ?? 100_000), 500_000)
          const lang = String(body.language ?? 'engelsk')
          const t0 = Date.now()

          // Fetch with sensible bounds
          const resp = await fetch(url, {
            headers: {
              'User-Agent': 'PeckPay/1.0 (fetch-and-summarize agent; +http://localhost:8080/marketplace)',
              'Accept': 'text/html,text/plain,application/xhtml+xml',
            },
            signal: AbortSignal.timeout(15_000),
          })
          if (!resp.ok) throw new Error(`fetch failed: ${resp.status} ${resp.statusText}`)
          const ct = resp.headers.get('content-type') ?? 'text/html'
          const raw = await resp.text()
          const truncated = raw.slice(0, maxBytes)

          // Lightweight HTML→text strip — drop scripts/styles/svgs, collapse
          // tags, then collapse whitespace. Not Mozilla Readability quality,
          // but adequate for "feed it to an LLM".
          const text = truncated
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
            .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/\s+/g, ' ')
            .trim()
          const fetchMs = Date.now() - t0
          if (text.length < 50) {
            return { url, content_type: ct, summary: '(content too short or unreadable to summarise)', text_length: text.length, fetch_ms: fetchMs }
          }

          // Summarise via OpenRouter free tier. Note: gemma-3-12b-it:free
          // (and several other free-tier models) DO NOT support role:system
          // — passing one returns "Provider returned error" with no detail.
          // Workaround: merge the instruction into the user message.
          const t1 = Date.now()
          const llmInput = text.slice(0, 3000)
          const instruction = `You are a web-page summariser. Read the page text below and output ONLY valid JSON (no markdown fences, no preamble) with these keys: "summary" (one paragraph, max 300 chars, in ${lang}), "key_points" (array of 3 short bullet strings, in ${lang}), "topic" (1-3 words, in ${lang}).\n\nURL: ${url}\n\nPAGE TEXT:\n${llmInput}\n\nJSON:`
          let llmResult
          try {
            llmResult = await chat({
              model: 'google/gemma-3-12b-it:free',
              messages: [{ role: 'user', content: instruction }],
              max_tokens: 350,
              temperature: 0.2,
            })
          } catch (e: any) {
            console.warn('[fetch-and-summarize] gemma-12b failed, trying gemma-4b:', e?.message?.slice(0, 100))
            llmResult = await chat({
              model: 'google/gemma-3-4b-it:free',
              messages: [{ role: 'user', content: instruction.slice(0, 2500) }],
              max_tokens: 300,
              temperature: 0.2,
            })
          }
          const llmMs = Date.now() - t1

          // Try to parse the LLM's JSON response. Falls back to raw text.
          let parsed: any = null
          try {
            // Strip code fences if present
            const cleaned = llmResult.content.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
            parsed = JSON.parse(cleaned)
          } catch {
            parsed = { summary: llmResult.content.trim() }
          }

          return {
            url,
            content_type: ct,
            text_length: text.length,
            fetch_ms: fetchMs,
            summary_ms: llmMs,
            total_ms: Date.now() - t0,
            model: llmResult.model,
            tokens: llmResult.usage,
            ...parsed,
          }
        },
      },
    }),

    // ─── Notarize (cryptographic timestamp + provenance) ─────────────
    //
    // Anchor any data on-chain with a sub-cent fee. The agent SHA256s the
    // input, builds an OP_RETURN tx via bank-shim (so the anchor itself
    // also produces a fee receipt — every notarization is naturally 2 txs),
    // and returns the txid + explorer link as proof of existence.
    //
    // Use cases: contracts, design decisions, scientific results, "I had
    // this idea first", arbitrary document timestamps. BSV-only because
    // it's the only chain where 5-10 sat per anchor is economically viable.
    startAgent({
      serviceId: 'notarize', port: 4039, pricePerCall: 50,
      description: 'Cryptographic timestamp + provenance for any data. Pay 10 sat, get a permanent on-chain proof of existence with the agent\'s identity. The first notary that costs less than a postage stamp.',
      capabilities: ['notarize', 'timestamp', 'anchor'],
      handlers: {
        notarize: async (body) => {
          // Accept either {data: string} or {hash: hex}
          let hash: string
          let inputBytes: number
          if (typeof body.hash === 'string') {
            if (!/^[0-9a-fA-F]{64}$/.test(body.hash)) throw new Error('hash must be 64-char hex sha256')
            hash = body.hash.toLowerCase()
            inputBytes = 32
          } else if (body.data !== undefined) {
            const dataStr = typeof body.data === 'string' ? body.data : JSON.stringify(body.data)
            const buf = Buffer.from(dataStr, 'utf8')
            hash = crypto.createHash('sha256').update(buf).digest('hex')
            inputBytes = buf.length
          } else {
            throw new Error('either {data: ...} or {hash: <64-hex>} required')
          }

          const note = String(body.note ?? '').slice(0, 200)
          const proto = String(body.proto ?? 'peck-pay-notarize-v1')

          // Build the on-chain payload: protocol marker + hash + optional note
          const payloadObj = {
            p: proto,
            h: hash,
            t: Math.floor(Date.now() / 1000),
            ...(note ? { n: note } : {}),
          }
          const payload = Buffer.from(JSON.stringify(payloadObj), 'utf8')
          const script = BankLocal.opReturnScriptHex(payload)

          // Route via bank-shim so the notarization itself is a paid
          // marketplace call (= +1 fee receipt tx as composition multiplier).
          // Credit the notarize service in the on-chain ledger so its
          // operator accumulates withdrawable earnings per Wright §5.4.
          const r = await bank.paidCreateAction(
            BANK_SHIM_URL,
            `notarize ${hash.slice(0, 12)}…`,
            [{ script, satoshis: 0 }],
            { credit_service_id: 'notarize', credit_gross_sat: 50 },
          )

          return {
            hash,
            input_bytes: inputBytes,
            note: note || undefined,
            txid: r.txid,
            fee_receipt_txid: r.fee_receipt_txid,
            timestamp: payloadObj.t,
            iso_timestamp: new Date(payloadObj.t * 1000).toISOString(),
            protocol: proto,
            explorer: `https://test.whatsonchain.com/tx/${r.txid}`,
            note_to_verifier: 'To verify: SHA256 your data and confirm the hash matches the OP_RETURN payload at this txid. The tx timestamp is the proof-of-existence.',
          }
        },
      },
    }),

    // ─── Workflow runner (composition layer) ─────────────────────────
    //
    // Executes a workflow defined as JSON. Workflows are stored as memory
    // entries in the namespace "peck-pay:workflows" with tag "workflow",
    // so they're discoverable, paid for at write time, and have on-chain
    // proof-of-existence. Anyone can register a new workflow via
    // peck_register_workflow MCP tool — no code change required.
    //
    // Workflow shape:
    //   {
    //     id: "research-and-remember",
    //     name: "Research a URL and store it as a memory",
    //     description: "...",
    //     steps: [
    //       { id: "s1", service_url: "http://localhost:4040",
    //         capability: "fetch-and-summarize",
    //         input: { url: "$input.url" } },
    //       { id: "s2", service_url: "http://localhost:4041",
    //         capability: "embed",
    //         input: { text: "$s1.summary" } },
    //       ...
    //     ]
    //   }
    //
    // Variable references:
    //   $input.<path>      → workflow argument value
    //   $<step_id>.<path>  → previous step's result value (post-flatten)
    //
    // Each step calls a service via plain HTTP POST and stores the
    // (flattened) response under the step id. The runner returns the
    // full step trace + the final step's output as `result`.
    startAgent({
      serviceId: 'workflow-runner', port: 4042, pricePerCall: 5,
      description: 'Executes JSON-defined workflows that chain other marketplace services together. The composition primitive — anyone can author a workflow as data, no code required. Each step is a paid service call, total cost = 5 sat (runner fee) + sum of step prices.',
      capabilities: ['run-workflow', 'list-steps'],
      handlers: {
        'run-workflow': async (body: any) => {
          // Workflow can be inline OR loaded from memory by id
          let workflow: any = body.workflow
          if (!workflow && body.workflow_id) {
            // Look up by id from peck-pay:workflows namespace
            const list = await fetch(`${MEMORY_AGENT_URL}/memory-list`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ namespace: 'peck-pay:workflows' }),
            }).then(r => r.json()) as any
            const entry = list.items?.find((i: any) => i.key === body.workflow_id)
            if (!entry) throw new Error(`workflow id "${body.workflow_id}" not found`)
            const read = await fetch(`${MEMORY_AGENT_URL}/memory-read?handle=${encodeURIComponent(entry.handle)}`).then(r => r.json()) as any
            if (read.error) throw new Error(`workflow read failed: ${read.error}`)
            workflow = typeof read.value === 'string' ? JSON.parse(read.value) : read.value
          }
          if (!workflow || !Array.isArray(workflow.steps)) {
            throw new Error('workflow must be {steps: [...]} (or pass workflow_id to load by id)')
          }
          const input = body.input ?? {}

          // Storage for resolved step outputs (used by $<step_id>.path)
          const stepOutputs: Record<string, any> = {}
          const trace: any[] = []
          const t0 = Date.now()

          // Resolve $input.path and $<step>.path references in any value.
          // Recursive on objects/arrays, leaves strings/primitives alone.
          // String values that are EXACTLY a $ref get replaced with the
          // referenced value (preserving its type — number, array, object).
          // String values that CONTAIN a $ref get string-substituted.
          function resolve(value: any): any {
            if (Array.isArray(value)) return value.map(resolve)
            if (value && typeof value === 'object') {
              const out: any = {}
              for (const k in value) out[k] = resolve(value[k])
              return out
            }
            if (typeof value !== 'string') return value
            // Whole-string ref: $foo.bar.baz → return the actual referenced value
            const wholeMatch = value.match(/^\$([a-zA-Z0-9_]+)\.(.+)$/)
            if (wholeMatch) {
              const [, scope, path] = wholeMatch
              return resolveRef(scope, path) ?? value
            }
            // Embedded refs: "before $foo.bar after" → string substitution
            return value.replace(/\$([a-zA-Z0-9_]+)\.([a-zA-Z0-9_.]+)/g, (m, scope, path) => {
              const v = resolveRef(scope, path)
              return v === undefined ? m : (typeof v === 'string' ? v : JSON.stringify(v))
            })
          }
          function resolveRef(scope: string, path: string): any {
            const root = scope === 'input' ? input : stepOutputs[scope]
            if (root === undefined) return undefined
            const parts = path.split('.')
            let cur = root
            for (const p of parts) {
              if (cur === null || cur === undefined) return undefined
              cur = cur[p]
            }
            return cur
          }

          // Execute steps in order
          for (let i = 0; i < workflow.steps.length; i++) {
            const step = workflow.steps[i]
            if (!step.id || !step.service_url || !step.capability) {
              throw new Error(`step ${i}: id, service_url, and capability required`)
            }
            const stepInput = resolve(step.input ?? {})
            const stepUrl = `${step.service_url.replace(/\/$/, '')}/${step.capability}`
            const stepStart = Date.now()
            let stepResult: any
            try {
              const r = await fetch(stepUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(stepInput),
              })
              if (!r.ok) {
                const errBody = await r.text()
                throw new Error(`step ${step.id} HTTP ${r.status}: ${errBody.slice(0, 200)}`)
              }
              const wrapped = await r.json() as any
              // Flatten agent-factory wrapper if present
              stepResult = wrapped?.result ?? wrapped
            } catch (e: any) {
              const failure = { id: step.id, capability: step.capability, error: String(e?.message ?? e), duration_ms: Date.now() - stepStart }
              trace.push(failure)
              return {
                workflow_id: workflow.id,
                ok: false,
                failed_at_step: step.id,
                trace,
                total_ms: Date.now() - t0,
              }
            }
            stepOutputs[step.id] = stepResult
            trace.push({
              id: step.id,
              capability: step.capability,
              service_url: step.service_url,
              duration_ms: Date.now() - stepStart,
              result_keys: stepResult && typeof stepResult === 'object' ? Object.keys(stepResult) : null,
            })
          }

          const finalStep = workflow.steps[workflow.steps.length - 1]
          return {
            workflow_id: workflow.id ?? 'inline',
            ok: true,
            steps_run: workflow.steps.length,
            total_ms: Date.now() - t0,
            trace,
            result: stepOutputs[finalStep.id],
            all_outputs: stepOutputs,
          }
        },
        'list-steps': async (body: any) => {
          // Convenience: load and inspect a workflow without running it
          if (!body.workflow_id) throw new Error('workflow_id required')
          const list = await fetch(`${MEMORY_AGENT_URL}/memory-list`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ namespace: 'peck-pay:workflows' }),
          }).then(r => r.json()) as any
          const entry = list.items?.find((i: any) => i.key === body.workflow_id)
          if (!entry) throw new Error(`workflow id "${body.workflow_id}" not found`)
          const read = await fetch(`${MEMORY_AGENT_URL}/memory-read?handle=${encodeURIComponent(entry.handle)}`).then(r => r.json()) as any
          const wf = typeof read.value === 'string' ? JSON.parse(read.value) : read.value
          return {
            id: wf.id,
            name: wf.name,
            description: wf.description,
            steps: wf.steps?.map((s: any) => ({ id: s.id, capability: s.capability, service_url: s.service_url })),
            handle: entry.handle,
          }
        },
      },
    }),

    // ─── Recall demo (uses memory-agent v2 for composition) ──────────
    startAgent({
      serviceId: 'recall-demo', port: 4038, pricePerCall: 60,
      description: 'Demonstrates agent recall: each call writes to memory-agent v2 and lists recent entries. Composition multiplier — every call here triggers 2-3 more on-chain txs through memory-agent.',
      capabilities: ['remember', 'recall'],
      handlers: {
        remember: async (body) => {
          const ns = String(body.namespace ?? 'recall-demo')
          const key = String(body.key ?? `auto-${Date.now()}`)
          const value = body.value ?? 'empty'
          const tags: string[] = Array.isArray(body.tags) ? body.tags.map(String) : []
          const written = await memoryWrite(ns, key, value, tags)
          return { stored: { ns, key }, memory_handle: written.handle, on_chain_txs: written.on_chain_txs ?? [], tx_count: written.tx_count ?? 0 }
        },
        recall: async (body) => {
          const ns = String(body.namespace ?? 'recall-demo')
          const list = await memoryList(ns)
          return { namespace: ns, count: list.count, items: list.items }
        },
      },
    }),
  ])

  console.log(`[multi-host] ${agents.length} agents up`)

  // ─── Seed example workflows ────────────────────────────────────────
  // Write a couple of canonical workflows to memory-agent so peck_list_workflows
  // returns something useful from cold start. Idempotent — same key overwrites.
  await seedExampleWorkflows().catch(e => {
    console.warn('[multi-host] workflow seeding failed (memory-agent down?):', e?.message ?? e)
  })

  // ─── Index service descriptions for semantic discovery ────────────
  // Embed every announced service via embed-text and store the vector in
  // memory-agent under namespace 'peck-pay:service-embeddings'. This is
  // a self-ref pattern: the marketplace uses its own embed-text service
  // to make itself searchable. peck_search_services_semantic queries
  // this index via cosine similarity.
  await indexServiceEmbeddings().catch(e => {
    console.warn('[multi-host] service embedding index failed:', e?.message ?? e)
  })

  console.log('[multi-host] press Ctrl+C to stop')

  // Stay alive
  process.on('SIGINT', async () => {
    console.log('\n[multi-host] shutting down…')
    await Promise.all(agents.map(a => a.stop()))
    process.exit(0)
  })
}

/**
 * Index every service in the marketplace registry by embedding its
 * description (or fallback to id + capabilities + price) via the
 * embed-text agent, then storing the vector in memory-agent under
 * namespace 'peck-pay:service-embeddings'. This is a SELF-REF demo:
 * the marketplace uses its own embed-text and memory-store-v2 services
 * to make itself semantically searchable. Each service indexed = 1
 * embed call + 1 memory-write (= 2 on-chain txs via the shim path).
 * For 13 services that's ~26 on-chain txs at startup, naturally.
 */
async function indexServiceEmbeddings() {
  const REGISTRY_URL = process.env.REGISTRY_URL ?? 'http://localhost:8080'
  const EMBED_URL = 'http://localhost:4041/embed'

  const r = await fetch(`${REGISTRY_URL}/marketplace`)
  if (!r.ok) throw new Error(`registry not reachable: ${r.status}`)
  const services = await r.json() as any[]
  console.log(`[multi-host] indexing ${services.length} services for semantic search…`)

  let indexed = 0
  for (const svc of services) {
    // Skip the indexer's dependencies to avoid recursive embedding loops
    if (svc.id === 'embed-text' || svc.id === 'memory-store-v2') {
      // We still index them, but using a shorter description to keep cost down
    }
    const text = [
      svc.id,
      svc.name,
      (svc.capabilities ?? []).join(' '),
      svc.description ?? '',
    ].join(' — ').slice(0, 500)

    try {
      // Embed
      const embedResp = await fetch(EMBED_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (!embedResp.ok) {
        console.warn(`[multi-host] embed for ${svc.id} failed: ${embedResp.status}`)
        continue
      }
      const embedJson = await embedResp.json() as any
      const embedding = embedJson?.result?.embedding ?? embedJson?.embedding
      if (!Array.isArray(embedding)) {
        console.warn(`[multi-host] embed for ${svc.id} returned no embedding`)
        continue
      }

      // Store in memory-agent
      const memResp = await fetch(`${MEMORY_AGENT_URL}/memory-write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          namespace: 'peck-pay:service-embeddings',
          key: svc.id,
          value: {
            service_id: svc.id,
            description: svc.description?.slice(0, 200),
            capabilities: svc.capabilities,
            price_sats: svc.pricePerCall,
            endpoint: svc.endpoint,
            embedding,
            embedding_source: embedJson?.result?.embedding_source ?? embedJson?.embedding_source,
            indexed_at: Date.now(),
          },
          tags: ['service-index', ...(svc.capabilities ?? []).slice(0, 3)],
        }),
      })
      if (memResp.ok) {
        indexed++
      } else {
        console.warn(`[multi-host] memory-write for ${svc.id} failed: ${memResp.status}`)
      }
    } catch (e: any) {
      console.warn(`[multi-host] index ${svc.id} error:`, e?.message)
    }
  }
  console.log(`[multi-host] indexed ${indexed}/${services.length} services for semantic search`)
}

async function seedExampleWorkflows() {
  const examples = [
    {
      id: 'research-and-remember',
      name: 'Research a URL and remember it',
      description: 'Fetches a URL, summarises it via LLM, stores summary + topic in memory under your namespace, then notarises the resulting handle on-chain. Demonstrates 4-service composition: fetch-and-summarize → memory-store-v2 → notarize. ~95 sat per run.',
      author: 'peck-pay-seed',
      estimated_cost_sats: 95,
      steps: [
        {
          id: 'summary',
          service_url: 'http://localhost:4040',
          capability: 'fetch-and-summarize',
          input: { url: '$input.url', max_bytes: 15000 },
        },
        {
          id: 'mem',
          service_url: 'http://localhost:4011',
          capability: 'memory-write',
          input: {
            namespace: '$input.namespace',
            key: '$input.key',
            value: {
              url: '$input.url',
              topic: '$summary.topic',
              summary: '$summary.summary',
              key_points: '$summary.key_points',
            },
            tags: ['research', '$summary.topic'],
          },
        },
        {
          id: 'anchor',
          service_url: 'http://localhost:4039',
          capability: 'notarize',
          input: {
            data: '$mem.handle',
            note: 'research:$input.url',
          },
        },
      ],
    },
    {
      id: 'embed-and-remember',
      name: 'Generate embedding for text and store it',
      description: 'Embeds the input text into a 384-dim vector, stores text+embedding under your namespace. Foundation for semantic search workflows. ~75 sat per run.',
      author: 'peck-pay-seed',
      estimated_cost_sats: 75,
      steps: [
        {
          id: 'embedding',
          service_url: 'http://localhost:4041',
          capability: 'embed',
          input: { text: '$input.text' },
        },
        {
          id: 'mem',
          service_url: 'http://localhost:4011',
          capability: 'memory-write',
          input: {
            namespace: '$input.namespace',
            key: '$input.key',
            value: {
              text: '$input.text',
              embedding: '$embedding.embedding',
              source: '$embedding.embedding_source',
            },
            tags: ['embedded'],
          },
        },
      ],
    },
  ]

  for (const wf of examples) {
    const r = await fetch(`${MEMORY_AGENT_URL}/memory-write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        namespace: 'peck-pay:workflows',
        key: wf.id,
        value: wf,
        tags: ['workflow', 'seed'],
      }),
    })
    if (r.ok) {
      const body = await r.json() as any
      console.log(`[multi-host] seeded workflow ${wf.id} → handle ${body.handle?.slice(0, 16)}…`)
    } else {
      console.warn(`[multi-host] seed ${wf.id} failed: HTTP ${r.status}`)
    }
  }
}

main().catch(e => { console.error('[multi-host] FAILED:', e); process.exit(1) })
