/**
 * overlay-get.ts — paywall-aware replacement for `overlayGet(path)`.
 *
 * Behaviour:
 *   - If PAYWALL_CLIENT_ENABLED is false (default): plain fetch,
 *     no receipts. Matches existing peck-mcp behaviour.
 *   - If enabled: wraps requests in a PaywallClient that auto-opens
 *     a channel, signs drain receipts, advances local state, and
 *     transparently retries after 402.
 *
 * The agent wallet (bitcoin-agent-wallet) supplies the BRC-100
 * identity key that signs drains.
 */

import { PaywallClient } from './paywall-client.js'
import { LocalKeyAdapter, type WalletAdapter } from './wallet-adapter.js'
import { PrivateKey, BSM, Utils, type Signature } from '@bsv/sdk'

const PAYWALL_CLIENT_ENABLED = process.env.PAYWALL_CLIENT_ENABLED === 'true'
const AUTO_OPEN_DEPOSIT = parseInt(
  process.env.PAYWALL_AUTO_DEPOSIT_SATS || '10000',
  10,
)

/**
 * Adapter over bitcoin-agent-wallet's identity key.
 *
 * Keeps signing on the MCP side; the agent wallet already owns
 * this key for other BRC-100 operations (AIP on posts, identity
 * certs, etc), so the paywall client is just reusing it.
 */
export class AgentKeyAdapter implements WalletAdapter {
  constructor(private priv: PrivateKey) {}

  getPubKey(): string {
    return this.priv.toPublicKey().toString()
  }

  async sign(message: string): Promise<string> {
    const msg = Utils.toArray(message, 'utf8')
    const sig = BSM.sign(msg, this.priv, 'raw') as Signature
    return Utils.toHex(sig.toDER() as number[])
  }
}

let _client: PaywallClient | null = null

/** Initialise the shared PaywallClient. Safe to call multiple times. */
export function initPaywallClient(
  overlayUrl: string,
  privKey: PrivateKey,
): PaywallClient {
  if (_client) return _client
  _client = new PaywallClient({
    overlay: overlayUrl,
    wallet: new AgentKeyAdapter(privKey),
    autoOpenDeposit: AUTO_OPEN_DEPOSIT,
  })
  return _client
}

export function getPaywallClient(): PaywallClient | null {
  return _client
}

export function isPaywallClientEnabled(): boolean {
  return PAYWALL_CLIENT_ENABLED
}

/**
 * Drop-in replacement for the legacy `overlayGet(path)`.
 *
 * When paywall is disabled, behaves identically. When enabled,
 * parses `path` into endpoint+args and routes via PaywallClient
 * so receipts attach automatically.
 */
export async function overlayGetPaywall(
  legacyOverlayUrl: string,
  path: string,
): Promise<any> {
  // Off: plain fetch, old semantics.
  if (!PAYWALL_CLIENT_ENABLED || !_client) {
    const r = await fetch(`${legacyOverlayUrl}${path}`)
    return r.json()
  }

  // On: parse path, route via PaywallClient.
  const [pathPart, queryPart = ''] = path.split('?')
  const endpoint = pathPart.replace(/^\/v1\//, '').replace(/^\//, '')
  const args: Record<string, string> = {}
  if (queryPart) {
    for (const [k, v] of new URLSearchParams(queryPart)) args[k] = v
  }

  try {
    return await _client.fetch(endpoint, args)
  } catch (e: any) {
    // Surface paywall errors as MCP-friendly error objects.
    return { error: e?.message ?? String(e), paywall: true }
  }
}
