import { describe, it, expect } from 'vitest'
import {
  MAX_OFFSET_ROWS, MAX_TOTAL_KEYS, OverlayV2Unavailable, clampLimit, createV2Get, feedParams, looksLikeKey, parseCursor,
  readFeed, readPostDetail, readProfile, readRecent, readSearch, readThread, readUserPosts, summarizeProfile,
  type V2Get, type V2Response,
} from './read-v2.js'
import { legacyAuthorTotals, legacyFeed, legacyRecent } from './read-legacy.js'
import type { AuthorView, PostView, ProfileView } from './peck-view.js'

const ADDR = '1FC9jmEWP67k2A1rYG9A1pLB4L5EibuhA1'
const PUB = '02ed41e68a8f0b36811aa61c6857bb1765fb0993172ff6ea5ee94e01fb0644a3d1'
const txid = (n: number) => n.toString(16).padStart(64, '0')

const author = (over: Partial<AuthorView> = {}): AuthorView => ({
  key: ADDR, address: ADDR, identityKey: PUB, handle: 'ada', displayName: 'Ada', nameSource: 'identity',
  avatarUrl: null, avatarRef: null, avatarSource: null,
  generatedAvatarUrl: `https://peck.to/avatar/${ADDR}?seed=${ADDR}`,
  paymail: null, custodialRelay: null, external: null, ...over,
})

const post = (n: number, over: Partial<PostView> = {}): PostView => ({
  txid: txid(n), type: 'post', kind: null, app: 'peck.to', author: author(),
  createdAt: `2026-09-30T08:${String(59 - (n % 60)).padStart(2, '0')}:00Z`, blockHeight: null,
  text: `post ${n}`, mediaType: 'text/plain', textTruncated: false, textLength: 6, media: [], tags: [], channel: null,
  geo: null, parentTxid: null, threadRootTxid: null, parent: null, refTxid: null, refKind: null, ref: null,
  counts: { likes: 0, replies: 0, reposts: 0, quotes: 0, tipSats: 0, lockedSats: 0, powBits: 0 },
  provenance: { grade: 'key', aipVerified: true, nameInTx: null }, paywalled: false, ...over,
})

const profileView = (over: Partial<ProfileView> = {}): ProfileView => ({
  author: author(), bio: 'Building on BSV.', profileOutpoint: null, keys: [PUB, ADDR],
  counts: { followers: 12, following: 3 }, ...over,
})

const notFound = (): V2Response => ({ status: 404, body: { error: { code: 'not_found', message: 'nope' } } })

/**
 * A fake overlay: `feed` holds every post, newest first, and /v2/feed pages
 * over it with before_ts/before_txid cursors, the way the real one does.
 */
function fakeOverlay(feed: PostView[], extra: Record<string, V2Response> = {}) {
  const calls: string[] = []
  const get: V2Get = async (path) => {
    calls.push(path)
    const [route, qs = ''] = path.split('?')
    if (extra[route]) return extra[route]
    const q = new URLSearchParams(qs)
    if (route === '/v2/feed') {
      const limit = Number(q.get('limit') ?? 20)
      const before = q.get('before_txid')
      let start = 0
      if (before) start = feed.findIndex((p) => p.txid === before) + 1
      const items = feed.slice(start, start + limit)
      const last = items[items.length - 1]
      const next = items.length === limit && last ? { before_ts: last.createdAt, before_txid: last.txid } : null
      return { status: 200, body: { items, next } }
    }
    return notFound()
  }
  return { get, calls }
}

const many = (n: number) => Array.from({ length: n }, (_, i) => post(i + 1))

describe('feedParams', () => {
  it('maps the peck_feed arguments onto /v2/feed', () => {
    const p = feedParams({
      limit: 50, tag: 'peck', author: ADDR, type: 'post', app: 'peck.to', channel: 'dev',
      since: '2026-09-01', until: '2026-09-30', order: 'asc',
    })
    expect(Object.fromEntries(p)).toEqual({
      limit: '50', tag: 'peck', author: ADDR, type: 'post', app: 'peck.to', channel: 'dev',
      since: '2026-09-01', until: '2026-09-30', order: 'asc',
    })
  })
  it('clamps limit to 1..100 and drops empty arguments', () => {
    expect(feedParams({ limit: 500 }).get('limit')).toBe('100')
    expect(feedParams({ limit: 0 }).get('limit')).toBe('20')
    expect(feedParams({ limit: '' }).has('limit')).toBe(false)
    expect(feedParams({ limit: 2.7 }).get('limit')).toBe('2')
    expect(feedParams({ tag: '', app: undefined, offset: 40 }).toString()).toBe('')
  })
  it('never forwards offset (/v2 has none and would ignore it silently)', () => {
    expect(feedParams({ offset: 10 }).has('offset')).toBe(false)
  })
  it('sends the cursor back as query parameters, object or JSON text', () => {
    const next = { before_ts: '2026-09-30T09:53:51Z', before_txid: txid(7) }
    expect(Object.fromEntries(feedParams({ cursor: next }))).toEqual(next)
    expect(Object.fromEntries(feedParams({ cursor: JSON.stringify(next) }))).toEqual(next)
    const ranked = { before_score: 1.5, before_score2: 3, before_ts: '2026-09-30T09:53:51Z', before_txid: txid(7) }
    expect(feedParams({ cursor: ranked }).get('before_score')).toBe('1.5')
  })
})

describe('parseCursor', () => {
  it('accepts only /v2 cursor keys', () => {
    expect(() => parseCursor({ limit: '5' })).toThrow(/not a \/v2 cursor key/)
    expect(() => parseCursor({ before_ts: { nested: 1 } })).toThrow()
    expect(() => parseCursor('not json')).toThrow(/next/)
    expect(() => parseCursor([1])).toThrow(/next/)
    expect(parseCursor(undefined)).toBeNull()
    expect(parseCursor({})).toBeNull()
  })
})

describe('clampLimit', () => {
  it('falls back for junk and caps at 100', () => {
    expect(clampLimit(undefined)).toBe(20)
    expect(clampLimit('abc')).toBe(20)
    expect(clampLimit(-3)).toBe(20)
    expect(clampLimit(1000)).toBe(100)
    expect(clampLimit('7')).toBe(7)
  })
})

describe('readFeed', () => {
  it('returns the /v2 FeedPage unchanged: items and next', async () => {
    const { get, calls } = fakeOverlay(many(30))
    const page: any = await readFeed(get, { limit: 5, app: 'peck.to' })
    expect(calls).toEqual(['/v2/feed?limit=5&app=peck.to'])
    expect(page.items).toHaveLength(5)
    expect(page.items[0].author.displayName).toBe('Ada')
    expect(page.next).toEqual({ before_ts: page.items[4].createdAt, before_txid: txid(5) })
  })

  it('pages with the returned cursor', async () => {
    const { get } = fakeOverlay(many(30))
    const first: any = await readFeed(get, { limit: 10 })
    const second: any = await readFeed(get, { limit: 10, cursor: first.next })
    expect(second.items.map((p: PostView) => p.txid)).toEqual(many(30).slice(10, 20).map((p) => p.txid))
  })

  it('serves the legacy offset by walking pages, and next continues after the page', async () => {
    const all = many(300)
    const { get, calls } = fakeOverlay(all)
    const page: any = await readFeed(get, { offset: 120, limit: 10 })
    expect(page.items.map((p: PostView) => p.txid)).toEqual(all.slice(120, 130).map((p) => p.txid))
    // 130 rows needed: a page of 100, then a page of 30 that ends exactly on the requested page.
    expect(calls).toHaveLength(2)
    expect(new URLSearchParams(calls[0].split('?')[1]).get('limit')).toBe('100')
    expect(new URLSearchParams(calls[1].split('?')[1]).get('limit')).toBe('30')
    const after: any = await readFeed(get, { limit: 10, cursor: page.next })
    expect(after.items[0].txid).toBe(all[130].txid)
  })

  it('offset past the end of the feed gives an empty page', async () => {
    const { get } = fakeOverlay(many(15))
    const page: any = await readFeed(get, { offset: 50, limit: 10 })
    expect(page).toEqual({ items: [], next: null })
  })

  it('refuses offsets that would need more than the cap, telling the caller to use cursor', async () => {
    const { get, calls } = fakeOverlay(many(5))
    const r: any = await readFeed(get, { offset: MAX_OFFSET_ROWS, limit: 20 })
    expect(r.error.code).toBe('bad_request')
    expect(r.error.message).toMatch(/cursor/)
    expect(calls).toHaveLength(0)
  })

  it('reports a bad cursor as a /v2-shaped error instead of throwing', async () => {
    const { get, calls } = fakeOverlay(many(5))
    const r: any = await readFeed(get, { cursor: { offset: 5 } })
    expect(r.error.code).toBe('bad_request')
    expect(calls).toHaveLength(0)
  })

  it('passes /v2 errors on', async () => {
    const get: V2Get = async () => ({ status: 400, body: { error: { code: 'bad_request', message: 'limit must be an integer 1–100' } } })
    const r: any = await readFeed(get, { order: 'sideways' })
    expect(r.error.code).toBe('bad_request')
  })
})

describe('readRecent', () => {
  it('asks /v2/feed for the window, newest first', async () => {
    const { get, calls } = fakeOverlay(many(3))
    const now = Date.parse('2026-09-30T10:00:00Z')
    await readRecent(get, { minutes: 30, limit: 5, type: 'post', app: 'peck.to' }, () => now)
    const q = new URLSearchParams(calls[0].split('?')[1])
    expect(calls[0].startsWith('/v2/feed?')).toBe(true)
    expect(q.get('since')).toBe('2026-09-30T09:30:00.000Z')
    expect(q.get('order')).toBe('desc')
    expect(q.get('limit')).toBe('5')
    expect(q.get('type')).toBe('post')
    expect(q.get('app')).toBe('peck.to')
  })
  it('clamps the window to 1 minute .. 1 week', async () => {
    const now = Date.parse('2026-09-30T10:00:00Z')
    const a = fakeOverlay([]); await readRecent(a.get, { minutes: 999999 }, () => now)
    expect(new URLSearchParams(a.calls[0].split('?')[1]).get('since')).toBe('2026-09-23T10:00:00.000Z')
    const b = fakeOverlay([]); await readRecent(b.get, { minutes: 0 }, () => now)
    expect(new URLSearchParams(b.calls[0].split('?')[1]).get('since')).toBe('2026-09-30T09:59:00.000Z')
  })
})

describe('readUserPosts', () => {
  it('feeds every key of the identity into one author filter', async () => {
    const { get, calls } = fakeOverlay(many(3), { [`/v2/profile/${ADDR}`]: { status: 200, body: profileView() } })
    const r: any = await readUserPosts(get, { address: ADDR, limit: 5 })
    const feedCall = new URLSearchParams(calls[1].split('?')[1])
    expect(feedCall.get('author')).toBe(`${ADDR},${PUB}`)
    expect(r.author.handle).toBe('ada')
    expect(r.keys).toEqual([ADDR, PUB])
    expect(r.items).toHaveLength(3)
    expect('next' in r).toBe(true)
  })

  it('resolves a handle through the profile', async () => {
    const { get, calls } = fakeOverlay(many(2), { '/v2/profile/%40ada': { status: 200, body: profileView() } })
    const r: any = await readUserPosts(get, { address: '@ada' })
    expect(new URLSearchParams(calls[1].split('?')[1]).get('author')).toBe(`${PUB},${ADDR}`)
    expect(r.items).toHaveLength(2)
  })

  it('an unknown handle is the overlay error', async () => {
    const { get, calls } = fakeOverlay([], { '/v2/profile/nobody': notFound() })
    const r: any = await readUserPosts(get, { address: 'nobody' })
    expect(r.error.code).toBe('not_found')
    expect(calls).toHaveLength(1)
  })

  it('a key the profile lookup does not know still gets its own posts', async () => {
    const { get, calls } = fakeOverlay(many(2), { [`/v2/profile/${ADDR}`]: notFound() })
    const r: any = await readUserPosts(get, { address: ADDR })
    expect(new URLSearchParams(calls[1].split('?')[1]).get('author')).toBe(ADDR)
    expect(r.author).toBeNull()
    expect(r.keys).toEqual([ADDR])
  })

  it('passes type, app, limit and cursor through', async () => {
    const { get, calls } = fakeOverlay(many(50), { [`/v2/profile/${ADDR}`]: { status: 200, body: profileView() } })
    const cursor = { before_ts: '2026-09-30T08:00:00Z', before_txid: txid(9) }
    await readUserPosts(get, { address: ADDR, type: 'reply', app: 'peck.to', limit: 7, cursor })
    const q = new URLSearchParams(calls[1].split('?')[1])
    expect(q.get('type')).toBe('reply')
    expect(q.get('app')).toBe('peck.to')
    expect(q.get('limit')).toBe('7')
    expect(q.get('before_txid')).toBe(txid(9))
  })

  it('requires an address', async () => {
    const { get } = fakeOverlay([])
    expect(await readUserPosts(get, {})).toEqual({ error: 'address required' })
  })
})

describe('readThread / readPostDetail', () => {
  const view = {
    post: post(2, { parentTxid: txid(1), counts: { likes: 0, replies: 1, reposts: 0, quotes: 0, tipSats: 0, lockedSats: 0, powBits: 0 } }),
    parent: post(1), replies: [post(3, { parentTxid: txid(2) })], repliesTruncated: false,
  }
  it('thread returns the ThreadView as is', async () => {
    const calls: string[] = []
    const get: V2Get = async (p) => { calls.push(p); return { status: 200, body: view } }
    expect(await readThread(get, txid(2))).toEqual(view)
    expect(calls).toEqual([`/v2/post/${txid(2)}`])
  })
  it('post detail is the post and its parent, without the replies', async () => {
    const get: V2Get = async () => ({ status: 200, body: view })
    const r: any = await readPostDetail(get, txid(2))
    expect(Object.keys(r)).toEqual(['post', 'parent'])
    expect(r.post.txid).toBe(txid(2))
    expect(r.parent.txid).toBe(txid(1))
  })
  it('an unindexed post is the overlay not_found error', async () => {
    const get: V2Get = async () => notFound()
    expect(((await readPostDetail(get, txid(9))) as any).error.code).toBe('not_found')
    expect(((await readThread(get, txid(9))) as any).error.code).toBe('not_found')
  })
  it('requires a txid and does not call the overlay without one', async () => {
    const get: V2Get = async () => { throw new Error('must not be called') }
    expect(await readThread(get, undefined)).toEqual({ error: 'txid required' })
    expect(await readPostDetail(get, '  ')).toEqual({ error: 'txid required' })
  })
})

describe('readSearch', () => {
  it('maps q and a clamped limit onto /v2/search', async () => {
    const calls: string[] = []
    const get: V2Get = async (p) => { calls.push(p); return { status: 200, body: { items: [], next: null } } }
    await readSearch(get, { q: 'bit coin', limit: 500 })
    expect(calls).toEqual(['/v2/search?q=bit+coin&limit=100'])
    await readSearch(get, { q: 'x' })
    expect(calls[1]).toBe('/v2/search?q=x&limit=20')
  })
})

describe('readProfile', () => {
  const totals = async () => ({ posts: 40, replies: 10 })
  const sample = [
    post(1, { app: 'peck.to', channel: 'dev', provenance: { grade: 'key', aipVerified: true, nameInTx: 'Ada' } }),
    post(2, { app: 'peck.agents', provenance: { grade: 'key', aipVerified: true, nameInTx: 'Ada' } }),
    post(3, { app: 'peck.to', provenance: { grade: 'key', aipVerified: true, nameInTx: 'A.' } }),
  ]

  it('keeps the fields peck_profile always had and adds the overlay profile', async () => {
    const { get, calls } = fakeOverlay(sample, { [`/v2/profile/${ADDR}`]: { status: 200, body: profileView() } })
    const r: any = await readProfile(get, { address: ADDR }, totals)
    expect(r).toMatchObject({
      address: ADDR, primary_display_name: 'Ada', display_name_count: 2,
      total_posts: 40, total_replies: 10, reply_ratio: 0.25, sample_size: 3,
      active_apps: ['peck.to', 'peck.agents'], active_channels: ['dev'],
      is_custodial_relay: false, custodial_relay_name: null,
    })
    expect(r.note).toMatch(/only the latest 3 of 40/)
    expect(r.profile.bio).toBe('Building on BSV.')
    expect(r.profile.counts).toEqual({ followers: 12, following: 3 })
    expect(r.profile.author.handle).toBe('ada')
    expect(calls).toHaveLength(2)
  })

  it('covers every key of the identity in the sample and the totals', async () => {
    const { get, calls } = fakeOverlay(sample, { [`/v2/profile/${ADDR}`]: { status: 200, body: profileView() } })
    let counted: string[] = []
    const r: any = await readProfile(get, { address: ADDR }, async (keys) => { counted = keys; return { posts: 3, replies: 0 } })
    expect(counted).toEqual([ADDR, PUB])
    expect(r.keys_counted).toEqual([ADDR, PUB])
    const q = new URLSearchParams(calls[1].split('?')[1])
    expect(q.get('author')).toBe(`${ADDR},${PUB}`)
    expect(q.get('limit')).toBe('100')
  })

  it('caps the keys counted', async () => {
    const keys = Array.from({ length: 12 }, (_, i) => `02${i.toString(16).padStart(64, '0')}`)
    const { get } = fakeOverlay([], { [`/v2/profile/${ADDR}`]: { status: 200, body: profileView({ keys }) } })
    let counted: string[] = []
    await readProfile(get, { address: ADDR }, async (k) => { counted = k; return { posts: 0, replies: 0 } })
    expect(counted).toHaveLength(MAX_TOTAL_KEYS)
    expect(counted[0]).toBe(ADDR)
  })

  it('a handle is resolved to its identity first', async () => {
    const { get, calls } = fakeOverlay(sample, { '/v2/profile/%40ada': { status: 200, body: profileView() } })
    const r: any = await readProfile(get, { address: '@ada' }, totals)
    expect(r.address).toBe(ADDR)
    expect(new URLSearchParams(calls[1].split('?')[1]).get('author')).toBe(`${ADDR},${PUB}`)
  })

  it('an unclaimed handle is the overlay error', async () => {
    const { get } = fakeOverlay([], { '/v2/profile/nobody': notFound() })
    expect(((await readProfile(get, { address: 'nobody' }, totals)) as any).error.code).toBe('not_found')
  })

  it('a key the overlay does not know still gets the activity summary, with profile null', async () => {
    const { get } = fakeOverlay([], { [`/v2/profile/${ADDR}`]: notFound() })
    const r: any = await readProfile(get, { address: ADDR }, async () => ({ posts: 0, replies: 0 }))
    expect(r.profile).toBeNull()
    expect(r.keys_counted).toEqual([ADDR])
    expect(r).toMatchObject({ total_posts: 0, reply_ratio: 0, sample_size: 0, note: 'sample covers all posts' })
  })

  it('failing totals do not sink the profile, and say so', async () => {
    const { get } = fakeOverlay(sample, { [`/v2/profile/${ADDR}`]: { status: 200, body: profileView() } })
    const r: any = await readProfile(get, { address: ADDR }, async () => { throw new Error('v1 down') })
    expect(r.total_posts).toBeNull()
    expect(r.reply_ratio).toBeNull()
    expect(r.totals_error).toBe('v1 down')
    expect(r.profile.author.handle).toBe('ada')
  })
})

describe('summarizeProfile', () => {
  it('flags custodial relays from the overlay, else from the known list', () => {
    const relay = profileView({ author: author({ custodialRelay: 'treechat.io' }) })
    expect(summarizeProfile({ address: ADDR, keys: [ADDR], sample: [], totals: null, profile: relay }).custodial_relay_name).toBe('treechat.io')
    const known = '14aqJ2hMtENYJVCJaekcrqi12fiZJzoWGK'
    const s = summarizeProfile({ address: known, keys: [known], sample: [], totals: null, profile: null })
    expect(s.is_custodial_relay).toBe(true)
    expect(s.custodial_relay_name).toBe('treechat.io')
  })
  it('falls back to the overlay\'s resolved name when no sampled post carries one', () => {
    const named = summarizeProfile({ address: ADDR, keys: [ADDR], sample: [post(1)], totals: null, profile: profileView() })
    expect(named.primary_display_name).toBe('Ada')
    const bare = profileView({ author: author({ displayName: '02ed41…a3d1', nameSource: 'key' }) })
    expect(summarizeProfile({ address: ADDR, keys: [ADDR], sample: [post(1)], totals: null, profile: bare }).primary_display_name).toBeNull()
    const inTx = post(1, { provenance: { grade: 'key', aipVerified: true, nameInTx: 'FromTx' } })
    expect(summarizeProfile({ address: ADDR, keys: [ADDR], sample: [inTx], totals: null, profile: profileView() }).primary_display_name).toBe('FromTx')
  })
  it('reads first and last seen from createdAt', () => {
    const s = summarizeProfile({
      address: ADDR, keys: [ADDR], totals: { posts: 2, replies: 0 }, profile: null,
      sample: [post(1, { createdAt: '2026-09-30T08:00:00Z' }), post(2, { createdAt: '2026-09-29T08:00:00Z' })],
    })
    expect(s.first_seen_in_sample).toBe('2026-09-29T08:00:00Z')
    expect(s.last_seen).toBe('2026-09-30T08:00:00Z')
    expect(s.note).toBe('sample covers all posts')
  })
})

describe('looksLikeKey', () => {
  it('tells addresses and public keys from handles', () => {
    expect(looksLikeKey(ADDR)).toBe(true)
    expect(looksLikeKey(PUB)).toBe(true)
    expect(looksLikeKey('@ada')).toBe(false)
    expect(looksLikeKey('ada')).toBe(false)
  })
})

describe('createV2Get', () => {
  const respond = (status: number, body: string, type = 'application/json') =>
    (async () => new Response(body, { status, headers: { 'content-type': type } })) as unknown as typeof fetch

  it('returns JSON bodies with their status, including /v2 errors', async () => {
    const ok = await createV2Get('https://overlay.test', respond(200, '{"items":[],"next":null}'))('/v2/feed')
    expect(ok).toEqual({ status: 200, body: { items: [], next: null } })
    const err = await createV2Get('https://overlay.test', respond(404, '{"error":{"code":"not_found","message":"post not indexed"}}'))('/v2/post/x')
    expect(err.status).toBe(404)
    expect((err.body as any).error.code).toBe('not_found')
  })

  it('an overlay without /v2 is OverlayV2Unavailable, whatever the 404 looks like', async () => {
    const html = createV2Get('https://overlay.test', respond(404, '<pre>Cannot GET /v2/feed</pre>', 'text/html'))
    await expect(html('/v2/feed?limit=1')).rejects.toBeInstanceOf(OverlayV2Unavailable)
    const json = createV2Get('https://overlay.test', respond(404, '{"status":"error","message":"not found"}'))
    await expect(json('/v2/feed')).rejects.toBeInstanceOf(OverlayV2Unavailable)
    const notImpl = createV2Get('https://overlay.test', respond(501, '{}'))
    await expect(notImpl('/v2/feed')).rejects.toBeInstanceOf(OverlayV2Unavailable)
  })

  it('other failures are errors, not a reason to fall back', async () => {
    const r = await createV2Get('https://overlay.test', respond(502, 'Bad gateway', 'text/plain'))('/v2/feed')
    expect(r.status).toBe(502)
    expect((r.body as any).error.code).toBe('upstream_error')
    const boom = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    await expect(createV2Get('https://overlay.test', boom)('/v2/feed')).rejects.toThrow('fetch failed')
  })

  it('sends the path under the base URL', async () => {
    let seen = ''
    const spy = (async (url: string) => { seen = url; return new Response('{}') }) as unknown as typeof fetch
    await createV2Get('https://overlay.test', spy)('/v2/feed?limit=2')
    expect(seen).toBe('https://overlay.test/v2/feed?limit=2')
  })
})

describe('legacy fallback readers', () => {
  it('build the /v1 requests the tools made before /v2', async () => {
    const seen: string[] = []
    const get = async (p: string) => { seen.push(p); return { total: 7, data: [] } }
    await legacyFeed(get, { limit: 5, offset: 10, tag: 'x', author: ADDR, order: 'asc' })
    expect(seen[0]).toBe(`/v1/feed?limit=5&offset=10&tag=x&author=${ADDR}&order=asc`)
    await legacyRecent(get, { minutes: 5, limit: 3 }, () => Date.parse('2026-09-30T10:00:00Z'))
    expect(seen[1]).toBe('/v1/feed?since=2026-09-30T09%3A55%3A00.000Z&limit=3&order=desc')
  })
  it('legacyAuthorTotals sums posts and replies over keys, one /v1 author per request', async () => {
    const seen: string[] = []
    const get = async (p: string) => { seen.push(p); return { total: p.includes('type=reply') ? '4' : '9' } }
    expect(await legacyAuthorTotals(get, [ADDR, PUB])).toEqual({ posts: 18, replies: 8 })
    expect(seen).toContain(`/v1/feed?author=${PUB}&type=reply&limit=0`)
    expect(seen).toHaveLength(4)
  })
})
