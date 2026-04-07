/**
 * AP3B: Chronicle Opcode Integration
 *
 * Chronicle activated on BSV testnet at block 1,713,168.
 * Mainnet activation: April 7, 2026 (block 943,816).
 *
 * Restored opcodes:
 *   OP_SUBSTR (0xC0) — extract substring: (string, begin, size) → substr
 *   OP_LEFT   (0xC1) — leftmost N bytes: (string, size) → left
 *   OP_2MUL   (0x8E) — multiply by 2: (n) → n*2
 *
 * SIGHASH_OTDA (0x20) — Original Transaction Digest Algorithm.
 *   Multi-party agent signatures use OTDA instead of BIP143.
 *   Full type: SIGHASH_ALL | SIGHASH_OTDA = 0x41 | 0x20 = 0x61
 */

import { Script, PrivateKey, Hash, Transaction } from '@bsv/sdk'

// ────────────────────────────────────────────────────────────
// Chronicle sighash flags
// ────────────────────────────────────────────────────────────

/** Standard sighash ALL (BIP143 / UAHF, used since 2017 fork) */
export const SIGHASH_ALL = 0x41

/**
 * OTDA sighash flag (Chronicle-restored, 0x20).
 *
 * Original Transaction Digest Algorithm — pre-BIP143 serialization.
 * Required for multi-party agent signatures that span script boundaries,
 * because OTDA includes the full input script rather than just scriptCode.
 *
 * OR with base type: 0x41 | 0x20 = 0x61
 */
export const SIGHASH_OTDA = 0x20

/** Combined sighash for multi-party agent transactions */
export const SIGHASH_ALL_OTDA = SIGHASH_ALL | SIGHASH_OTDA

// ────────────────────────────────────────────────────────────
// Restored Chronicle opcode constants
// ────────────────────────────────────────────────────────────

/** OP_SUBSTR (0xC0): pops (string, begin, size) → pushes substring */
export const OP_SUBSTR = 0xc0

/** OP_LEFT (0xC1): pops (string, size) → pushes leftmost N bytes */
export const OP_LEFT = 0xc1

/** OP_RIGHT (0xC2): pops (string, size) → pushes rightmost N bytes */
export const OP_RIGHT = 0xc2

/** OP_2MUL (0x8E): pops (n) → pushes n×2 */
export const OP_2MUL = 0x8e

/** OP_2DIV (0x8F): pops (n) → pushes n÷2 */
export const OP_2DIV = 0x8f

// ────────────────────────────────────────────────────────────
// Internal script encoding helpers
// ────────────────────────────────────────────────────────────

/** Push a small non-negative integer (0..16) using minimal encoding */
function pushSmallInt(n: number): number[] {
  if (n === 0) return [0x00]           // OP_0
  if (n >= 1 && n <= 16) return [0x50 + n] // OP_1 (0x51) .. OP_16 (0x60)
  return [0x01, n]                     // 1-byte pushdata for 17..255
}

/** Push a byte array with minimal pushdata prefix */
function pushData(data: number[]): number[] {
  if (data.length === 0) return [0x00]
  if (data.length <= 0x4b) return [data.length, ...data]
  if (data.length <= 0xff) return [0x4c, data.length, ...data]  // OP_PUSHDATA1
  return [0x4d, data.length & 0xff, (data.length >> 8) & 0xff, ...data] // OP_PUSHDATA2
}

// Standard opcode constants used in script building
const OP_DUP = 0x76
const OP_HASH160 = 0xa9
const OP_EQUALVERIFY = 0x88
const OP_CHECKSIG = 0xac
const OP_DROP = 0x75

// ────────────────────────────────────────────────────────────
// Capability-locking script (uses OP_SUBSTR)
// ────────────────────────────────────────────────────────────

/**
 * Build a capability-gated locking script using OP_SUBSTR (Chronicle).
 *
 * Unlocking stack (top → bottom): <cap_data>, <pubkey>, <sig>
 * where cap_data is ASCII "<capabilityName>:<scope>" e.g. "summarize:text"
 *
 * Script verifies:
 *   1. cap_data[0..nameLen] == capabilityName  (OP_SUBSTR)
 *   2. Standard P2PKH ownership proof
 *
 * Execution trace (stack top → bottom):
 *   Initial:         [cap, pubkey, sig]
 *   OP_DUP:          [cap, cap, pubkey, sig]
 *   push 0:          [0, cap, cap, pubkey, sig]
 *   push nameLen:    [nameLen, 0, cap, cap, pubkey, sig]
 *   OP_SUBSTR:       [name, cap, pubkey, sig]   ← Chronicle opcode
 *   push expected:   [expected, name, cap, pubkey, sig]
 *   OP_EQUALVERIFY:  [cap, pubkey, sig]
 *   OP_DROP:         [pubkey, sig]
 *   P2PKH:           []  (success)
 *
 * @param pubKeyHash  20-byte HASH160 of the agent's public key
 * @param capabilityName  expected capability name (ASCII, e.g. "summarize")
 */
export function buildCapabilityLockingScript(
  pubKeyHash: number[],
  capabilityName: string,
): Script {
  const capBytes = Array.from(Buffer.from(capabilityName, 'ascii'))
  const nameLen = capBytes.length

  const script: number[] = [
    OP_DUP,                        // duplicate cap_data
    ...pushSmallInt(0),            // push start position = 0
    ...pushSmallInt(nameLen),      // push size = nameLen
    OP_SUBSTR,                     // extract capability name  ← Chronicle
    ...pushData(capBytes),         // push expected capability
    OP_EQUALVERIFY,                // verify name matches
    OP_DROP,                       // discard original cap_data
    OP_DUP,                        // P2PKH start
    OP_HASH160,
    ...pushData(pubKeyHash),
    OP_EQUALVERIFY,
    OP_CHECKSIG,
  ]

  return Script.fromBinary(script)
}

// ────────────────────────────────────────────────────────────
// Scope-restricted locking script (uses OP_LEFT)
// ────────────────────────────────────────────────────────────

/**
 * Build a scope-restricted locking script using OP_LEFT (Chronicle).
 *
 * Unlocking stack (top → bottom): <scope_data>, <pubkey>, <sig>
 * where scope_data is ASCII e.g. "text:english:v2"
 *
 * Script verifies:
 *   1. left(scope_data, prefixLen) == scopePrefix  (OP_LEFT)
 *   2. Standard P2PKH ownership proof
 *
 * Execution trace:
 *   Initial:         [scope, pubkey, sig]
 *   OP_DUP:          [scope, scope, pubkey, sig]
 *   push prefixLen:  [prefixLen, scope, scope, pubkey, sig]
 *   OP_LEFT:         [prefix, scope, pubkey, sig]   ← Chronicle opcode
 *   push expected:   [expected, prefix, scope, pubkey, sig]
 *   OP_EQUALVERIFY:  [scope, pubkey, sig]
 *   OP_DROP:         [pubkey, sig]
 *   P2PKH:           []  (success)
 *
 * @param pubKeyHash  20-byte HASH160
 * @param scopePrefix  required left prefix of scope string
 */
export function buildScopeLockingScript(
  pubKeyHash: number[],
  scopePrefix: string,
): Script {
  const prefixBytes = Array.from(Buffer.from(scopePrefix, 'ascii'))

  const script: number[] = [
    OP_DUP,                        // duplicate scope_data
    ...pushSmallInt(prefixBytes.length), // push prefixLen
    OP_LEFT,                       // extract left prefix  ← Chronicle
    ...pushData(prefixBytes),      // push expected prefix
    OP_EQUALVERIFY,                // verify prefix matches
    OP_DROP,                       // discard original scope_data
    OP_DUP,                        // P2PKH start
    OP_HASH160,
    ...pushData(pubKeyHash),
    OP_EQUALVERIFY,
    OP_CHECKSIG,
  ]

  return Script.fromBinary(script)
}

// ────────────────────────────────────────────────────────────
// Price computation (OP_2MUL)
// ────────────────────────────────────────────────────────────

/**
 * Build a price-doubling script fragment using OP_2MUL (Chronicle).
 *
 * Demonstrates on-chain price calculation without pushdata overhead.
 * Used in payment-receipt scripts to encode both base and premium tiers.
 *
 * Stack before: [...]
 * Stack after:  [..., basePriceSatoshis * 2]
 *
 * @param basePriceSatoshis  base price; OP_2MUL computes premium = base × 2
 */
export function buildPriceDoublerScript(basePriceSatoshis: number): Script {
  // Bitcoin Script integer encoding (little-endian, signed magnitude)
  const encodeScriptInt = (n: number): number[] => {
    if (n === 0) return []
    const bytes: number[] = []
    let abs = Math.abs(n)
    while (abs > 0) { bytes.push(abs & 0xff); abs >>= 8 }
    if (bytes[bytes.length - 1] & 0x80) {
      bytes.push(n < 0 ? 0x80 : 0x00)
    } else if (n < 0) {
      bytes[bytes.length - 1] |= 0x80
    }
    return bytes
  }

  const priceBytes = encodeScriptInt(basePriceSatoshis)
  const script: number[] = [
    ...pushData(priceBytes),  // push base price
    OP_2MUL,                  // double it  ← Chronicle
  ]
  return Script.fromBinary(script)
}

/**
 * Compute premium price using OP_2MUL semantics (off-chain helper).
 * Mirrors the on-chain computation for local price validation.
 */
export function computePremiumPrice(basePriceSatoshis: number): number {
  return basePriceSatoshis * 2  // matches OP_2MUL
}

// ────────────────────────────────────────────────────────────
// Pre-compiled script templates (CTFE)
// ────────────────────────────────────────────────────────────

/**
 * Compile-Time Function Evaluation (CTFE) — pre-computed script hex templates.
 *
 * These byte arrays are computed once and stored as constants.
 * At runtime: decode hex, splice in the variable parts (pubkey hashes, etc.).
 * Goal: 0-cost script construction for standard templates.
 *
 * All hex strings are lowercase and represent raw script bytes.
 */
export const CTFE_SCRIPTS = {
  /**
   * P2PKH template (25 bytes total).
   * Slots: bytes 3..22 = 20-byte pubkey hash (replace '00'.repeat(20))
   *
   * 76 a9 14 [20-byte PKH] 88 ac
   */
  P2PKH_TEMPLATE: '76a914' + '00'.repeat(20) + '88ac',

  /**
   * Capability check preamble for "summarize" capability (9 bytes name).
   * OP_DUP OP_0 OP_9 OP_SUBSTR
   * 76 00 59 c0
   *
   * Prefix this before the EQUALVERIFY + P2PKH suffix.
   */
  CAPABILITY_SUMMARIZE_PREAMBLE: '76' + '00' + '59' + 'c0',

  /**
   * Capability check preamble for "translate" capability (9 bytes name).
   * Same byte sequence — same length as "summarize".
   * 76 00 59 c0
   */
  CAPABILITY_TRANSLATE_PREAMBLE: '76' + '00' + '59' + 'c0',

  /**
   * Scope prefix check for "text" scope (4 bytes).
   * OP_DUP OP_4 OP_LEFT
   * 76 54 c1
   */
  SCOPE_TEXT_PREAMBLE: '76' + '54' + 'c1',

  /**
   * Payment receipt OP_RETURN prefix.
   * OP_FALSE OP_RETURN <0x0b> <'agentic-pay'>
   * 00 6a 0b 6167656e7469632d706179
   */
  PAYMENT_RECEIPT_PREFIX:
    '006a0b' + Buffer.from('agentic-pay').toString('hex'),

  /**
   * Price doubler: push 50 sat, OP_2MUL → 100 sat on stack.
   * OP_DATA_1 0x32 OP_2MUL
   * 01 32 8e
   */
  PRICE_DOUBLER_50SAT: '01' + '32' + '8e',

  /**
   * Price doubler: push 100 sat, OP_2MUL → 200 sat on stack.
   * OP_DATA_1 0x64 OP_2MUL
   * 01 64 8e
   */
  PRICE_DOUBLER_100SAT: '01' + '64' + '8e',
} as const

/**
 * Fill the P2PKH template with a 20-byte pubkey hash.
 * @param pubKeyHashHex  40 hex chars (20 bytes)
 */
export function fillP2PKH(pubKeyHashHex: string): string {
  if (pubKeyHashHex.length !== 40) {
    throw new Error(`pubKeyHash must be 20 bytes (40 hex chars), got ${pubKeyHashHex.length}`)
  }
  return '76a914' + pubKeyHashHex + '88ac'
}

/**
 * Fill a capability-check script template.
 * @param preamble  CTFE preamble hex (e.g. CTFE_SCRIPTS.CAPABILITY_SUMMARIZE_PREAMBLE)
 * @param expectedNameHex  hex of expected capability name bytes
 * @param pubKeyHashHex  40 hex chars
 */
export function fillCapabilityScript(
  preamble: string,
  expectedNameHex: string,
  pubKeyHashHex: string,
): string {
  if (pubKeyHashHex.length !== 40) {
    throw new Error(`pubKeyHash must be 40 hex chars, got ${pubKeyHashHex.length}`)
  }
  const nameLen = expectedNameHex.length / 2
  const namePush = nameLen.toString(16).padStart(2, '0') + expectedNameHex
  return preamble + namePush + '88' + // OP_EQUALVERIFY
    '75' +                             // OP_DROP
    '76a914' + pubKeyHashHex + '88ac'  // P2PKH
}

// ────────────────────────────────────────────────────────────
// OTDA multi-party signing
// ────────────────────────────────────────────────────────────

/**
 * Return the OTDA sighash type byte for multi-party agent transactions.
 *
 * Full OTDA signing requires the Zeta crypto core (ZeroMQ bridge), which
 * implements the original transaction serialization algorithm natively.
 * This TypeScript layer computes the sighash type for protocol handshaking.
 */
export function getOTDASigHashType(): number {
  return SIGHASH_ALL_OTDA  // 0x61
}

/**
 * Build an OTDA signing context for a transaction input.
 *
 * The OTDA preimage includes the full input script (not just scriptCode),
 * enabling multi-agent cross-input authorization that BIP143 cannot express.
 *
 * Production signing routes through Zeta ZMQ bridge (src/zeta-wasm-bridge.ts).
 * This shim demonstrates the protocol flow for TypeScript-only agents.
 *
 * @param tx          transaction to sign
 * @param inputIndex  which input to sign
 * @param privKey     signing key
 * @returns DER signature hex + 0x61 sighash type suffix
 */
export async function signWithOTDA(
  tx: Transaction,
  inputIndex: number,
  privKey: PrivateKey,
): Promise<{ sigHex: string; sigHashType: number }> {
  // OTDA preimage: SHA256d(txHex || inputIndex_LE32 || sighashType_byte)
  const txBytes = Array.from(Buffer.from(tx.toHex(), 'hex'))
  const idxBuf = Buffer.alloc(4)
  idxBuf.writeUInt32LE(inputIndex)
  const preimage = [
    ...txBytes,
    ...Array.from(idxBuf),
    SIGHASH_ALL_OTDA,
  ]

  const hash1 = Hash.sha256(preimage)
  const hash2 = Hash.sha256(hash1)
  const sig = privKey.sign(hash2)
  const derSig = Buffer.from(sig.toDER()).toString('hex')
  const sigWithType = derSig + SIGHASH_ALL_OTDA.toString(16).padStart(2, '0')

  return { sigHex: sigWithType, sigHashType: SIGHASH_ALL_OTDA }
}
