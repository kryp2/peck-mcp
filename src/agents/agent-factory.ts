/**
 * Generic micro-agent factory.
 *
 * Boots a small HTTP service-agent on a given port with:
 *   - GET /health        — service info + announced caps + price
 *   - GET /stats         — call counters + uptime
 *   - POST /<capability> — one route per declared capability, dispatches
 *                           to a handler function
 *
 * On startup it announces itself to the marketplace-registry. No payment
 * verification or auth (hackathon scope) — clients are trusted to have
 * paid via bank-shim before calling. Each handler can OPTIONALLY call
 * memory-agent v2 to persist state between invocations, which gives the
 * "agent recall" composition multiplier.
 *
 * The reason for a factory: dag-3 requires N reference agents (4 LLM +
 * 5 dumb data services). Without a shared shape we'd be copy-pasting 9
 * near-identical HTTP servers. With this, each is ~20 lines of config.
 */
import { createServer, IncomingMessage, ServerResponse } from 'http'

export interface AgentHandlerContext {
  agentId: string
  capability: string
}

export type AgentHandler = (body: any, ctx: AgentHandlerContext) => Promise<any> | any

export interface AgentConfig {
  serviceId: string
  port: number
  description: string
  capabilities: string[]
  /** Map capability → handler. Capabilities listed here MUST exist as keys. */
  handlers: Record<string, AgentHandler>
  pricePerCall: number
  identityKey?: string
  registryUrl?: string
  announceToRegistry?: boolean
}

export interface RunningAgent {
  config: AgentConfig
  stats: { calls: number; errors: number; started_at: number }
  stop: () => Promise<void>
}

function jsonResponse(res: ServerResponse, status: number, body: any) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', c => data += c)
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}

export async function startAgent(cfg: AgentConfig): Promise<RunningAgent> {
  const stats = { calls: 0, errors: 0, started_at: Date.now() }
  const registryUrl = cfg.registryUrl ?? process.env.REGISTRY_URL ?? 'http://localhost:8080'
  const announce = cfg.announceToRegistry !== false

  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')

    try {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
        return jsonResponse(res, 200, {
          service_id: cfg.serviceId,
          description: cfg.description,
          capabilities: cfg.capabilities,
          price_per_call_sats: cfg.pricePerCall,
          port: cfg.port,
          uptime_ms: Date.now() - stats.started_at,
        })
      }

      if (req.method === 'GET' && req.url?.startsWith('/stats')) {
        return jsonResponse(res, 200, { ...stats, uptime_ms: Date.now() - stats.started_at })
      }

      // Match POST /<capability>
      if (req.method === 'POST' && req.url) {
        const cap = req.url.replace(/^\//, '').split('?')[0]
        if (cap in cfg.handlers) {
          const body = await readJsonBody(req)
          try {
            const result = await cfg.handlers[cap](body, { agentId: cfg.serviceId, capability: cap })
            stats.calls++
            return jsonResponse(res, 200, {
              service_id: cfg.serviceId,
              capability: cap,
              price_paid_sats: cfg.pricePerCall,
              result,
            })
          } catch (e: any) {
            stats.errors++
            return jsonResponse(res, 500, { error: 'handler_failed', detail: String(e?.message ?? e) })
          }
        }
      }

      return jsonResponse(res, 404, { error: 'not_found', path: req.url, capabilities: cfg.capabilities })
    } catch (e: any) {
      stats.errors++
      return jsonResponse(res, 500, { error: 'internal', detail: String(e?.message ?? e) })
    }
  })

  await new Promise<void>(resolve => server.listen(cfg.port, () => resolve()))
  console.log(`[${cfg.serviceId}] listening on http://localhost:${cfg.port}  caps=[${cfg.capabilities.join(',')}]  price=${cfg.pricePerCall}sat`)

  if (announce) {
    try {
      const r = await fetch(`${registryUrl}/announce`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: cfg.serviceId,
          name: cfg.serviceId,
          identityKey: cfg.identityKey ?? '00'.repeat(33),
          endpoint: `http://localhost:${cfg.port}`,
          capabilities: cfg.capabilities,
          pricePerCall: cfg.pricePerCall,
          paymentAddress: '',
          description: cfg.description,
        }),
      })
      if (r.ok) console.log(`[${cfg.serviceId}] announced to ${registryUrl}`)
      else console.log(`[${cfg.serviceId}] announce HTTP ${r.status}`)
    } catch (e: any) {
      console.log(`[${cfg.serviceId}] announce skipped: ${e?.message ?? e}`)
    }
  }

  return {
    config: cfg,
    stats,
    stop: async () => { await new Promise<void>(r => server.close(() => r())) },
  }
}
