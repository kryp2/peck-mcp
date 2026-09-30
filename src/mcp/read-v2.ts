/**
 * Read tools on the overlay's /v2 read model (peck-view/v1).
 *
 * /v2 hydrates every post once on the overlay: the same author name, handle
 * and picture, counts, media, parent stub and embedded ref that peck.to shows
 * a person. The tools below return those objects as they are, so an agent and
 * a person looking at the same txid see the same thing.
 *
 * Each function takes a `V2Get` (see createV2Get) so tests can drive it
 * without a network. When an overlay has no /v2 routes at all (a self-hosted
 * PECK_READER_URL on older code, or a rolled-back overlay) createV2Get throws
 * OverlayV2Unavailable and the caller falls back to the /v1 readers in
 * read-legacy.ts.
 */
import type { AuthorView, FeedPage, PostView, ProfileView, ThreadView } from './peck-view.js'

export const V2_MAX_LIMIT = 100
export const V2_DEFAULT_LIMIT = 20
/**
 * /v2 pages by keyset, not offset. The legacy `offset` argument is served by
 * walking pages up to this many rows deep; beyond it callers must send the
 * `next` cursor back instead.
 */
export const MAX_OFFSET_ROWS = 1000
const REQUEST_TIMEOUT_MS = 30_000
/** /v2/feed accepts at most this many comma-separated authors. */
const MAX_AUTHORS = 20

export interface V2ErrorBody {
  error: { code: string; message: string }
}

export interface V2Response {
  status: number
  body: unknown
}

export type V2Get = (path: string) => Promise<V2Response>

/** The overlay answered like a server that has no /v2 routes. */
export class OverlayV2Unavailable extends Error {}

/** Bad tool input, reported to the caller in the /v2 error shape. */
class InputError extends Error {}

export function isV2Error(body: unknown): body is V2ErrorBody {
  const e = (body as { error?: unknown } | null)?.error
  return !!e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string'
}

const v2Error = (code: string, message: string): V2ErrorBody => ({ error: { code, message } })

/**
 * GET against the overlay. Returns the parsed JSON with its status, including
 * /v2 error bodies ({error:{code,message}}) so tools can pass them on. A
 * response that is not a /v2 body and says "no such route" (404, 405, 501)
 * means the overlay predates /v2: OverlayV2Unavailable. Network failures and
 * timeouts throw as they always did.
 */
export function createV2Get(baseUrl: string, fetchImpl: typeof fetch = fetch): V2Get {
  return async (path) => {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await res.text()
    let body: unknown
    try { body = JSON.parse(text) } catch { body = undefined }
    if (body === undefined || (!res.ok && !isV2Error(body))) {
      if (res.status === 404 || res.status === 405 || res.status === 501) {
        throw new OverlayV2Unavailable(`overlay has no ${path.split('?')[0]} route (HTTP ${res.status})`)
      }
      return { status: res.status, body: v2Error('upstream_error', `overlay answered HTTP ${res.status} with an unexpected body`) }
    }
    return { status: res.status, body }
  }
}

// ─── input mapping ────────────────────────────────────────────────────────

const CURSOR_KEY = /^(before|after)_[a-z0-9_]+$/

export function clampLimit(value: unknown, fallback = V2_DEFAULT_LIMIT): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(n, V2_MAX_LIMIT)
}

/**
 * The `cursor` argument is the `next` object a previous page returned. Some
 * MCP clients hand objects over as JSON text, so a string is parsed too.
 * Returns the query parameters to send back unchanged, or null for no cursor.
 */
export function parseCursor(value: unknown): Record<string, string> | null {
  if (value === undefined || value === null || value === '') return null
  let obj: unknown = value
  if (typeof value === 'string') {
    try { obj = JSON.parse(value) } catch { throw new InputError('cursor must be the `next` object of a previous page (or its JSON text)') }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new InputError('cursor must be the `next` object of a previous page (or its JSON text)')
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!CURSOR_KEY.test(k) || (typeof v !== 'string' && typeof v !== 'number')) {
      throw new InputError(`cursor key ${JSON.stringify(k)} is not a /v2 cursor key; send back the \`next\` object exactly as returned`)
    }
    out[k] = String(v)
  }
  return Object.keys(out).length ? out : null
}

/** Tool arguments → /v2/feed query. `offset` is not part of it (see readFeedPage). */
export function feedParams(args: Record<string, unknown> | undefined): URLSearchParams {
  const a = args ?? {}
  const p = new URLSearchParams()
  if (a.limit !== undefined && a.limit !== null && a.limit !== '') p.set('limit', String(clampLimit(a.limit)))
  for (const key of ['tag', 'author', 'type', 'app', 'channel', 'since', 'until', 'order'] as const) {
    const v = a[key]
    if (v !== undefined && v !== null && v !== '') p.set(key, String(v))
  }
  const cursor = parseCursor(a.cursor)
  if (cursor) for (const [k, v] of Object.entries(cursor)) p.set(k, v)
  return p
}

const isFeedPage = (b: unknown): b is FeedPage => Array.isArray((b as FeedPage | null)?.items)

/**
 * One page of /v2/feed for `params`, skipping `offset` rows first. Offset
 * exists only for callers written against /v1: the overlay has no offset, so
 * the skipped rows are fetched page by page (each request sized so the last
 * one ends exactly on the requested page, which keeps `next` valid).
 */
export async function readFeedPage(get: V2Get, params: URLSearchParams, offset: number): Promise<FeedPage | V2ErrorBody> {
  const want = clampLimit(params.get('limit'))
  const skip = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
  if (skip === 0) {
    params.set('limit', String(want))
    const r = await get(`/v2/feed?${params}`)
    return isFeedPage(r.body) ? r.body : (isV2Error(r.body) ? r.body : v2Error('upstream_error', 'unexpected /v2/feed response'))
  }
  if (skip + want > MAX_OFFSET_ROWS) {
    return v2Error('bad_request', `offset + limit may be at most ${MAX_OFFSET_ROWS}; page with \`cursor\` (the \`next\` of the previous page) instead of offset`)
  }
  const need = skip + want
  const items: PostView[] = []
  const page = new URLSearchParams(params)
  let next: FeedPage['next'] = null
  while (items.length < need) {
    page.set('limit', String(Math.min(V2_MAX_LIMIT, need - items.length)))
    const r = await get(`/v2/feed?${page}`)
    if (!isFeedPage(r.body)) return isV2Error(r.body) ? r.body : v2Error('upstream_error', 'unexpected /v2/feed response')
    items.push(...r.body.items)
    next = r.body.next
    if (!next) break
    for (const [k, v] of Object.entries(next)) page.set(k, String(v))
  }
  return { items: items.slice(skip, need), next: items.length >= need ? next : null }
}

/** Runs a reader, turning bad tool input into a /v2-shaped error instead of a throw. */
async function guarded<T>(fn: () => Promise<T>): Promise<T | V2ErrorBody> {
  try { return await fn() } catch (e) {
    if (e instanceof InputError) return v2Error('bad_request', e.message)
    throw e
  }
}

// ─── the read tools ───────────────────────────────────────────────────────

/** peck_feed → GET /v2/feed. Returns a FeedPage: { items, next }. */
export function readFeed(get: V2Get, args: Record<string, unknown> | undefined) {
  return guarded(() => readFeedPage(get, feedParams(args), Number(args?.offset ?? 0)))
}

/** peck_recent → GET /v2/feed?since=now-N minutes, newest first. */
export function readRecent(get: V2Get, args: Record<string, unknown> | undefined, now: () => number = Date.now) {
  const raw = Number(args?.minutes ?? 60)
  const minutes = Math.min(Math.max(Number.isFinite(raw) ? raw : 60, 1), 10080)
  const since = new Date(now() - minutes * 60_000).toISOString()
  return guarded(() => readFeedPage(get, feedParams({
    type: args?.type, app: args?.app, cursor: args?.cursor,
    limit: args?.limit || V2_DEFAULT_LIMIT, since, order: 'desc',
  }), 0))
}

const ADDRESS = /^[13mn][1-9A-HJ-NP-Za-km-z]{25,34}$/
const PUBKEY = /^0[23][0-9a-fA-F]{64}$/
/** True for a base58 address or a compressed public key (not a handle). */
export const looksLikeKey = (s: string): boolean => ADDRESS.test(s) || PUBKEY.test(s)

const profilePath = (key: string) => `/v2/profile/${encodeURIComponent(key)}`

/**
 * peck_user_posts → GET /v2/profile/:key for the identity's keys, then
 * GET /v2/feed?author=<keys>. `address` may be an address, a public key or a
 * handle; posts signed by any key bound to that identity are included, as on
 * peck.to. Returns { author, keys, items, next }.
 */
export async function readUserPosts(get: V2Get, args: Record<string, unknown> | undefined) {
  const address = String(args?.address ?? '').trim()
  if (!address) return { error: 'address required' }
  return guarded(async () => {
    const prof = await get(profilePath(address))
    let author: AuthorView | null = null
    let keys: string[]
    if (isV2Error(prof.body)) {
      // An unknown or unreadable key can still have posts under exactly that key.
      if (!looksLikeKey(address)) return prof.body
      keys = [address]
    } else {
      const view = prof.body as ProfileView
      author = view.author
      keys = Array.from(new Set([address, ...view.keys].filter((k) => looksLikeKey(k)))).slice(0, MAX_AUTHORS)
      if (!keys.length) keys = [view.author.key]
    }
    const page = await readFeedPage(get, feedParams({
      type: args?.type, app: args?.app, cursor: args?.cursor,
      limit: args?.limit || V2_DEFAULT_LIMIT, author: keys.join(','),
    }), Number(args?.offset ?? 0))
    if (isV2Error(page)) return page
    return { author, keys, items: page.items, next: page.next }
  })
}

/** peck_thread → GET /v2/post/:txid. Returns a ThreadView. */
export async function readThread(get: V2Get, txid: unknown): Promise<ThreadView | V2ErrorBody | { error: string }> {
  const id = String(txid ?? '').trim()
  if (!id) return { error: 'txid required' }
  const r = await get(`/v2/post/${encodeURIComponent(id)}`)
  return r.body as ThreadView | V2ErrorBody
}

/**
 * peck_post_detail → GET /v2/post/:txid, without the replies (those are
 * peck_thread's job; counts.replies says how many there are). Returns
 * { post, parent }.
 */
export async function readPostDetail(get: V2Get, txid: unknown) {
  const view = await readThread(get, txid)
  if ('error' in view) return view
  return { post: view.post, parent: view.parent }
}

/** peck_search → GET /v2/search. One page of best matches; `next` is always null. */
export async function readSearch(get: V2Get, args: Record<string, unknown> | undefined): Promise<FeedPage | V2ErrorBody> {
  const p = new URLSearchParams()
  p.set('q', String(args?.q ?? ''))
  p.set('limit', String(clampLimit(args?.limit)))
  const r = await get(`/v2/search?${p}`)
  return r.body as FeedPage | V2ErrorBody
}

// ─── peck_profile ─────────────────────────────────────────────────────────

/** Post totals over a set of author keys. /v2 has no count by design, so the caller supplies them from /v1. */
export interface AuthorTotals {
  posts: number
  replies: number
}

/** Most keys of one identity whose totals are counted (each costs two /v1 count queries). */
export const MAX_TOTAL_KEYS = 8

export interface ProfileSummary {
  address: string
  primary_display_name: string | null
  display_name_count: number
  total_posts: number | null
  total_replies: number | null
  reply_ratio: number | null
  first_seen_in_sample: string | null
  last_seen: string | null
  active_apps: string[]
  active_channels: string[]
  is_custodial_relay: boolean
  custodial_relay_name: string | null
  sample_size: number
  /** The keys the totals and the sample cover: every key of the identity (capped), or just the one asked for. */
  keys_counted: string[]
  note: string
  /** The overlay's ProfileView (identity, bio, keys, follower counts); null when the key is unknown to it. */
  profile: ProfileView | null
  totals_error?: string
}

/** Known custodial relays, used only when the overlay's own answer is missing. */
export const KNOWN_CUSTODIAL_RELAYS: Record<string, string> = {
  '14aqJ2hMtENYJVCJaekcrqi12fiZJzoWGK': 'treechat.io',
}

/**
 * Pure: a profile summary from a sample of the author's latest posts, their
 * totals and the overlay's ProfileView. Field names are the ones peck_profile
 * has always returned; `profile` is new.
 */
export function summarizeProfile(input: {
  address: string
  keys: string[]
  sample: PostView[]
  totals: AuthorTotals | null
  totalsError?: string
  profile: ProfileView | null
}): ProfileSummary {
  const { address, keys, sample, totals, profile } = input
  const apps = new Set<string>()
  const channels = new Set<string>()
  const names = new Map<string, number>()
  let firstSeen: string | null = null
  let lastSeen: string | null = null
  for (const p of sample) {
    if (p.app) apps.add(p.app)
    if (p.channel) channels.add(p.channel)
    const name = p.provenance?.nameInTx
    if (name) names.set(name, (names.get(name) || 0) + 1)
    const ts = p.createdAt
    if (ts) {
      if (!lastSeen || ts > lastSeen) lastSeen = ts
      if (!firstSeen || ts < firstSeen) firstSeen = ts
    }
  }
  let primary: string | null = null
  let primaryCount = 0
  for (const [name, count] of names) if (count > primaryCount) { primary = name; primaryCount = count }
  // No name written into any sampled post: the overlay's resolved name, unless it is only the shortened key.
  if (primary === null && profile && profile.author.nameSource !== 'key') primary = profile.author.displayName
  const relay = profile?.author.custodialRelay ?? KNOWN_CUSTODIAL_RELAYS[address] ?? null
  const totalPosts = totals ? totals.posts : null
  const out: ProfileSummary = {
    address,
    primary_display_name: primary,
    display_name_count: names.size,
    total_posts: totalPosts,
    total_replies: totals ? totals.replies : null,
    reply_ratio: totals ? (totals.posts > 0 ? +(totals.replies / totals.posts).toFixed(3) : 0) : null,
    first_seen_in_sample: firstSeen,
    last_seen: lastSeen,
    active_apps: Array.from(apps),
    active_channels: Array.from(channels),
    is_custodial_relay: relay !== null,
    custodial_relay_name: relay,
    sample_size: sample.length,
    keys_counted: keys,
    note: totalPosts !== null && sample.length < totalPosts
      ? `first_seen_in_sample covers only the latest ${sample.length} of ${totalPosts} posts — earliest post may be older`
      : totalPosts === null ? 'total_posts is unavailable; first_seen_in_sample covers only the latest posts' : 'sample covers all posts',
    profile,
  }
  if (input.totalsError) out.totals_error = input.totalsError
  return out
}

/**
 * peck_profile → GET /v2/profile/:key (identity, bio, keys, follower counts)
 * + GET /v2/feed?author=<keys>&limit=100 (activity sample). An identity signs
 * with more than one key, so the sample and the totals cover all of them (up to
 * MAX_TOTAL_KEYS), like the profile page on peck.to. Post totals have no /v2
 * equivalent yet and come from `totals` (the /v1 counts).
 */
export async function readProfile(
  get: V2Get,
  args: Record<string, unknown> | undefined,
  totals: (keys: string[]) => Promise<AuthorTotals>,
) {
  const input = String(args?.address ?? '').trim()
  if (!input) return { error: 'address required' }
  const r = await get(profilePath(input))
  let profile: ProfileView | null = null
  let address = input
  let keys = [input]
  if (isV2Error(r.body)) {
    // A key the overlay has never seen can still be summarized from its own posts; a handle cannot.
    if (!looksLikeKey(input)) return r.body
  } else {
    profile = r.body as ProfileView
    if (!looksLikeKey(input)) address = profile.author.key
    keys = Array.from(new Set([address, ...profile.keys].filter((k) => looksLikeKey(k)))).slice(0, MAX_TOTAL_KEYS)
  }
  const [page, t] = await Promise.all([
    get(`/v2/feed?${new URLSearchParams({ author: keys.join(','), limit: String(V2_MAX_LIMIT) })}`),
    totals(keys).then((v) => ({ totals: v, error: undefined as string | undefined }))
      .catch((e: any) => ({ totals: null, error: String(e?.message || e) })),
  ])
  const sample = isFeedPage(page.body) ? page.body.items : []
  return summarizeProfile({ address, keys, sample, totals: t.totals, totalsError: t.error, profile })
}
