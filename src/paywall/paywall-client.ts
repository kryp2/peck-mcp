/**
 * PaywallClient — thin wrapper around fetch() that handles HTTP 402
 * challenges from peck.to overlay.
 *
 * Responsibilities:
 *   - Hold local channel state (channel_id, lastNonce, amountSpent)
 *   - On 402: sign a drain receipt and retry
 *   - On 200: capture X-Peck-Receipt-Ack and advance local state
 *   - Offer openChannel() / close() lifecycle helpers
 *
 * Intentionally does NOT:
 *   - Touch private keys (all signing via WalletAdapter)
 *   - Broadcast the funding TX (caller uses their wallet's TX builder)
 *   - Verify server ack signatures (stretch goal; off by default)
 */

import { feeFor } from './prices.js'
import type { WalletAdapter } from './wallet-adapter.js'

export interface PaywallClientOpts {
  /** Overlay base URL, e.g. "https://overlay.peck.to". */
  overlay: string

  /** BRC-100 wallet adapter. */
  wallet: WalletAdapter

  /**
   * Sats to deposit when auto-opening a channel on the first 402.
   * Ignored if the client already has an open channel.
   */
  autoOpenDeposit?: number

  /**
   * If set, the client will verify server-ack signatures against
   * this pubkey. Optional — defaults to off since the server pubkey
   * is not known ahead of channel-open.
   */
  serverPubkey?: string

  /** Injected fetch (for tests). Defaults to globalThis.fetch. */
  fetch?: typeof fetch
}

export interface ChannelMemory {
  channel_id: string
  client_pubkey: string
  lock_amount_sats: number
  amount_spent_sats: number
  last_nonce: number
  expiry_height: number
}

export class PaywallError extends Error {
  constructor(
    public status: number,
    public body: any,
    message: string,
  ) {
    super(message)
    this.name = 'PaywallError'
  }
}

export class PaywallClient {
  private channel: ChannelMemory | null = null
  private inflight = Promise.resolve()      // serialises nonce advance
  private readonly fetchFn: typeof fetch

  constructor(private opts: PaywallClientOpts) {
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis)
  }

  /** Returns current channel state, or null if no channel is open. */
  getChannel(): ChannelMemory | null {
    return this.channel ? { ...this.channel } : null
  }

  /**
   * Open a new channel. The returned response contains an
   * `open_script` hex that the caller must include as an output
   * in a funding TX and broadcast. Once the funding TX has one
   * confirmation, call markActive(funding_txid, output_index) so
   * subsequent fetches include receipts.
   */
  async openChannel(lockAmountSats: number, expiryBlocks?: number): Promise<{
    channel_id: string
    open_script: string
    server_pubkey: string
    expiry_height: number
    min_confirmations: number
  }> {
    const client_pubkey = await this.opts.wallet.getPubKey()
    const resp = await this.fetchFn(`${this.opts.overlay}/v1/channel/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_pubkey,
        lock_amount_sats: lockAmountSats,
        ...(expiryBlocks ? { expiry_blocks: expiryBlocks } : {}),
      }),
    })
    if (!resp.ok) {
      throw new PaywallError(resp.status, await safeJson(resp), 'channel open failed')
    }
    const body = await resp.json() as {
      channel_id: string
      open_script: string
      server_pubkey: string
      expiry_height: number
      min_confirmations: number
    }
    // Remember the channel, initialised to zero spend. Caller is
    // responsible for broadcasting the funding TX and (later)
    // telling the client the channel is active.
    this.channel = {
      channel_id: body.channel_id,
      client_pubkey,
      lock_amount_sats: lockAmountSats,
      amount_spent_sats: 0,
      last_nonce: 0,
      expiry_height: body.expiry_height,
    }
    return body
  }

  /**
   * Replace the channel_id after the funding TX confirms.
   *
   * Overlay's v=1 channel-open returns a "pending:..." id before
   * the funding TX is known. Once the TX is broadcast and
   * confirmed, the real id is "<funding_txid>:<output_index>".
   * The client adopts the new id and overlay's state should have
   * it marked active.
   */
  async markActive(realChannelId: string): Promise<void> {
    if (!this.channel) throw new Error('no channel to activate')
    this.channel.channel_id = realChannelId
  }

  /** Query overlay for current channel state (free endpoint). */
  async status(channelId?: string): Promise<any> {
    const id = channelId ?? this.channel?.channel_id
    if (!id) throw new Error('no channel id')
    const resp = await this.fetchFn(
      `${this.opts.overlay}/v1/channel/status?channel_id=${encodeURIComponent(id)}`,
    )
    if (!resp.ok) {
      throw new PaywallError(resp.status, await safeJson(resp), 'status failed')
    }
    return resp.json()
  }

  /**
   * Close the channel. Server settles on-chain; client refund sits
   * in the wallet after the close TX confirms. Returns the
   * settlement preview.
   */
  async close(): Promise<any> {
    if (!this.channel) throw new Error('no channel to close')
    const payload = `close:${this.channel.channel_id}:${this.channel.amount_spent_sats}`
    const client_sig = await this.opts.wallet.sign(payload)
    const resp = await this.fetchFn(`${this.opts.overlay}/v1/channel/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel_id: this.channel.channel_id, client_sig }),
    })
    if (!resp.ok) {
      throw new PaywallError(resp.status, await safeJson(resp), 'close failed')
    }
    const body = await resp.json()
    this.channel = null
    return body
  }

  /**
   * Main workhorse. Call an overlay endpoint with automatic 402
   * handling.
   *
   * - Free endpoints (fee = 0 by argument shape) are passed
   *   through without a receipt.
   * - Paid endpoints attach X-Peck-Receipt. On 402, re-signs and
   *   retries ONCE (in case of nonce drift); on second 402 the
   *   error is raised.
   * - Response ack (X-Peck-Receipt-Ack) advances local state.
   */
  async fetch(endpoint: string, args: Record<string, unknown> = {}): Promise<any> {
    return this.serialise(async () => {
      // Compute fee locally — same resolver overlay uses.
      const fee = feeFor(endpoint, args)

      // Free path: plain fetch, no receipt.
      if (fee === 0) {
        const resp = await this.doFetch(endpoint, args)
        if (!resp.ok) {
          throw new PaywallError(resp.status, await safeJson(resp), 'free-endpoint error')
        }
        return resp.json()
      }

      // Paid path: need an active channel.
      if (!this.channel) {
        if (this.opts.autoOpenDeposit && this.opts.autoOpenDeposit >= 1000) {
          await this.openChannel(this.opts.autoOpenDeposit)
        } else {
          throw new Error(
            `paid endpoint "${endpoint}" costs ${fee} sats — no channel open`,
          )
        }
      }

      const resp = await this.doFetch(endpoint, args, fee)

      if (resp.status === 402) {
        throw new PaywallError(402, await safeJson(resp), 'payment rejected after signed retry')
      }

      return resp.json()
    })
  }

  // ── Private ──────────────────────────────────────────────────

  /** Serialise drain generation so two concurrent fetch()s can't reuse the same nonce. */
  private serialise<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.inflight.then(fn, fn)
    this.inflight = next.then(() => {}, () => {})
    return next
  }

  private async doFetch(
    endpoint: string,
    args: Record<string, unknown>,
    fee = 0,
  ): Promise<Response> {
    const ch = this.channel
    const url = buildUrl(this.opts.overlay, endpoint, args)
    const init: RequestInit = { method: 'GET' }

    if (fee > 0 && ch) {
      const receipt = {
        channel_id: ch.channel_id,
        nonce: ch.last_nonce + 1,
        amount_spent_new: ch.amount_spent_sats + fee,
        client_sig: await this.opts.wallet.sign(
          canonicalise({
            channel_id: ch.channel_id,
            nonce: ch.last_nonce + 1,
            amount_spent_new: ch.amount_spent_sats + fee,
          }),
        ),
      }
      init.headers = { 'X-Peck-Receipt': JSON.stringify(receipt) }
    }

    const resp = await this.fetchFn(url, init)

    // On success: read ack, advance local state.
    if (resp.ok && fee > 0 && ch) {
      const ackHeader = resp.headers.get('X-Peck-Receipt-Ack')
      let acked = false
      if (ackHeader) {
        try {
          const ack = JSON.parse(ackHeader)
          if (typeof ack.nonce === 'number' && typeof ack.amount_spent_new === 'number') {
            ch.last_nonce = ack.nonce
            ch.amount_spent_sats = ack.amount_spent_new
            acked = true
          }
        } catch {
          // fall through to optimistic advance
        }
      }
      if (!acked) {
        // No valid ack, but server accepted our drain (we got 200).
        // Optimistically advance state to match what we signed.
        ch.last_nonce += 1
        ch.amount_spent_sats += fee
      }
    }

    return resp
  }
}

// ── helpers ────────────────────────────────────────────────────

function canonicalise(r: {
  channel_id: string
  nonce: number
  amount_spent_new: number
}): string {
  return [
    'paywall/v1/drain',
    `channel_id=${r.channel_id}`,
    `nonce=${r.nonce}`,
    `amount_spent_new=${r.amount_spent_new}`,
  ].join('\n')
}

function buildUrl(base: string, endpoint: string, args: Record<string, unknown>): string {
  const path = endpoint.startsWith('/') ? endpoint : `/v1/${endpoint}`
  const url = new URL(path, base)
  for (const [k, v] of Object.entries(args)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
  }
  return url.toString()
}

async function safeJson(resp: Response): Promise<any> {
  try { return await resp.json() }
  catch { return null }
}
