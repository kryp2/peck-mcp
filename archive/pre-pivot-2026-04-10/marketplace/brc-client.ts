/**
 * BRC-100 Client — pays a BrcServiceAgent and gets the response.
 *
 * Wraps the 2-step HTTP 402 dance:
 *   1. POST /<capability>  → expect 402 with derivation metadata
 *   2. wallet.createAction({outputs:[{lockingScript: P2PKH(derived), satoshis: price}]})
 *   3. POST /<capability>  with X-BSV-Payment-Beef + derivation echo
 *
 * Returns { result, price, durationMs, paymentTxid }.
 */
import { P2PKH } from '@bsv/sdk'
import type { SetupWalletKnex } from '@bsv/wallet-toolbox'
import { getWallet } from './peckpay-wallet.js'

export interface BrcCallResult<T = any> {
  result: T
  price: number
  paymentTxid: string
  durationMs: number
  identityKey: string  // server identity that was paid
}

export class BrcClient {
  private setup: SetupWalletKnex | null = null

  constructor(private walletName: string) {}

  async ready(): Promise<void> {
    if (!this.setup) this.setup = await getWallet(this.walletName)
  }

  get identityKey(): string { return this.setup?.identityKey || '' }

  /**
   * Call a service capability with full BRC-100 payment flow.
   *
   * @param endpoint  Base URL like "http://localhost:3002"
   * @param capability  Capability name like "get-weather"
   * @param body  Request body forwarded to the service handler
   */
  async call<T = any>(endpoint: string, capability: string, body: any): Promise<BrcCallResult<T>> {
    await this.ready()
    const t0 = Date.now()
    const url = `${endpoint}/${capability}`

    // Step 1 — provoke 402 (call args wrapped under _args so the server
    // can distinguish them from the payment envelope on retry)
    const wrappedBody = JSON.stringify({ _args: body })
    const r1 = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: wrappedBody,
    })

    if (r1.status !== 402) {
      // No payment required (free service or bug); just return the body
      const result = await r1.json() as T
      return { result, price: 0, paymentTxid: '', durationMs: Date.now() - t0, identityKey: '' }
    }

    const challenge = await r1.json() as any
    const price = challenge.price as number
    const serverIdentity = challenge.identityKey as string
    const derivationPrefix = challenge.derivationPrefix as string
    const derivationSuffix = challenge.derivationSuffix as string

    if (!serverIdentity || !derivationPrefix || !derivationSuffix || !price) {
      throw new Error(`malformed 402 challenge: ${JSON.stringify(challenge).slice(0, 200)}`)
    }

    // Step 2 — derive destination + createAction
    const destPub = this.setup!.keyDeriver.derivePublicKey(
      [2, '3241645161d8'],
      `${derivationPrefix} ${derivationSuffix}`,
      serverIdentity
    )
    const destAddress = destPub.toAddress(this.setup!.chain === 'main' ? 'mainnet' : 'testnet')
    const lockingScript = new P2PKH().lock(destAddress).toHex()

    const action = await this.setup!.wallet.createAction({
      description: `Pay ${capability} (${price}s)`.slice(0, 50),
      outputs: [{
        lockingScript,
        satoshis: price,
        outputDescription: 'BRC-29 service payment',
      }],
      options: { acceptDelayedBroadcast: false, randomizeOutputs: false },
    })

    if (!action.tx || !action.txid) {
      throw new Error('createAction did not return BEEF')
    }

    const beefBase64 = Buffer.from(action.tx).toString('base64')

    // Step 3 — retry with payment envelope in BODY (BEEF can exceed HTTP
    // header size limits, so it MUST go in the body, not a header).
    const r2 = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        _args: body,
        _payment: {
          beef: beefBase64,
          txid: action.txid,
          derivationPrefix,
          derivationSuffix,
          senderIdentityKey: this.identityKey,
        },
      }),
    })

    if (!r2.ok) {
      const errBody = await r2.text()
      throw new Error(`payment retry failed: HTTP ${r2.status} ${errBody.slice(0, 200)}`)
    }

    const result = await r2.json() as T
    return {
      result,
      price,
      paymentTxid: action.txid,
      durationMs: Date.now() - t0,
      identityKey: serverIdentity,
    }
  }
}
