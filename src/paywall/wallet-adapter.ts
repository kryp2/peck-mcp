/**
 * WalletAdapter — the surface PaywallClient uses to talk to a
 * BRC-100 wallet.
 *
 * Keep this minimal. Anything that needs private-key access stays
 * behind the adapter; PaywallClient never touches keys directly.
 *
 * Three production implementations expected:
 *   - AgentWalletAdapter (server-side, bitcoin-agent-wallet + keychain)
 *   - BrowserWalletAdapter (Babbage / bsv-desktop WebSocket)
 *   - MobileWalletAdapter (peck-mobile / RN)
 *
 * A LocalKeyAdapter (holds raw PrivateKey) is included below for
 * tests and examples; not for production use.
 */

import { PrivateKey, Utils, Hash } from '@bsv/sdk'

export interface WalletAdapter {
  /** BRC-100 identity pubkey, 33-byte compressed hex. */
  getPubKey(): Promise<string> | string

  /**
   * Sign a UTF-8 string with the identity key. Returns DER-hex
   * signature. Caller does the canonicalisation; the adapter
   * just signs the exact bytes handed to it.
   */
  sign(message: string): Promise<string>
}

/**
 * In-process adapter for tests and simple scripts. Holds a raw
 * PrivateKey. Do NOT use for production agents — those should go
 * through bitcoin-agent-wallet / keychain.
 */
export class LocalKeyAdapter implements WalletAdapter {
  constructor(private priv: PrivateKey) {}

  static fromHex(hex: string): LocalKeyAdapter {
    return new LocalKeyAdapter(PrivateKey.fromHex(hex))
  }

  static random(): LocalKeyAdapter {
    return new LocalKeyAdapter(PrivateKey.fromRandom())
  }

  getPubKey(): string {
    return this.priv.toPublicKey().toString()
  }

  async sign(message: string): Promise<string> {
    const hash = Hash.sha256(Utils.toArray(message, 'utf8'))
    const sig = this.priv.sign(hash)
    return Utils.toHex(sig.toDER() as number[])
  }
}
