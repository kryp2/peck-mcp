import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import { BadJson, BodyTooLarge, SessionRegistry, clientAddress, envInt, readJsonBody } from './http-guards.js'
import type { SessionSlot } from './http-guards.js'

const slot = <T>(r: SessionRegistry<T>, client: string): SessionSlot<T> => {
  const s = r.reserve(client)
  if (typeof s === 'string') throw new Error(`no slot: ${s}`)
  return s
}

const body = (chunks: string[], headers: Record<string, string> = {}) =>
  Object.assign(Readable.from(chunks.map(c => Buffer.from(c))), { headers })

describe('readJsonBody', () => {
  it('parses a small body', async () => {
    expect(await readJsonBody(body(['{"a":', '1}']), 100)).toEqual({ a: 1 })
  })
  it('rejects a declared Content-Length over the limit without reading', async () => {
    await expect(readJsonBody(body(['{}'], { 'content-length': '5000' }), 100)).rejects.toBeInstanceOf(BodyTooLarge)
  })
  it('rejects a chunked body that grows past the limit', async () => {
    await expect(readJsonBody(body(['x'.repeat(60), 'x'.repeat(60)]), 100)).rejects.toBeInstanceOf(BodyTooLarge)
  })
  it('rejects invalid JSON', async () => {
    await expect(readJsonBody(body(['{nope']), 100)).rejects.toBeInstanceOf(BadJson)
  })
})

describe('SessionRegistry', () => {
  it('reports full at the cap', () => {
    const r = new SessionRegistry<string>(2, 1000)
    r.set('a', 'A'); expect(r.full).toBe(false)
    r.set('b', 'B'); expect(r.full).toBe(true)
  })
  it('expires idle sessions and keeps touched ones', () => {
    let t = 0
    const r = new SessionRegistry<string>(10, 1000, () => t)
    r.set('idle', 'I'); r.set('busy', 'B')
    t = 900; expect(r.get('busy')).toBe('B')   // touch resets the clock
    t = 1500
    expect(r.sweep()).toEqual(['I'])
    expect(r.has('idle')).toBe(false)
    expect(r.has('busy')).toBe(true)
  })
  it('frees room after a sweep', () => {
    let t = 0
    const r = new SessionRegistry<string>(1, 1000, () => t)
    r.set('a', 'A'); expect(r.full).toBe(true)
    t = 2000; r.sweep(); expect(r.full).toBe(false)
  })
})

describe('SessionRegistry per-client limit', () => {
  it('stops one address at its share and keeps room for others', () => {
    const r = new SessionRegistry<string>(100, 60_000, () => 0, { maxPerClient: 3 })
    for (let i = 0; i < 3; i++) slot(r, '198.51.100.7').commit(`a${i}`, 'A')
    expect(r.reserve('198.51.100.7')).toBe('client-limit')
    expect(r.size).toBe(3)
    // another address, e.g. a second user, still gets sessions
    slot(r, '203.0.113.9').commit('b0', 'B')
    expect(r.size).toBe(4)
    expect(r.countFor('203.0.113.9')).toBe(1)
  })
  it('counts pending slots, so concurrent initialisations cannot overshoot', () => {
    const r = new SessionRegistry<string>(100, 60_000, () => 0, { maxPerClient: 2 })
    const s1 = slot(r, 'x'); slot(r, 'x')
    expect(r.reserve('x')).toBe('client-limit')
    s1.release()
    expect(typeof r.reserve('x')).toBe('object')
  })
  it('gives the slot back when the session goes away', () => {
    const r = new SessionRegistry<string>(100, 60_000, () => 0, { maxPerClient: 1 })
    slot(r, 'x').commit('s', 'S')
    expect(r.reserve('x')).toBe('client-limit')
    r.delete('s')
    expect(typeof r.reserve('x')).toBe('object')
  })
  it('a release after commit does not free the session', () => {
    const r = new SessionRegistry<string>(100, 60_000, () => 0, { maxPerClient: 1 })
    const s = slot(r, 'x'); s.commit('s', 'S'); s.release(); s.release()
    expect(r.size).toBe(1)
    expect(r.reserve('x')).toBe('client-limit')
  })
  it('still enforces the global cap', () => {
    const r = new SessionRegistry<string>(2, 60_000, () => 0, { maxPerClient: 5 })
    slot(r, 'a').commit('1', '1'); slot(r, 'b').commit('2', '2')
    expect(r.reserve('c')).toBe('full')
  })
})

describe('SessionRegistry idle expiry near the cap', () => {
  it('uses the long lifetime while there is room and the short one when busy', () => {
    let t = 0
    const r = new SessionRegistry<string>(10, 30 * 60_000, () => t, { busyTtlMs: 5 * 60_000, busyFraction: 0.5 })
    for (let i = 0; i < 4; i++) r.set(`s${i}`, `S${i}`, `c${i}`)
    t = 10 * 60_000
    expect(r.sweep()).toEqual([])          // 4 of 10: not busy, 30 min lifetime
    r.set('s4', 'S4', 'c4')                // 5 of 10: busy
    expect(r.sweep().sort()).toEqual(['S0', 'S1', 'S2', 'S3'])
    expect(r.has('s4')).toBe(true)         // touched just now
  })
  it('never makes the busy lifetime longer than the normal one', () => {
    let t = 0
    const r = new SessionRegistry<string>(1, 1000, () => t, { busyTtlMs: 60_000 })
    r.set('a', 'A', 'x')
    t = 1500
    expect(r.sweep()).toEqual(['A'])
  })
})

describe('clientAddress', () => {
  const proxy = '::ffff:172.30.0.1'
  it('uses the socket peer when it is not a local proxy, ignoring the header', () => {
    expect(clientAddress('198.51.100.7', { 'x-forwarded-for': '203.0.113.1' })).toBe('198.51.100.7')
  })
  it('takes the rightmost forwarded entry behind a local proxy', () => {
    expect(clientAddress(proxy, { 'x-forwarded-for': '203.0.113.1' })).toBe('203.0.113.1')
    expect(clientAddress(proxy, { 'x-forwarded-for': '10.0.0.1, 203.0.113.1' })).toBe('203.0.113.1')
    expect(clientAddress('127.0.0.1', { 'x-forwarded-for': ['1.2.3.4', '203.0.113.1'] })).toBe('203.0.113.1')
  })
  it('falls back to the peer when the header is missing or malformed', () => {
    expect(clientAddress(proxy, {})).toBe('172.30.0.1')
    expect(clientAddress(proxy, { 'x-forwarded-for': 'not-an-ip' })).toBe('172.30.0.1')
    expect(clientAddress(undefined, {})).toBe('unknown')
  })
  it('groups IPv6 clients by /64', () => {
    expect(clientAddress('2001:db8:1:2::5', {})).toBe('2001:db8:1:2::/64')
    expect(clientAddress(proxy, { 'x-forwarded-for': '2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd' })).toBe('2001:db8:1:2::/64')
  })
})

describe('envInt', () => {
  it('takes positive integers only', () => {
    expect(envInt('500', 1)).toBe(500)
    expect(envInt('0', 1)).toBe(1)
    expect(envInt('-3', 1)).toBe(1)
    expect(envInt('abc', 1)).toBe(1)
    expect(envInt(undefined, 7)).toBe(7)
  })
})
