/**
 * Wallet bootstrap diagnostics.
 *
 * peck-mcp first reads the identity key from the OS keychain, then opens a
 * wallet-toolbox SQLite store for it. The two steps fail for different reasons
 * and need opposite fixes:
 *
 *  - keychain: no key stored (create or migrate one), or the keychain itself is
 *    unreachable (libsecret/DBus on Linux).
 *  - storage: the key loaded fine, but the wallet store would not open. The
 *    common case is a native module (better-sqlite3) built for a different
 *    Node.js ABI after a Node upgrade.
 *
 * Before this module both cases surfaced as `identity_key: null` plus advice to
 * generate a fresh key, which for a storage failure would silently replace an
 * existing, funded identity.
 */

export type WalletInitStage = 'keychain' | 'storage'

export interface WalletInitFailure {
  stage: WalletInitStage
  /** true when the keychain simply has no key for this account. */
  missingKey: boolean
  error: string
  hint: string
}

const ABI_MISMATCH = /NODE_MODULE_VERSION|compiled against a different Node\.js version/i
const NO_KEY = /No identity key found in keychain/i

const KEEP_KEY =
  'Your identity key is intact — do NOT generate a new key; that would replace this identity.'

export function describeWalletInitFailure(
  stage: WalletInitStage,
  err: unknown,
  nodeVersion: string = process.version,
): WalletInitFailure {
  const error = String((err as any)?.message ?? err).trim()

  if (stage === 'keychain') {
    if (NO_KEY.test(error)) {
      return {
        stage,
        missingKey: true,
        error,
        hint:
          'No identity key is stored in the OS keychain for this account. Migrate a legacy ' +
          '~/.peck/identity.json (picked up automatically on start) or store a new key, then restart peck-mcp.',
      }
    }
    return {
      stage,
      missingKey: false,
      error,
      hint:
        'Could not read the OS keychain. On Linux peck-mcp needs libsecret and a running, unlocked ' +
        'Secret Service (DBus session). Fix keychain access and restart peck-mcp. Do not generate a new ' +
        'key until the keychain is readable — the existing key is probably still there.',
    }
  }

  if (ABI_MISMATCH.test(error)) {
    return {
      stage,
      missingKey: false,
      error,
      hint:
        `The native SQLite driver (better-sqlite3) in this peck-mcp install was built for a different ` +
        `Node.js version than the one running it (${nodeVersion}). Reinstall peck-mcp under the current ` +
        'Node (`npm install -g peck-mcp`) or run `npm rebuild better-sqlite3` in the peck-mcp install ' +
        `directory, then restart the MCP server. ${KEEP_KEY}`,
    }
  }

  return {
    stage,
    missingKey: false,
    error,
    hint:
      'The identity key loaded from the keychain, but the wallet storage failed to open. ' +
      `Fix the error above and restart peck-mcp. ${KEEP_KEY}`,
  }
}
