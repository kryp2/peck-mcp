/**
 * M3 — Two AI agents with individual BSV wallets, trading directly.
 *
 * Seller agent: ComputeWorker (worker1 wallet, echo backend) on port 5001
 * Buyer agent:  driver with own UTXOManager (worker2 wallet)
 *
 * Per request:
 *   1. Buyer builds payment TX (buyer → seller, price + OP_RETURN proof)
 *   2. Buyer broadcasts via WoC
 *   3. Buyer POSTs prompt + txid header to seller /infer
 *   4. Seller responds with inference result
 *
 * Both agents have on-chain wallets — fulfills hackathon requirement
 * "2+ AI agents with individual BSV wallets".
 */
import { PrivateKey, Hash } from '@bsv/sdk'
import { readFileSync } from 'fs'
import { UTXOManager } from './utxo-manager.js'
import { ComputeWorker } from './worker.js'

const SELLER_PORT = 5001
const PRICE_SAT = 100
const ROUNDS = 3

function sha256Hex(s: string): string {
  const bytes = Hash.sha256(Array.from(new TextEncoder().encode(s)))
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function main() {
  const wallets = JSON.parse(readFileSync('.wallets.json', 'utf-8'))

  // === Seller agent (worker1) ===
  const sellerKey = PrivateKey.fromHex(wallets.worker1.hex)
  const seller = new ComputeWorker({
    name: 'seller-agent',
    key: sellerKey,
    port: SELLER_PORT,
    backend: 'echo',
    pricePerJob: PRICE_SAT,
  })
  seller.start()
  await new Promise(r => setTimeout(r, 400))

  // === Buyer agent (worker2) ===
  const buyerKey = PrivateKey.fromHex(wallets.worker2.hex)
  const buyerUtxo = new UTXOManager(buyerKey, 'test')
  console.log('Buyer agent syncing UTXOs…')
  await buyerUtxo.initialSync()
  console.log('Buyer:', buyerUtxo.stats())

  if (buyerUtxo.balance < PRICE_SAT * ROUNDS + 500) {
    throw new Error(`Buyer balance too low: ${buyerUtxo.balance}`)
  }

  // === Trading loop ===
  const txids: string[] = []
  for (let i = 1; i <= ROUNDS; i++) {
    const prompt = `round-${i}: what is ${i} + ${i}?`
    const promptHash = sha256Hex(prompt)
    console.log(`\n--- round ${i} ---`)
    console.log(`buyer prompt: "${prompt}"`)

    // 1. Build & broadcast payment
    const t0 = Date.now()
    const { tx, txid } = await buyerUtxo.buildTx(
      wallets.worker1.address,
      PRICE_SAT,
      { agent: 'buyer', service: 'seller-agent', round: i, promptHash },
    )
    await buyerUtxo.broadcastNow(tx)
    const tBroadcast = Date.now() - t0
    console.log(`payment tx ${txid} (${tBroadcast}ms)`)

    // 2. Call seller with proof header
    const t1 = Date.now()
    const res = await fetch(`http://localhost:${SELLER_PORT}/infer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BSV-Payment-Txid': txid,
        'X-BSV-Payer': buyerKey.toAddress('testnet'),
      },
      body: JSON.stringify({ prompt }),
    })
    const data = await res.json() as any
    console.log(`seller responded in ${Date.now() - t1}ms: ${data.response}`)
    txids.push(txid)
  }

  console.log('\n=== summary ===')
  console.log(`buyer wallet:  ${wallets.worker2.address}`)
  console.log(`seller wallet: ${wallets.worker1.address}`)
  console.log(`payments broadcast: ${txids.length}`)
  txids.forEach((t, i) => console.log(`  ${i + 1}. https://test.whatsonchain.com/tx/${t}`))
  console.log('\nbuyer final stats:', buyerUtxo.stats())

  // Verify last txid via WoC
  const last = txids[txids.length - 1]
  const woc = await fetch(`https://api.whatsonchain.com/v1/bsv/test/tx/hash/${last}`)
  console.log(`WoC verify last tx: HTTP ${woc.status}`)

  process.exit(0)
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })
