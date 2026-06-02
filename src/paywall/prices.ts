/**
 * peck.to overlay — fee schedule v=1
 *
 * Single source of truth for read-side fees. Imported by:
 *   - overlay HTTP middleware (fee computation + 402 generation)
 *   - peck-mcp (wrapping tool invocations in PaywallClient)
 *   - @peck/paywall-client (so clients can pre-compute drains)
 *   - peck-web (channel-funding UX previews)
 *
 * Prices are in satoshis. Flat-rate per endpoint. See
 * docs.peck.to/fetch-fees for the full policy.
 *
 * Versioning: bump PRICES_VERSION when a price changes. Overlay
 * middleware records the version alongside every drain so historical
 * audits work even if the table is updated later.
 */

export const PRICES_VERSION = 'prices_v1'

// ───────────────────────────────────────────────────────────────
// Fee table
// ───────────────────────────────────────────────────────────────

/** Flat-rate fee in sats per endpoint. 0 = always free. */
export const PRICES = {
  // ── Always free ──────────────────────────────────────────────
  peck_chain_tip:      0,
  peck_stats:          0,
  peck_apps:           0,
  peck_profile:        0,
  peck_follows:        0,
  peck_friends:        0,
  peck_balance:        0,
  peck_identity_info:  0,
  peck_fleet_list:     0,
  peck_fleet_info:     0,
  peck_post_meta:      0,
  peck_thread_meta:    0,
  peck_user_meta:      0,
  peck_media_thumb:    0,

  // ── Content fetches ──────────────────────────────────────────
  peck_feed:           20,   // Free when limit<=20 && offset=0 (see isFreeTier)
  peck_thread:         50,
  peck_post_detail:    10,
  peck_user_posts:     30,
  peck_recent:         20,
  peck_trending:       30,
  peck_search:         50,

  // ── Function + app discovery ────────────────────────────────
  peck_functions:            20,
  peck_function_check_calls: 20,

  // ── Payment + message history ───────────────────────────────
  peck_payments:  20,
  peck_messages:  30,

  // ── Chain infrastructure ────────────────────────────────────
  peck_block_at_height: 10,

  // ── Third-party app endpoints ───────────────────────────────
  peck_posts_by_media:  20,
  peck_post_raw:        30,
  peck_feed_filtered:   30,
} as const

export type PaidEndpoint = keyof typeof PRICES

// ───────────────────────────────────────────────────────────────
// Media tiers (size-based, not endpoint-based)
// ───────────────────────────────────────────────────────────────

/** Bytes → sats. Tiers from docs/services/fetch-fees.md. */
export const MEDIA_TIERS = [
  { maxBytes:      100_000, endpoint: 'peck_media_small',  fee:   20 },
  { maxBytes:    1_000_000, endpoint: 'peck_media_medium', fee:  100 },
  { maxBytes:   10_000_000, endpoint: 'peck_media_large',  fee:  500 },
  { maxBytes: Infinity,     endpoint: 'peck_media_huge',   fee: 2000 },
] as const

export function feeForMediaSize(bytes: number): number {
  for (const tier of MEDIA_TIERS) {
    if (bytes <= tier.maxBytes) return tier.fee
  }
  return MEDIA_TIERS[MEDIA_TIERS.length - 1].fee
}

// ───────────────────────────────────────────────────────────────
// Free-tier check for argument-dependent endpoints
// ───────────────────────────────────────────────────────────────

/**
 * Whether a request to `endpoint` with `args` falls under the free
 * tier. Encodes the "first 20 of feed is always free" rule: no
 * tracking, no counters, just an argument-shape check.
 *
 * Returns true when:
 *  - the endpoint's base price is 0 (always free), OR
 *  - the endpoint is peck_feed with limit<=20 && offset=0, OR
 *  - the endpoint is peck_posts_by_media with media_type="any",
 *    limit<=20, offset=0 (same shape as peck_feed).
 */
export function isFreeTier(
  endpoint: string,
  args: Record<string, unknown> = {},
): boolean {
  if (endpoint in PRICES && PRICES[endpoint as PaidEndpoint] === 0) {
    return true
  }

  if (endpoint === 'peck_feed') {
    const limit  = Number(args.limit  ?? 20)
    const offset = Number(args.offset ?? 0)
    return limit <= 20 && offset === 0
  }

  if (endpoint === 'peck_posts_by_media') {
    const limit  = Number(args.limit  ?? 20)
    const offset = Number(args.offset ?? 0)
    const mt     = String(args.media_type ?? 'any')
    return mt === 'any' && limit <= 20 && offset === 0
  }

  return false
}

// ───────────────────────────────────────────────────────────────
// Computed fee for a (endpoint, args) pair
// ───────────────────────────────────────────────────────────────

/**
 * The authoritative fee computation used by both overlay middleware
 * and client-side pre-computation. Returns 0 if the call is free
 * (either by endpoint or by argument shape).
 *
 * For media endpoints, pass the response size via `args.size_bytes`
 * — the resolver picks the appropriate tier.
 */
export function feeFor(
  endpoint: string,
  args: Record<string, unknown> = {},
): number {
  if (isFreeTier(endpoint, args)) return 0

  if (endpoint.startsWith('peck_media_')) {
    const bytes = Number(args.size_bytes ?? 0)
    return feeForMediaSize(bytes)
  }

  if (endpoint in PRICES) {
    return PRICES[endpoint as PaidEndpoint]
  }

  // Unknown endpoint — default to 0 (free) rather than charge
  // silently. Middleware should log this so unmetered endpoints
  // surface quickly.
  return 0
}

// ───────────────────────────────────────────────────────────────
// Channel + pool constants
// ───────────────────────────────────────────────────────────────

export const CHANNEL_MIN_DEPOSIT_SATS   = 1_000
export const CHANNEL_DEFAULT_EXPIRY_BLOCKS = 144   // ≈24h

export const POOL_FUND_MIN_SATS = 100   // arbitrary low floor; anyone can fund
