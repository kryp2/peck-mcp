import { describe, it, expect } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import { PROTO_MAP, PROTO_AIP } from 'bitcoin-agent-wallet'
import { buildMapScript } from './schema-builders.js'

const KEY = PrivateKey.fromHex('11'.repeat(32)) // deterministic test key
const ascii = (s: string): number[] => Array.from(Buffer.from(s, 'utf8'))
const dataEq = (a: number[] | undefined, b: number[]) =>
  !!a && a.length === b.length && a.every((x, i) => x === b[i])

describe('buildMapScript', () => {
  const s = buildMapScript('post', { content: 'hello' }, KEY, 'peck.agents', 'main')
  const chunks = s.chunks
  const datas = chunks.map(c => c.data).filter(Boolean) as number[][]

  it('starts with OP_FALSE OP_RETURN', () => {
    expect(s.toHex().startsWith('006a')).toBe(true)
  })

  it('pushes the MAP namespace then SET', () => {
    expect(datas.some(d => dataEq(d, ascii(PROTO_MAP)))).toBe(true)
    expect(datas.some(d => dataEq(d, ascii('SET')))).toBe(true)
  })

  it('pushes app, type and each field key/value as data', () => {
    for (const v of ['app', 'peck.agents', 'type', 'post', 'content', 'hello']) {
      expect(datas.some(d => dataEq(d, ascii(v)))).toBe(true)
    }
  })

  it('pushes the | separator as 1-byte pushdata (0x7c), never a bare OP_SWAP opcode', () => {
    // The pipe MUST travel as data [0x7c] — hex `017c` — not as raw opcode 0x7c.
    // MEMORY feedback_bitcoin_schema_pipe_push: a raw 0x7c silently breaks parsing.
    expect(s.toHex()).toContain('017c')
    expect(datas.some(d => dataEq(d, [0x7c]))).toBe(true)
    expect(chunks.some(c => c.op === 0x7c && !c.data)).toBe(false)
  })

  it('appends an AIP signature section (namespace + signature blob)', () => {
    expect(datas.some(d => dataEq(d, ascii(PROTO_AIP)))).toBe(true)
    // Signature length varies by scheme (compact 65 / DER ~71 / BRC-77 envelope),
    // so assert a signature-sized push exists rather than pinning a format mid-migration.
    expect(datas.some(d => d.length >= 64)).toBe(true)
  })

  it('is byte-for-byte deterministic for identical inputs', () => {
    const a = buildMapScript('post', { content: 'hi' }, KEY, 'peck.agents', 'main').toHex()
    const b = buildMapScript('post', { content: 'hi' }, KEY, 'peck.agents', 'main').toHex()
    expect(a).toBe(b)
  })

  it('orders fields after the app/type header', () => {
    const hex = s.toHex()
    expect(hex.indexOf(Buffer.from('type').toString('hex')))
      .toBeLessThan(hex.indexOf(Buffer.from('content').toString('hex')))
  })
})
