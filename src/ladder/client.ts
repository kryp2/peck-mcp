/**
 * LadderClient — binds an on-chain payment to an off-chain service call.
 *
 * This is the primitive that turns "blank shots into recipient addresses"
 * into "meaningful agentic transactions". For each call:
 *
 *   1. Generate a request_id (UUID-like)
 *   2. Build a 32-byte commitment hash that binds:
 *        sha256(request_id || service_id || amount_sats || timestamp_ms)
 *   3. Fire a shot via PaymentRifle that includes the commitment in
 *      OP_RETURN, in parallel with the actual HTTP request to the service
 *   4. Persist the off-chain receipt {request_id, service, payload, response,
 *      txid, commitment} so any verifier can re-hash and check the chain
 *
 * The on-chain tx becomes uncontestably "meaningful": you can prove it
 * paid for a specific service call without revealing the call itself.
 * Selective reveal: show the off-chain receipt and anyone can re-hash and
 * verify against the OP_RETURN.
 */
import { createHash, randomUUID } from 'crypto'
import { PaymentRifle, type ShotResult } from './rifle.js'

export interface ServiceCallReceipt {
  requestId: string
  serviceId: string
  serviceEndpoint: string
  paymentSats: number
  timestamp: number
  commitmentHex: string
  txid: string
  endpoint: string  // ARC endpoint that accepted it
  durationMs: number
  responseStatus: number
  responseSnippet: string
}

export interface LadderClientCall {
  serviceId: string
  serviceEndpoint: string
  recipientAddress: string
  paymentSats: number
  payload: any
}

/**
 * Compute the commitment hash that binds an on-chain payment tx to an
 * off-chain service call. Anyone holding the receipt can re-compute and
 * verify against the OP_RETURN data of the on-chain tx.
 */
export function computeCommitment(
  requestId: string,
  serviceId: string,
  paymentSats: number,
  timestamp: number,
): Buffer {
  const preimage = Buffer.from(
    `${requestId}|${serviceId}|${paymentSats}|${timestamp}`,
    'utf8',
  )
  return createHash('sha256').update(preimage).digest()
}

export class LadderClient {
  constructor(private rifle: PaymentRifle) {}

  /**
   * Make a paid service call. Fires the on-chain payment (with commitment
   * in OP_RETURN) and the HTTP request to the service in parallel, then
   * returns a complete receipt linking both sides.
   *
   * Caller can persist the receipt to disk/db; the commitmentHex is also
   * embedded in the on-chain tx so independent verification is trivial.
   */
  async call(opts: LadderClientCall): Promise<ServiceCallReceipt> {
    const requestId = randomUUID()
    const timestamp = Date.now()
    const commitment = computeCommitment(
      requestId,
      opts.serviceId,
      opts.paymentSats,
      timestamp,
    )

    // Wrap HTTP into a body that includes the request_id so the service
    // can echo it back and we can prove the link.
    const httpBody = JSON.stringify({
      request_id: requestId,
      service_id: opts.serviceId,
      payment_sats: opts.paymentSats,
      ...opts.payload,
    })

    // Fire payment + service call in parallel. Either side can fail
    // independently — both are captured in the receipt.
    const t0 = Date.now()
    const [shotResult, httpResult] = await Promise.allSettled([
      this.rifle.fire(opts.recipientAddress, opts.paymentSats, commitment),
      fetch(opts.serviceEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: httpBody,
      }),
    ])

    const durationMs = Date.now() - t0

    if (shotResult.status === 'rejected') {
      throw new Error(`payment failed: ${shotResult.reason?.message || shotResult.reason}`)
    }
    const shot = shotResult.value as ShotResult

    let responseStatus = 0
    let responseSnippet = ''
    if (httpResult.status === 'fulfilled') {
      responseStatus = httpResult.value.status
      try {
        const txt = await httpResult.value.text()
        responseSnippet = txt.slice(0, 200)
      } catch { /* ignore */ }
    } else {
      responseSnippet = `HTTP failed: ${httpResult.reason?.message || httpResult.reason}`.slice(0, 200)
    }

    return {
      requestId,
      serviceId: opts.serviceId,
      serviceEndpoint: opts.serviceEndpoint,
      paymentSats: opts.paymentSats,
      timestamp,
      commitmentHex: commitment.toString('hex'),
      txid: shot.txid,
      endpoint: shot.endpoint,
      durationMs,
      responseStatus,
      responseSnippet,
    }
  }
}
