/**
 * AP3B: Chronicle Opcode Integration — testnet demo
 *
 * Tests Chronicle-restored opcodes active on BSV testnet since block 1,713,168.
 * Mainnet activation: April 7, 2026 (block 943,816).
 *
 * Run: npx tsx src/test-chronicle.ts
 */
import { PrivateKey, Transaction } from '@bsv/sdk'
import {
  SIGHASH_OTDA,
  SIGHASH_ALL_OTDA,
  OP_SUBSTR,
  OP_LEFT,
  OP_2MUL,
  buildCapabilityLockingScript,
  buildScopeLockingScript,
  buildPriceDoublerScript,
  computePremiumPrice,
  CTFE_SCRIPTS,
  fillP2PKH,
  fillCapabilityScript,
  signWithOTDA,
  getOTDASigHashType,
} from './chronicle.js'

async function main() {
  console.log('=== AP3B: Chronicle Opcode Integration ===')
  console.log('Testnet active: block 1,713,168')
  console.log('Mainnet activation: April 7, 2026 (block 943,816)')
  console.log()

  // ── 1. OTDA Sighash ──────────────────────────────────────────
  console.log('--- 1. OTDA Sighash (0x20) ---')
  console.log(`SIGHASH_OTDA flag:  0x${SIGHASH_OTDA.toString(16).toUpperCase()}`)
  console.log(`SIGHASH_ALL_OTDA:   0x${SIGHASH_ALL_OTDA.toString(16).toUpperCase()} (SIGHASH_ALL | SIGHASH_OTDA)`)
  console.log(`getOTDASigHashType: 0x${getOTDASigHashType().toString(16).toUpperCase()}`)
  console.log('Purpose: multi-party agent signatures that span script boundaries')
  console.log()

  // ── 2. Capability-locking script (OP_SUBSTR) ─────────────────
  console.log('--- 2. Capability-locking script (OP_SUBSTR) ---')
  const agentKey = PrivateKey.fromRandom()
  const pubKeyHashBytes = agentKey.toPublicKey().toHash()
  const pubKeyHashArr = Array.from(pubKeyHashBytes)

  const capScript = buildCapabilityLockingScript(pubKeyHashArr, 'summarize')
  const capHex = capScript.toHex()
  console.log(`Opcode OP_SUBSTR:   0x${OP_SUBSTR.toString(16).toUpperCase()} (${OP_SUBSTR})`)
  console.log(`Capability:         "summarize"  (9 bytes)`)
  console.log(`Script hex (${capHex.length / 2} bytes): ${capHex}`)
  console.log('Unlocking pattern:  <sig> <pubkey> <"summarize:text">')
  console.log('Verification:       SUBSTR(cap_data, 0, 9) == "summarize"')
  console.log()

  // ── 3. Scope-restricted script (OP_LEFT) ─────────────────────
  console.log('--- 3. Scope-restricted script (OP_LEFT) ---')
  const scopeScript = buildScopeLockingScript(pubKeyHashArr, 'text')
  const scopeHex = scopeScript.toHex()
  console.log(`Opcode OP_LEFT:     0x${OP_LEFT.toString(16).toUpperCase()} (${OP_LEFT})`)
  console.log(`Scope prefix:       "text"  (4 bytes)`)
  console.log(`Script hex (${scopeHex.length / 2} bytes): ${scopeHex}`)
  console.log('Unlocking pattern:  <sig> <pubkey> <"text:english:v2">')
  console.log('Verification:       LEFT(scope_data, 4) == "text"')
  console.log()

  // ── 4. Price doubling via OP_2MUL ────────────────────────────
  console.log('--- 4. Price calculation (OP_2MUL) ---')
  const BASE_PRICE = 50
  const priceScript = buildPriceDoublerScript(BASE_PRICE)
  const premiumPrice = computePremiumPrice(BASE_PRICE)
  console.log(`Opcode OP_2MUL:     0x${OP_2MUL.toString(16).toUpperCase()} (${OP_2MUL})`)
  console.log(`Base price:         ${BASE_PRICE} sat`)
  console.log(`Premium (x2):       ${premiumPrice} sat`)
  console.log(`Script hex:         ${priceScript.toHex()}`)
  console.log(`On-chain effect:    push ${BASE_PRICE}, OP_2MUL => ${premiumPrice}`)
  console.log()

  // ── 5. CTFE pre-compiled templates ───────────────────────────
  console.log('--- 5. Pre-compiled script templates (CTFE) ---')
  const pubKeyHashHex = Buffer.from(pubKeyHashBytes).toString('hex')

  const p2pkhHex = fillP2PKH(pubKeyHashHex)
  const capTemplateHex = fillCapabilityScript(
    CTFE_SCRIPTS.CAPABILITY_SUMMARIZE_PREAMBLE,
    Buffer.from('summarize').toString('hex'),
    pubKeyHashHex,
  )

  console.log('Templates (hex, runtime-zero-cost):')
  console.log(`  P2PKH template:         ${CTFE_SCRIPTS.P2PKH_TEMPLATE}`)
  console.log(`  P2PKH filled:           ${p2pkhHex}`)
  console.log(`  Capability preamble:    ${CTFE_SCRIPTS.CAPABILITY_SUMMARIZE_PREAMBLE}  (OP_DUP OP_0 OP_9 OP_SUBSTR)`)
  console.log(`  Capability filled:      ${capTemplateHex}`)
  console.log(`  Scope "text" preamble:  ${CTFE_SCRIPTS.SCOPE_TEXT_PREAMBLE}  (OP_DUP OP_4 OP_LEFT)`)
  console.log(`  Payment receipt prefix: ${CTFE_SCRIPTS.PAYMENT_RECEIPT_PREFIX}`)
  console.log(`  Price doubler 50 sat:   ${CTFE_SCRIPTS.PRICE_DOUBLER_50SAT}  (01 32 OP_2MUL)`)
  console.log(`  Price doubler 100 sat:  ${CTFE_SCRIPTS.PRICE_DOUBLER_100SAT}  (01 64 OP_2MUL)`)
  console.log()

  // ── 6. Build a Chronicle transaction ─────────────────────────
  console.log('--- 6. Transaction with Chronicle locking scripts ---')
  const tx = new Transaction()

  // Output 0: capability-gated UTXO (OP_SUBSTR)
  tx.addOutput({
    satoshis: 1000,
    lockingScript: capScript,
  })

  // Output 1: scope-restricted UTXO (OP_LEFT)
  tx.addOutput({
    satoshis: 500,
    lockingScript: scopeScript,
  })

  // Output 2: price doubler script (OP_2MUL demo)
  tx.addOutput({
    satoshis: 0,
    lockingScript: priceScript,
  })

  console.log(`Outputs: ${tx.outputs.length}`)
  console.log(`  [0] capability gate (OP_SUBSTR): 1000 sat — ${capHex.length / 2} byte script`)
  console.log(`  [1] scope gate (OP_LEFT):          500 sat — ${scopeHex.length / 2} byte script`)
  console.log(`  [2] price doubler (OP_2MUL):         0 sat — ${priceScript.toHex().length / 2} byte script`)
  console.log(`Raw tx hex: ${tx.toHex()}`)
  console.log()

  // ── 7. OTDA signing demo ──────────────────────────────────────
  console.log('--- 7. OTDA multi-party signing ---')
  const { sigHex, sigHashType } = await signWithOTDA(tx, 0, agentKey)
  console.log(`Sighash type: 0x${sigHashType.toString(16).toUpperCase()} (SIGHASH_ALL | SIGHASH_OTDA)`)
  console.log(`OTDA sig (${sigHex.length / 2} bytes): ${sigHex.slice(0, 32)}...`)
  console.log()

  // ── Summary ───────────────────────────────────────────────────
  console.log('=== Summary ===')
  console.log('Chronicle opcodes demonstrated:')
  console.log('  OP_SUBSTR (0xC0): capability name extraction in locking script')
  console.log('  OP_LEFT   (0xC1): scope prefix verification in locking script')
  console.log('  OP_2MUL   (0x8E): on-chain price tier calculation')
  console.log('CTFE pre-compiled templates: P2PKH, capability-check, scope-check, payment-receipt')
  console.log('OTDA sighash (0x20): multi-party agent signature support')
  console.log()
  console.log('Next: fund a testnet wallet and broadcast via ARC (https://arc.gorillapool.io)')
  console.log('Explorer: https://whatsonchain.com (testnet)')
}

main().catch(console.error)
