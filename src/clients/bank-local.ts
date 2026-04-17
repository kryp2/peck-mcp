/**
 * bank-local — minimal TS client for the wallet-infra internal REST API.
 *
 * Targets the local docker stack at infra/bank-local.compose.yml (default
 * http://localhost:8088). The internal API has no auth — it's the
 * VPC-internal port in production. For local dev that's fine.
 *
 * The point of this client: stop hand-rolling UTXO state, parent tx fetches,
 * and ARC broadcasts. wallet-toolbox already handles all of that. We hand it
 * a description + outputs and it returns a txid.
 *
 * Endpoints we wrap:
 *   GET  /health
 *   GET  /balance
 *   POST /listOutputs   {basket?}
 *   POST /createAction  {description, outputs:[{script, satoshis}]}
 *   POST /submitDirectTransaction {transaction:{rawTx}}
 *   POST /importUtxo    {txid, outputIndex?}
 *   POST /state/get     {key}
 *   POST /state/put     {key, value}
 *   POST /state/list    {prefix?}
 *   POST /state/delete  {key}
 */
import { Script, OP, P2PKH } from '@bsv/sdk'
import { PeckBrcClient } from './peck-brc-client.js'

export interface BankLocalOptions {
  baseUrl?: string
  /**
   * Optional PeckBrcClient. When provided, all HTTP requests go through
   * its .fetch() (which routes to AuthFetch when configured against a
   * BRC-100 wallet, or plain fetch in embedded mode). When omitted, a
   * default embedded PeckBrcClient is constructed via .fromEnv().
   *
   * Set this when targeting prod bank.peck.to which requires BRC-104 auth.
   */
  authClient?: PeckBrcClient
}

export interface CreateActionOutput {
  /** Hex-encoded locking script. */
  script: string
  satoshis: number
}

export class BankLocalError extends Error {
  constructor(message: string, public readonly status: number, public readonly body?: any) {
    super(message)
  }
}

export class BankLocal {
  readonly baseUrl: string
  readonly authClient: PeckBrcClient
  constructor(opts: BankLocalOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.BANK_LOCAL_URL ?? 'http://localhost:8088').replace(/\/$/, '')
    this.authClient = opts.authClient ?? PeckBrcClient.fromEnv()
  }

  private async req<T>(method: 'GET' | 'POST', path: string, body?: any): Promise<T> {
    const r = await this.authClient.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await r.text()
    let parsed: any
    try { parsed = text ? JSON.parse(text) : {} } catch { parsed = { raw: text } }
    if (!r.ok) {
      throw new BankLocalError(`bank-local ${method} ${path}: ${r.status} ${parsed?.error ?? text}`, r.status, parsed)
    }
    return parsed as T
  }

  health() {
    return this.req<{ status: string; chain: 'test' | 'main'; identityKey: string }>('GET', '/health')
  }

  balance() {
    return this.req<{ balance: number; spendableOutputs: number; totalOutputs: number }>('GET', '/balance')
  }

  listOutputs(basket = 'default') {
    return this.req<{
      totalOutputs: number
      outputs: Array<{ satoshis: number; spendable: boolean; outpoint: string }>
    }>('POST', '/listOutputs', { basket })
  }

  /**
   * Build, sign, and broadcast a transaction with the given outputs.
   * The wallet picks UTXOs, computes change, signs, and broadcasts via ARC.
   */
  createAction(description: string, outputs: CreateActionOutput[]) {
    return this.req<{ txid: string }>('POST', '/createAction', { description, outputs })
  }

  /**
   * Routed createAction via bank-shim. Each call also produces a fee
   * receipt OP_RETURN tx (the shim writes that itself before forwarding)
   * AND optionally credits a service's virtual ledger entry per Wright
   * §5.4 held-earnings model.
   *
   * Returns the underlying write txid, the fee receipt txid, AND any
   * ledger credit info if credit_service_id was passed.
   */
  async paidCreateAction(
    shimUrl: string,
    description: string,
    outputs: CreateActionOutput[],
    opts: {
      credit_service_id?: string,
      credit_gross_sat?: number,
    } = {},
  ): Promise<{ txid: string; fee_receipt_txid: string | null; price_paid_sats: number; credited?: any }> {
    const r = await fetch(`${shimUrl.replace(/\/$/, '')}/paid-createAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description,
        outputs,
        ...(opts.credit_service_id ? { credit_service_id: opts.credit_service_id } : {}),
        ...(opts.credit_gross_sat !== undefined ? { credit_gross_sat: opts.credit_gross_sat } : {}),
      }),
    })
    const text = await r.text()
    let parsed: any
    try { parsed = text ? JSON.parse(text) : {} } catch { parsed = { raw: text } }
    if (!r.ok) throw new BankLocalError(`bank-shim ${shimUrl}: ${r.status} ${parsed?.error ?? text}`, r.status, parsed)
    return parsed
  }

  importUtxo(txid: string, outputIndex?: number) {
    return this.req<{ accepted: boolean; txid: string; outputIndex: number }>(
      'POST', '/importUtxo', { txid, outputIndex },
    )
  }

  // ----- App state KV ------------------------------------------------------

  async stateGet<T = any>(key: string): Promise<T | null> {
    try {
      const r = await this.req<{ key: string; value: string; updated_at: string }>('POST', '/state/get', { key })
      // wallet-infra stores values as JSON strings; parse if possible
      try { return JSON.parse(r.value) as T } catch { return r.value as unknown as T }
    } catch (e) {
      if (e instanceof BankLocalError && e.status === 404) return null
      throw e
    }
  }

  statePut(key: string, value: any) {
    return this.req<{ ok: true; key: string }>('POST', '/state/put', { key, value })
  }

  stateList(prefix?: string) {
    return this.req<{ keys: Array<{ key: string; updated_at: string }> }>('POST', '/state/list', { prefix })
  }

  stateDelete(key: string) {
    return this.req<{ ok: true; deleted: number }>('POST', '/state/delete', { key })
  }

  // ----- Helpers -----------------------------------------------------------

  /**
   * Build an OP_FALSE OP_RETURN <data> locking script and return its hex.
   * Use this in createAction outputs[].script to anchor arbitrary bytes.
   */
  static opReturnScriptHex(data: Uint8Array | Buffer): string {
    const s = new Script()
    s.writeOpCode(OP.OP_FALSE)
    s.writeOpCode(OP.OP_RETURN)
    s.writeBin(Array.from(data))
    return s.toHex()
  }

  /** P2PKH locking script hex for an address. */
  static p2pkhScriptHex(address: string): string {
    return new P2PKH().lock(address).toHex()
  }
}
