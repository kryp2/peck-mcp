/**
 * Limits for the HTTP transport (https://mcp.peck.to).
 *
 * The endpoint is public and unauthenticated, so an anonymous caller must not
 * be able to make the process allocate without bound:
 *  - the MCP SDK reads a POST body with `req.json()` and no size limit, so the
 *    body is read here, capped, and handed to the transport already parsed;
 *  - every `initialize` stores a Server + transport in a map that only a client
 *    DELETE ever shrank, so the map is capped and idle sessions expire.
 */

export const DEFAULT_MAX_BODY_BYTES = 256 * 1024
export const DEFAULT_MAX_SESSIONS = 1000
export const DEFAULT_SESSION_TTL_MS = 30 * 60_000

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

/** Sessions with a hard cap and an idle lifetime. */
export class SessionRegistry<T> {
  private readonly entries = new Map<string, { value: T; lastSeen: number }>()

  constructor(
    private readonly max: number = DEFAULT_MAX_SESSIONS,
    private readonly ttlMs: number = DEFAULT_SESSION_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number { return this.entries.size }
  has(id: string): boolean { return this.entries.has(id) }

  /** The session, with its idle clock reset. */
  get(id: string): T | undefined {
    const e = this.entries.get(id)
    if (!e) return undefined
    e.lastSeen = this.now()
    return e.value
  }

  set(id: string, value: T): void { this.entries.set(id, { value, lastSeen: this.now() }) }
  delete(id: string): void { this.entries.delete(id) }

  /** Drops sessions idle for longer than the TTL and returns them so the caller can close them. */
  sweep(): T[] {
    const cutoff = this.now() - this.ttlMs
    const expired: T[] = []
    for (const [id, e] of this.entries) {
      if (e.lastSeen < cutoff) { expired.push(e.value); this.entries.delete(id) }
    }
    return expired
  }

  /** True when a new session would exceed the cap (after expiring idle ones is the caller's job). */
  get full(): boolean { return this.entries.size >= this.max }
}
