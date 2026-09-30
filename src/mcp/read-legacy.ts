/**
 * The /v1 readers behind the read tools, kept for two jobs:
 *
 *  1. Fallback when the overlay has no /v2 routes (see OverlayV2Unavailable in
 *     read-v2.ts): a self-hosted PECK_READER_URL on older code, or a rolled-back
 *     overlay. Their output is exactly what these tools returned before /v2.
 *  2. legacyAuthorTotals: the per-author post counts that /v2 does not serve.
 *
 * Delete the fallbacks once no supported overlay lacks /v2.
 */
import { KNOWN_CUSTODIAL_RELAYS, type AuthorTotals } from './read-v2.js'

export type LegacyGet = (path: string) => Promise<any>

/** Post and reply totals over author keys, from /v1/feed (limit=0 returns the count only). /v1 takes one author per request. */
export async function legacyAuthorTotals(get: LegacyGet, keys: string[]): Promise<AuthorTotals> {
  const counts = await Promise.all(keys.map(async (key) => {
    const author = encodeURIComponent(key)
    const [all, replies] = await Promise.all([
      get(`/v1/feed?author=${author}&limit=0`),
      get(`/v1/feed?author=${author}&type=reply&limit=0`),
    ])
    return {
      posts: parseInt(String(all?.total ?? 0), 10) || 0,
      replies: parseInt(String(replies?.total ?? 0), 10) || 0,
    }
  }))
  return counts.reduce((sum, c) => ({ posts: sum.posts + c.posts, replies: sum.replies + c.replies }), { posts: 0, replies: 0 })
}

export function legacyFeed(get: LegacyGet, args: any) {
  const p = new URLSearchParams()
  if (args?.limit) p.set('limit', String(args.limit))
  if (args?.offset) p.set('offset', String(args.offset))
  if (args?.tag) p.set('tag', String(args.tag))
  if (args?.author) p.set('author', String(args.author))
  if (args?.type) p.set('type', String(args.type))
  if (args?.app) p.set('app', String(args.app))
  if (args?.channel) p.set('channel', String(args.channel))
  if (args?.since) p.set('since', String(args.since))
  if (args?.until) p.set('until', String(args.until))
  if (args?.order) p.set('order', String(args.order))
  return get(`/v1/feed?${p}`)
}

export function legacyUserPosts(get: LegacyGet, args: any) {
  const p = new URLSearchParams()
  p.set('author', String(args.address))
  p.set('limit', String(args?.limit || 20))
  if (args?.offset) p.set('offset', String(args.offset))
  if (args?.type) p.set('type', String(args.type))
  if (args?.app) p.set('app', String(args.app))
  return get(`/v1/feed?${p}`)
}

export function legacyRecent(get: LegacyGet, args: any, now: () => number = Date.now) {
  const minRaw = Number(args?.minutes ?? 60)
  const minutes = Math.min(Math.max(minRaw, 1), 10080)  // clamp 1min..1week
  const p = new URLSearchParams()
  p.set('since', new Date(now() - minutes * 60_000).toISOString())
  p.set('limit', String(args?.limit || 20))
  p.set('order', 'desc')
  if (args?.type) p.set('type', String(args.type))
  if (args?.app) p.set('app', String(args.app))
  return get(`/v1/feed?${p}`)
}

export const legacyThread = (get: LegacyGet, txid: unknown) => get(`/v1/thread/${txid}`)
export const legacyPostDetail = (get: LegacyGet, txid: unknown) => get(`/v1/post/${txid}`)

export function legacySearch(get: LegacyGet, args: any) {
  return get(`/v1/search?q=${encodeURIComponent(String(args?.q || ''))}&limit=${args?.limit || 20}`)
}

/** The synthesized profile as it was built before /v2: aggregated from /v1/feed on the MCP side. */
export async function legacyProfile(get: LegacyGet, args: any) {
  const addr = String(args.address)
  // One call for the latest posts (display_name, apps, timestamps) and the
  // author's total; a second, type-scoped one for the reply ratio.
  const [latest, repliesOnly] = await Promise.all([
    get(`/v1/feed?author=${encodeURIComponent(addr)}&limit=100&order=desc`),
    get(`/v1/feed?author=${encodeURIComponent(addr)}&type=reply&limit=0`),
  ])
  const totalPosts = parseInt(String(latest?.total ?? 0), 10) || 0
  const totalReplies = parseInt(String(repliesOnly?.total ?? 0), 10) || 0
  const rows: any[] = latest?.data || []
  const apps = new Set<string>()
  const channels = new Set<string>()
  const displayNames = new Map<string, number>()
  let firstSeen: string | null = null
  let lastSeen: string | null = null
  for (const r of rows) {
    if (r.app) apps.add(r.app)
    if (r.channel) channels.add(r.channel)
    if (r.display_name) displayNames.set(r.display_name, (displayNames.get(r.display_name) || 0) + 1)
    const ts = r.timestamp || r.time
    if (ts) {
      if (!lastSeen || ts > lastSeen) lastSeen = ts
      if (!firstSeen || ts < firstSeen) firstSeen = ts
    }
  }
  // Pick the most-used display_name in this sample as "primary"
  let primaryDisplayName: string | null = null
  let primaryCount = 0
  for (const [name, count] of displayNames) {
    if (count > primaryCount) { primaryDisplayName = name; primaryCount = count }
  }
  const custodialRelay = KNOWN_CUSTODIAL_RELAYS[addr] || null
  return {
    address: addr,
    primary_display_name: primaryDisplayName,
    display_name_count: displayNames.size,
    total_posts: totalPosts,
    total_replies: totalReplies,
    reply_ratio: totalPosts > 0 ? +(totalReplies / totalPosts).toFixed(3) : 0,
    first_seen_in_sample: firstSeen,
    last_seen: lastSeen,
    active_apps: Array.from(apps),
    active_channels: Array.from(channels),
    is_custodial_relay: custodialRelay !== null,
    custodial_relay_name: custodialRelay,
    sample_size: rows.length,
    note: rows.length < totalPosts
      ? `first_seen_in_sample covers only the latest ${rows.length} of ${totalPosts} posts — earliest post may be older`
      : 'sample covers all posts',
  }
}
