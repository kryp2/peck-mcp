/**
 * AP6A demo: execute EVM bytecode off-chain and anchor result to BSV.
 *
 * Flow:
 *   1. Boot evm-compute-agent on port 3010
 *   2. Run a tiny EVM program (5 + 7 = 12) → get receipt
 *   3. Run keccak256(0x00) → get receipt
 *   4. Build a BSV testnet TX whose OP_RETURN commits to the
 *      execution_hash + gas_used (the cryptographic proof of compute)
 *   5. Broadcast via TAAL ARC
 *   6. Print txid + ETH-equivalent gas savings
 */
import { PrivateKey, Transaction } from '@bsv/sdk'
import { readFileSync } from 'fs'
import { UTXOManager } from './utxo-manager.js'
import './agents/evm-compute.js'  // boots ServiceAgent on 3010
import { DEMO_ADD_BYTECODE, DEMO_KECCAK_BYTECODE } from './evm-executor.js'

const HEADERS = {
  'Content-Type': 'application/json',
  'X-Payment-Tx': 'demo-bypass',
}

async function callEvm(capability: string, body: any) {
  const r = await fetch(`http://localhost:3010/${capability}`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return await r.json() as any
}

async function pickFreshUtxo(address: string): Promise<{ txid: string; vout: number; sats: number }> {
  const r = await fetch(`https://api.whatsonchain.com/v1/bsv/test/address/${address}/unspent`)
  const list = await r.json() as Array<{ tx_hash: string; tx_pos: number; value: number; height: number }>
  const mempool = list.filter(u => u.height === 0).sort((a, b) => b.value - a.value)
  if (mempool.length > 0) return { txid: mempool[0].tx_hash, vout: mempool[0].tx_pos, sats: mempool[0].value }
  list.sort((a, b) => b.value - a.value)
  return { txid: list[0].tx_hash, vout: list[0].tx_pos, sats: list[0].value }
}

async function main() {
  // Wait for evm-compute-agent to bind
  await new Promise(r => setTimeout(r, 600))

  console.log('=== AP6A — EVM-as-a-Service on BSV ===\n')

  // 1) Trivial computation: 5 + 7
  console.log('▶ Executing: 5 + 7 (raw EVM bytecode)')
  const addResult = await callEvm('execute', { bytecode: DEMO_ADD_BYTECODE })
  console.log(`  ok: ${addResult.ok}`)
  console.log(`  return: ${addResult.receipt.return_value_hex} (= ${parseInt(addResult.receipt.return_value_hex.replace('0x', '') || '0', 16)})`)
  console.log(`  gas_used: ${addResult.receipt.gas_used}`)
  console.log(`  exec_hash: ${addResult.receipt.execution_hash}`)
  console.log(`  duration: ${addResult.receipt.duration_ms}ms`)

  // 2) keccak256
  console.log('\n▶ Executing: keccak256 of one zero byte')
  const keccakResult = await callEvm('execute', { bytecode: DEMO_KECCAK_BYTECODE })
  console.log(`  ok: ${keccakResult.ok}`)
  console.log(`  return: ${keccakResult.receipt.return_value_hex}`)
  console.log(`  gas_used: ${keccakResult.receipt.gas_used}`)
  console.log(`  exec_hash: ${keccakResult.receipt.execution_hash}`)

  // 3) Anchor both execution proofs to BSV
  console.log('\n▶ Anchoring proofs to BSV testnet…')
  const wallets = JSON.parse(readFileSync('.wallets.json', 'utf-8'))
  const key = PrivateKey.fromHex(wallets.gateway.hex)
  const mgr = new UTXOManager(key, 'test')

  const seed = await pickFreshUtxo(wallets.gateway.address)
  console.log(`  seed: ${seed.txid}:${seed.vout} (${seed.sats} sat)`)
  const r = await fetch(`https://api.whatsonchain.com/v1/bsv/test/tx/${seed.txid}/hex`)
  mgr.addFromTx(Transaction.fromHex((await r.text()).trim()), seed.txid, seed.vout, seed.sats)

  // Combined OP_RETURN payload: both exec hashes + gas totals
  const payload = JSON.stringify({
    p: 'AP6A',
    add: { h: addResult.receipt.execution_hash.slice(0, 16), g: addResult.receipt.gas_used },
    kek: { h: keccakResult.receipt.execution_hash.slice(0, 16), g: keccakResult.receipt.gas_used },
    ts: Date.now(),
  })
  const { tx, txid } = await mgr.buildAdvertTx('AP6A', payload)
  await mgr.broadcastNow(tx)
  console.log(`  ✅ anchored: ${txid}`)
  console.log(`     https://test.whatsonchain.com/tx/${txid}`)

  // 4) Cost comparison
  console.log('\n=== Cost comparison ===')
  const addGas = parseInt(addResult.receipt.gas_used)
  const keccakGas = parseInt(keccakResult.receipt.gas_used)
  const totalGas = addGas + keccakGas
  // Realistic Ethereum mainnet: ~30 gwei base + priority, ETH ~$3500
  const ethGwei = 30
  const ethUsd = 3500
  const ethCostUsd = (totalGas * ethGwei * 1e-9) * ethUsd
  // Our cost: 100 sat per call × 2 = 200 sat. BSV ~$70.
  const bsvCostUsd = (200 * 1e-8) * 70
  console.log(`  trivial demo (${totalGas} gas):`)
  console.log(`    on Ethereum @ 30 gwei:   $${ethCostUsd.toFixed(6)}`)
  console.log(`    on Peck Pay (200 sat):   $${bsvCostUsd.toFixed(8)}`)
  console.log(`    savings factor:          ${(ethCostUsd / bsvCostUsd).toFixed(0)}×`)
  // Realistic comparison: ERC-20 transfer ~50 000 gas, complex DeFi calls ~300 000 gas
  console.log(`\n  extrapolated to realistic workloads (per call):`)
  const erc20EthCost = (50_000 * ethGwei * 1e-9) * ethUsd
  const defiEthCost = (300_000 * ethGwei * 1e-9) * ethUsd
  const peckPayPer = (100 * 1e-8) * 70  // 100 sat per call
  console.log(`    ERC-20 transfer (50K gas):  Eth $${erc20EthCost.toFixed(2)}  vs Peck $${peckPayPer.toFixed(8)}  → ${(erc20EthCost / peckPayPer).toFixed(0)}×`)
  console.log(`    Complex DeFi   (300K gas):  Eth $${defiEthCost.toFixed(2)}  vs Peck $${peckPayPer.toFixed(8)}  → ${(defiEthCost / peckPayPer).toFixed(0)}×`)

  process.exit(0)
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })
