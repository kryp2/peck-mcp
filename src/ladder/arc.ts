/**
 * Direct ARC broadcast helpers — no wallet-toolbox in the loop.
 *
 * Supports both TAAL (with API key) and GorillaPool (no key). When both
 * are configured, requests round-robin across them to double effective
 * throughput and route around per-endpoint throttling.
 *
 * Node 18+ fetch (undici) reuses sockets per host by default, so we get
 * HTTP keep-alive for free without managing agents ourselves.
 */
import 'dotenv/config'

const ARC_ENDPOINTS = {
  taal: {
    test: 'https://arc-test.taal.com',
    main: 'https://arc.taal.com',
  },
  gorillapool: {
    test: 'https://arc-test.gorillapool.io',
    main: 'https://arc.gorillapool.io',
  },
  // ARCADE — BSVA's Teranode-backed accelerated broadcast network.
  // ARC-protocol compatible (same JSON shape, same error model linking to
  // bitcoin-sv.github.io/arc), but with simpler routes (`/tx` instead of
  // `/v1/tx`) and faster confirmation via direct P2P propagation to
  // Teranode peers.
  //
  // Status as of 2026-04-09 (BSVA dev community feedback): "pretty new,
  // stand by on stability". So we use it as PRIMARY but always fall back
  // to standard ARC (TAAL/GorillaPool) on failure.
  //
  // Endpoints:
  //   arcade-us-1           — mainnet
  //   arcade-testnet-us-1   — testnet
  //   arcade-ttn-us-1       — Teranode network (experimental)
  arcade: {
    test: 'https://arcade-testnet-us-1.bsvb.tech',
    main: 'https://arcade-us-1.bsvb.tech',
  },
}

export type Network = 'test' | 'main'

export interface BroadcastResult {
  txid: string
  status: number
  alreadyKnown: boolean
  endpoint: string
}

interface EndpointConfig {
  name: string
  url: string
  apiKey?: string
  /** Path under url for tx broadcast. ARC standard: `/v1/tx`. ARCADE: `/tx`. */
  txPath?: string
  /** If true, this endpoint is treated as PRIMARY — try first, fall back on error. */
  primary?: boolean
}

// Build the active endpoint pool once at module load.
function buildPool(network: Network): EndpointConfig[] {
  const pool: EndpointConfig[] = []

  // ARCADE — Teranode P2P-backed broadcast bridge. ARC-compatible HTTP API
  // but a SEPARATE mempool from legacy ARC (TAAL/GorillaPool). Discovered
  // 2026-04-09: ARCADE rejects any tx whose parent UTXOs aren't already in
  // its Teranode view (error 467). Since all our existing wallets were
  // funded through TAAL (legacy testnet), ARCADE can't process our chain.
  //
  // It's still wired in here as an OPT-IN primary so that a future wallet
  // funded directly through Teranode (or our mainnet wallet on Apr 15)
  // could bypass the failover cost. Set ARCADE_ENABLED=1 to enable.
  if (process.env.ARCADE_ENABLED === '1') {
    pool.push({
      name: 'ARCADE',
      url: ARC_ENDPOINTS.arcade[network],
      txPath: '/tx',
      primary: true,
    })
  }

  const taalKey = network === 'test'
    ? process.env.TAAL_TESTNET_KEY
    : process.env.TAAL_MAINNET_KEY
  if (taalKey) {
    pool.push({
      name: 'TAAL',
      url: ARC_ENDPOINTS.taal[network],
      apiKey: taalKey,
      txPath: '/v1/tx',
    })
  }
  // GorillaPool only has a public mainnet ARC endpoint — arc-test.gorillapool.io
  // does not exist (DNS NXDOMAIN). On testnet, TAAL is the only option.
  if (network === 'main') {
    pool.push({
      name: 'GorillaPool',
      url: ARC_ENDPOINTS.gorillapool[network],
      txPath: '/v1/tx',
    })
  }
  if (pool.length === 0) {
    throw new Error(
      `no ARC endpoints configured for ${network} — set TAAL_${network.toUpperCase()}NET_KEY in .env (or unset ARCADE_DISABLED)`
    )
  }
  return pool
}

// Lazy pool construction — defer until first arcBroadcast call so that
// modules importing this file can load even when no ARC keys are
// configured (e.g. peck-mcp running with new bank-local-only stack
// that never broadcasts directly).
const POOLS: Record<Network, EndpointConfig[] | null> = {
  test: null,
  main: null,
}
function getPool(network: Network): EndpointConfig[] {
  if (POOLS[network] === null) {
    POOLS[network] = buildPool(network)
  }
  return POOLS[network]!
}

let rrCursor = 0
function pickFallbackEndpoint(network: Network, exclude: string): EndpointConfig | undefined {
  const pool = getPool(network).filter(e => e.name !== exclude)
  if (pool.length === 0) return undefined
  return pool[rrCursor++ % pool.length]
}

async function tryBroadcast(ep: EndpointConfig, rawHex: string): Promise<BroadcastResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (ep.apiKey) headers['Authorization'] = `Bearer ${ep.apiKey}`
  const path = ep.txPath ?? '/v1/tx'

  const r = await fetch(`${ep.url}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ rawTx: rawHex }),
  })
  const data = await r.json().catch(() => ({})) as any

  const detail = String(data.detail || data.title || '').toLowerCase()
  const alreadyKnown =
    (detail.includes('already in mempool') ||
     detail.includes('already mined') ||
     detail.includes('already known')) &&
    !detail.includes('spent')

  if (!r.ok && !alreadyKnown) {
    throw new Error(`ARC ${ep.name} ${r.status}: ${JSON.stringify(data).slice(0, 400)}`)
  }
  if (!data.txid && !alreadyKnown) {
    throw new Error(`ARC ${ep.name} ${r.status} returned no txid: ${JSON.stringify(data).slice(0, 400)}`)
  }
  return { txid: data.txid, status: r.status, alreadyKnown, endpoint: ep.name }
}

/**
 * Broadcast a single tx. Tries the PRIMARY endpoint first (ARCADE if
 * available), falls back to standard ARC pool (TAAL/GorillaPool) on any
 * error. The fallback path means ARCADE's beta-stage instability never
 * blocks the hot path — worst case we add ~50ms to first-byte latency
 * for the failover.
 */
export async function arcBroadcast(
  rawHex: string,
  network: Network = 'test',
): Promise<BroadcastResult> {
  const pool = getPool(network)
  const primary = pool.find(e => e.primary)
  const tried: string[] = []
  let lastErr: unknown = null

  if (primary) {
    try {
      return await tryBroadcast(primary, rawHex)
    } catch (e: any) {
      tried.push(primary.name)
      lastErr = e
      // ARCADE-specific transient errors are common during the beta period.
      // Don't log every failure to avoid spam — only on final fallback.
    }
  }

  // Fallback pool: everything except primary, round-robined.
  const fallbacks = pool.filter(e => !e.primary)
  for (const ep of fallbacks) {
    try {
      const result = await tryBroadcast(ep, rawHex)
      if (tried.length > 0) {
        // Only log when we actually had to fall back, so happy path stays quiet.
        console.log(`[arc] ARCADE failed (${String(lastErr).slice(0, 120)}); fell back to ${ep.name}`)
      }
      return result
    } catch (e: any) {
      tried.push(ep.name)
      lastErr = e
    }
  }
  throw new Error(`all ARC endpoints failed [${tried.join(', ')}]: ${String(lastErr).slice(0, 400)}`)
}

/**
 * Broadcast many txs concurrently with a hard concurrency cap, returning
 * results in the same order. Failures are captured per-tx, not thrown — the
 * caller decides whether to retry.
 */
export async function arcBroadcastMany(
  rawHexes: string[],
  network: Network = 'test',
  concurrency = 10,
): Promise<Array<{ ok: true; result: BroadcastResult } | { ok: false; error: string }>> {
  const results: Array<any> = new Array(rawHexes.length)
  let cursor = 0

  async function worker() {
    while (true) {
      const i = cursor++
      if (i >= rawHexes.length) return
      try {
        results[i] = { ok: true, result: await arcBroadcast(rawHexes[i], network) }
      } catch (e: any) {
        results[i] = { ok: false, error: String(e?.message || e) }
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return results
}

export function arcEndpointInfo(network: Network = 'test'): string {
  const pool = getPool(network)
  return pool.map(e => `${e.name}${e.apiKey ? '(key)' : ''}`).join(' + ')
}
