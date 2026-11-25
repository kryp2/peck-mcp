/**
 * Limits for the HTTP transport (https://mcp.peck.to).
 *
 * The endpoint is public and unauthenticated, so an anonymous caller must not
 * be able to make the process allocate without bound:
 *  - the MCP SDK reads a POST body with `req.json()` and no size limit, so the
 *    body is read here, capped, and handed to the transport already parsed;
 *  - every `initialize` stores a Server + transport in a map that only a client
 *    DELETE ever shrank, so the map is capped and idle sessions expire;
 *  - each client address may hold only a share of that cap, and idle sessions
 *    expire sooner while the server is close to it.
 */

import { isIP } from 'node:net'

export const DEFAULT_MAX_BODY_BYTES = 256 * 1024
export const DEFAULT_MAX_SESSIONS = 1000
export const DEFAULT_SESSION_TTL_MS = 30 * 60_000
/** Sessions one client address may hold at once (an office NAT counts as one address). */
export const DEFAULT_MAX_SESSIONS_PER_CLIENT = 32
/** Idle lifetime once the registry is at least BUSY_FRACTION full. */
export const DEFAULT_BUSY_SESSION_TTL_MS = 5 * 60_000
export const DEFAULT_BUSY_FRACTION = 0.8

/** A positive integer from an env value, or the fallback. */
export function envInt(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : fallback
}

export class BodyTooLarge extends Error {
  constructor(public limit: number) { super(`request body exceeds ${limit} bytes`) }
}

export class BadJson extends Error {}

/** Reads and parses a JSON body, refusing more than `limit` bytes (also when the sender omits Content-Length). */
export async function readJsonBody(
  req: AsyncIterable<Buffer | string> & { headers: Record<string, string | string[] | undefined> },
  limit: number = DEFAULT_MAX_BODY_BYTES,
): Promise<unknown> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLarge(limit)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buf.length
    if (size > limit) throw new BodyTooLarge(limit)
    chunks.push(buf)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new BadJson('request body is not valid JSON')
  }
}

/** True for a peer on this host or a private network, i.e. the local reverse proxy. */
function isLocalPeer(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number)
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  const v = ip.toLowerCase()
  return v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80:')
}

function stripMapped(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  return m ? m[1] : ip
}

/** An IPv6 address reduced to its /64 prefix, since one host usually controls a whole /64. */
function ipv6Prefix64(ip: string): string {
  const [head, tail = ''] = ip.toLowerCase().split('::')
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h
  return groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, '')).join(':') + '::/64'
}

/**
 * The address a session is counted against.
 *
 * The socket peer is used as is, unless it is loopback or a private address
 * (the reverse proxy on the same host, e.g. Caddy through Docker). Only then
 * is the rightmost X-Forwarded-For entry used: that is the one the proxy
 * itself appended, while anything to its left came from the client. A missing
 * or malformed header falls back to the peer, so the limit always applies.
 */
export function clientAddress(
  remoteAddress: string | undefined,
  headers: Record<string, string | string[] | undefined>,
): string {
  const peer = stripMapped(remoteAddress || 'unknown')
  let ip = peer
  if (isIP(peer) && isLocalPeer(peer)) {
    const raw = headers['x-forwarded-for']
    const joined = Array.isArray(raw) ? raw.join(',') : raw
    const last = joined?.split(',').map(x => x.trim()).filter(Boolean).pop()
    const forwarded = last ? stripMapped(last) : ''
    if (forwarded && isIP(forwarded)) ip = forwarded
  }
  return isIP(ip) === 6 ? ipv6Prefix64(ip) : ip
}

export interface SessionLimits {
  /** Sessions one client address may hold (default DEFAULT_MAX_SESSIONS_PER_CLIENT). */
  maxPerClient?: number
  /** Idle lifetime while the registry is busy (default DEFAULT_BUSY_SESSION_TTL_MS, never above ttlMs). */
  busyTtlMs?: number
  /** Share of `max` at which the busy lifetime applies (default DEFAULT_BUSY_FRACTION). */
  busyFraction?: number
}

/** A slot held for a session that is being initialised. */
export interface SessionSlot<T> {
  /** Stores the session under `id`, counted against the slot's client. */
  commit(id: string, value: T): void
  /** Gives the slot back if it was never committed (safe to call more than once). */
  release(): void
}

/** Sessions with a hard cap, a per-client cap and an idle lifetime. */
export class SessionRegistry<T> {
  private readonly entries = new Map<string, { value: T; lastSeen: number; client?: string }>()
  /** Slots handed out by reserve() and not yet committed or released, per client. */
  private readonly pending = new Map<string, number>()
  private pendingTotal = 0
  private readonly maxPerClient: number
  private readonly busyTtlMs: number
  private readonly busyAt: number

  constructor(
    private readonly max: number = DEFAULT_MAX_SESSIONS,
    private readonly ttlMs: number = DEFAULT_SESSION_TTL_MS,
    private readonly now: () => number = Date.now,
    limits: SessionLimits = {},
  ) {
    this.maxPerClient = limits.maxPerClient ?? DEFAULT_MAX_SESSIONS_PER_CLIENT
    this.busyTtlMs = Math.min(limits.busyTtlMs ?? DEFAULT_BUSY_SESSION_TTL_MS, ttlMs)
    this.busyAt = Math.max(1, Math.floor(max * (limits.busyFraction ?? DEFAULT_BUSY_FRACTION)))
  }

  get size(): number { return this.entries.size }
  has(id: string): boolean { return this.entries.has(id) }

  /** The session, with its idle clock reset. */
  get(id: string): T | undefined {
    const e = this.entries.get(id)
    if (!e) return undefined
    e.lastSeen = this.now()
    return e.value
  }

  set(id: string, value: T, client?: string): void {
    this.entries.set(id, { value, lastSeen: this.now(), client })
  }
  delete(id: string): void { this.entries.delete(id) }

  /** Open sessions plus pending slots held by `client`. */
  countFor(client: string): number {
    let n = this.pending.get(client) ?? 0
    for (const e of this.entries.values()) if (e.client === client) n++
    return n
  }

  /**
   * Holds a slot for a new session from `client`, or says why there is none.
   * The check and the hold happen together, so concurrent initialisations
   * cannot overshoot either cap while they await the transport.
   */
  reserve(client: string): SessionSlot<T> | 'full' | 'client-limit' {
    if (this.entries.size + this.pendingTotal >= this.max) return 'full'
    if (this.countFor(client) >= this.maxPerClient) return 'client-limit'
    this.pending.set(client, (this.pending.get(client) ?? 0) + 1)
    this.pendingTotal++
    let open = true
    const release = () => {
      if (!open) return
      open = false
      const n = (this.pending.get(client) ?? 1) - 1
      if (n > 0) this.pending.set(client, n); else this.pending.delete(client)
      this.pendingTotal--
    }
    return {
      commit: (id, value) => { if (!open) return; release(); this.set(id, value, client) },
      release,
    }
  }

  /**
   * Drops sessions idle for longer than the TTL and returns them so the caller
   * can close them. While the registry is busy, the shorter busy TTL applies.
   */
  sweep(): T[] {
    const ttl = this.entries.size >= this.busyAt ? this.busyTtlMs : this.ttlMs
    const cutoff = this.now() - ttl
    const expired: T[] = []
    for (const [id, e] of this.entries) {
      if (e.lastSeen < cutoff) { expired.push(e.value); this.entries.delete(id) }
    }
    return expired
  }

  /** True when a new session would exceed the cap (after expiring idle ones is the caller's job). */
  get full(): boolean { return this.entries.size + this.pendingTotal >= this.max }
}
