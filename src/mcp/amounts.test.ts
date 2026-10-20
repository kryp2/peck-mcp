import { describe, it, expect } from 'vitest'
import { parseSats } from './amounts.js'

describe('parseSats', () => {
  it('accepts whole positive amounts, as number or numeric string', () => {
    expect(parseSats(1, {})).toEqual({ ok: true, sats: 1 })
    expect(parseSats('5000', {})).toEqual({ ok: true, sats: 5000 })
  })
  it('rejects NaN, fractions, zero, negatives, Infinity, empty and non-numbers', () => {
    for (const v of ['abc', NaN, 1.5, '0.5', 0, -3, Infinity, '', '  ', undefined, null, {}, 1e300]) {
      expect(parseSats(v, {}).ok).toBe(false)
    }
  })
  it('enforces PECK_MCP_MAX_PAYMENT_SATS when set, and ignores a bad value', () => {
    expect(parseSats(1000, { PECK_MCP_MAX_PAYMENT_SATS: '1000' }).ok).toBe(true)
    expect(parseSats(1001, { PECK_MCP_MAX_PAYMENT_SATS: '1000' }).ok).toBe(false)
    expect(parseSats(10_000_000, { PECK_MCP_MAX_PAYMENT_SATS: 'lots' }).ok).toBe(true)
  })
})
