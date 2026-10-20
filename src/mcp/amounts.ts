/**
 * Satoshi amounts for the tools that move money (peck_send_payment,
 * peck_request_payment, peck_payment_tx).
 *
 * `Number(x) < 1` lets NaN and fractions through (NaN < 1 is false, 1.5 is not
 * below 1), and nothing bounded the amount, so a mangled or injected argument
 * reached the wallet as-is. An amount must be a positive safe integer. An
 * operator can set PECK_MCP_MAX_PAYMENT_SATS as a ceiling for one call; unset
 * means no ceiling.
 */
export type SatsResult = { ok: true; sats: number } | { ok: false; error: string }

export function parseSats(value: unknown, env: Record<string, string | undefined> = process.env): SatsResult {
  const sats = typeof value === 'string' && value.trim() === '' ? NaN : Number(value)
  if (!Number.isSafeInteger(sats) || sats < 1) {
    return { ok: false, error: 'sats must be a whole number of satoshis, 1 or more' }
  }
  const max = Number(env.PECK_MCP_MAX_PAYMENT_SATS)
  if (Number.isSafeInteger(max) && max > 0 && sats > max) {
    return { ok: false, error: `sats ${sats} is above PECK_MCP_MAX_PAYMENT_SATS (${max})` }
  }
  return { ok: true, sats }
}
