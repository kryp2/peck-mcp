import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import { BadJson, BodyTooLarge, SessionRegistry, envInt, readJsonBody } from './http-guards.js'

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

describe('envInt', () => {
  it('takes positive integers only', () => {
    expect(envInt('500', 1)).toBe(500)
    expect(envInt('0', 1)).toBe(1)
    expect(envInt('-3', 1)).toBe(1)
    expect(envInt('abc', 1)).toBe(1)
    expect(envInt(undefined, 7)).toBe(7)
  })
})
