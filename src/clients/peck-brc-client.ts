/**
 * peck-brc-client — pluggable wallet/auth wrapper for cross-service calls.
 *
 * Three backend modes:
 *
 *   1. embedded   — no external wallet, plain fetch against URLs that don't
 *                   require auth (the local bank-local / storage-local
 *                   internal APIs in the hackathon dev stack). Cannot pay
 *                   402 challenges. Cannot mutually-authenticate with
 *                   public BRC-100 services. This is the default.
 *
 *   2. peck-desktop — connects to a running peck-desktop instance (or any
 *                   compatible BRC-100 wallet) via HTTPWalletJSON over
 *                   http://127.0.0.1:3321 (default) or a custom URL. Wraps
 *                   the resulting WalletInterface in AuthFetch for full
 *                   BRC-104 auth + automatic 402 payment handling. The
 *                   user's existing keys + funds are used.
 *
 *   3. brc100     — same as peck-desktop but with an arbitrary BRC-100
 *                   wallet URL (other wallet implementations, hosted
 *                   wallet services, dedicated agent wallets, etc).
 *
 * Caller pattern:
 *
 *   const client = PeckBrcClient.fromEnv()        // dispatches on env
 *   const r = await client.fetch(url, { method: 'POST', body: ... })
 *
 * Caller does NOT know which mode it's in. The mode determines whether
 * the request is plain HTTP (embedded) or BRC-104-authenticated +
 * 402-payment-aware (peck-desktop / brc100).
 *
 * Env selection:
 *
 *   PECK_WALLET_BACKEND=embedded          (default)
 *   PECK_WALLET_BACKEND=peck-desktop      [+ optional PECK_WALLET_URL]
 *   PECK_WALLET_BACKEND=brc100            [+ required PECK_WALLET_URL]
 *   PECK_WALLET_ORIGINATOR=peck-pay-mcp   (string identifying us to the wallet)
 *
 * The originator string is what the wallet uses to scope spending
 * approvals and allowances per app. For peck-desktop the user grants a
 * monthly budget keyed to this string, and all subsequent calls under
 * that budget go through silently.
 */
import { AuthFetch, HTTPWalletJSON, type WalletInterface } from '@bsv/sdk'

export type PeckBrcBackend =
  | { kind: 'embedded' }
  | { kind: 'peck-desktop'; url?: string }
  | { kind: 'brc100'; url: string }

export interface PeckBrcClientOptions {
  backend?: PeckBrcBackend
  originator?: string
}

const DEFAULT_PECK_DESKTOP_URL = 'http://127.0.0.1:3321'
const DEFAULT_ORIGINATOR = 'peck-pay-mcp'

export class PeckBrcClient {
  readonly backend: PeckBrcBackend
  readonly originator: string
  readonly wallet: WalletInterface | null
  readonly authFetch: AuthFetch | null

  private constructor(opts: {
    backend: PeckBrcBackend
    originator: string
    wallet: WalletInterface | null
    authFetch: AuthFetch | null
  }) {
    this.backend = opts.backend
    this.originator = opts.originator
    this.wallet = opts.wallet
    this.authFetch = opts.authFetch
  }

  /**
   * Build a client from the given options. For 'peck-desktop' / 'brc100'
   * backends, this also constructs an AuthFetch instance ready for use.
   * Embedded backend has no wallet — fetch() falls back to native fetch.
   */
  static create(opts: PeckBrcClientOptions = {}): PeckBrcClient {
    const backend = opts.backend ?? { kind: 'embedded' }
    const originator = opts.originator ?? process.env.PECK_WALLET_ORIGINATOR ?? DEFAULT_ORIGINATOR

    if (backend.kind === 'embedded') {
      return new PeckBrcClient({ backend, originator, wallet: null, authFetch: null })
    }

    const url =
      backend.kind === 'peck-desktop'
        ? (backend.url ?? process.env.PECK_WALLET_URL ?? DEFAULT_PECK_DESKTOP_URL)
        : backend.url
    if (!url) throw new Error('PeckBrcClient: brc100 backend requires url')

    // HTTPWalletJSON signature: (originator, baseUrl, httpClient?)
    const wallet = new HTTPWalletJSON(originator, url) as unknown as WalletInterface
    const authFetch = new AuthFetch(wallet)
    return new PeckBrcClient({ backend, originator, wallet, authFetch })
  }

  /**
   * Construct from environment variables. Defaults to embedded.
   *
   *   PECK_WALLET_BACKEND     = embedded | peck-desktop | brc100  (default: embedded)
   *   PECK_WALLET_URL         = wallet URL (peck-desktop / brc100)
   *   PECK_WALLET_ORIGINATOR  = string identifier (default: peck-pay-mcp)
   */
  static fromEnv(): PeckBrcClient {
    const kind = (process.env.PECK_WALLET_BACKEND ?? 'embedded') as 'embedded' | 'peck-desktop' | 'brc100'
    if (kind === 'embedded') return PeckBrcClient.create({ backend: { kind: 'embedded' } })
    if (kind === 'peck-desktop') return PeckBrcClient.create({ backend: { kind: 'peck-desktop' } })
    if (kind === 'brc100') {
      const url = process.env.PECK_WALLET_URL
      if (!url) throw new Error('PECK_WALLET_BACKEND=brc100 requires PECK_WALLET_URL')
      return PeckBrcClient.create({ backend: { kind: 'brc100', url } })
    }
    throw new Error(`unknown PECK_WALLET_BACKEND: ${kind}`)
  }

  /**
   * Fetch with the right transport for the configured backend.
   *
   * - embedded: plain fetch (no auth, no payment). Caller is expected to
   *   target services that don't need either (local bank-local internalApi,
   *   local storage-local fake-gcs, etc).
   *
   * - peck-desktop / brc100: routes through AuthFetch which performs BRC-104
   *   mutual auth on every call AND auto-handles 402 Payment Required by
   *   building/sending a BSV transaction via the wallet's createAction()
   *   then retrying.
   *
   * Returns a Response-like object in both modes (native Response for
   * embedded, AuthFetch's Response-shaped wrapper for the others).
   */
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    if (this.authFetch) {
      // Translate the standard fetch init shape into AuthFetch's
      // SimplifiedFetchRequestOptions. AuthFetch supports method, headers,
      // and body — same names, fewer features.
      const config: any = {
        method: init?.method,
        headers: init?.headers as any,
        body: init?.body,
      }
      return this.authFetch.fetch(url, config)
    }
    return fetch(url, init)
  }

  /**
   * Returns true if this client can authenticate / pay against a BRC-100
   * service. Useful for callers that want to gate prod-only code paths
   * (e.g. "skip storage.peck.to upload if running with embedded wallet").
   */
  get canAuthenticate(): boolean {
    return this.authFetch !== null
  }

  /**
   * Identity public key from the wallet. Returns null in embedded mode
   * since there's no wallet identity to extract.
   */
  async identityKey(): Promise<string | null> {
    if (!this.wallet) return null
    const r = await this.wallet.getPublicKey({ identityKey: true })
    return r.publicKey
  }
}
