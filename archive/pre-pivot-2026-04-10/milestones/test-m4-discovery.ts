/**
 * M4 — Capability discovery via on-chain advertisement.
 *
 * Flow:
 *   1. Seller publishes capability advert (self-tx + OP_RETURN with JSON)
 *   2. Seller boots ComputeWorker on advertised endpoint
 *   3. Buyer knows ONLY the seller address — discovers endpoint+price by
 *      scanning WoC tx history for that address
 *   4. Buyer pays + calls discovered endpoint
 */
import { PrivateKey } from '@bsv/sdk'
import { readFileSync } from 'fs'
import { UTXOManager } from './utxo-manager.js'
import { ComputeWorker } from './worker.js'
import { publishCapability, discoverByAddress, Capability } from './registry.js'

const SELLER_PORT = 5101

async function main() {
  const wallets = JSON.parse(readFileSync('.wallets.json', 'utf-8'))

  // === SELLER side ===
  const sellerKey = PrivateKey.fromHex(wallets.worker1.hex)
  const sellerAddress = wallets.worker1.address
  const sellerUtxo = new UTXOManager(sellerKey, 'test')
  console.log('Seller syncing UTXOs…')
  await sellerUtxo.initialSync()
  console.log('Seller:', sellerUtxo.stats())

  const cap: Capability = {
    name: 'echo-service',
    service: 'inference.echo',
    endpoint: `http://localhost:${SELLER_PORT}/infer`,
    pricePerCall: 100,
    pubkey: sellerKey.toPublicKey().toString(),
    ts: Date.now(),
  }

  console.log('\nPublishing capability advertisement on-chain…')
  const advertTxid = await publishCapability(sellerUtxo, cap)
  console.log(`✅ advert txid: ${advertTxid}`)
  console.log(`   https://test.whatsonchain.com/tx/${advertTxid}`)

  // Boot the actual service
  const seller = new ComputeWorker({
    name: 'seller-discoverable',
    key: sellerKey,
    port: SELLER_PORT,
    backend: 'echo',
    pricePerJob: cap.pricePerCall,
  })
  seller.start()
  await new Promise(r => setTimeout(r, 400))

  // === BUYER side ===
  console.log('\n\nBuyer discovering services at address:', sellerAddress)
  // Give WoC a moment to index the new advert
  await new Promise(r => setTimeout(r, 2500))

  const discovered = await discoverByAddress(sellerAddress, 'test', { retries: 12, retryDelayMs: 5000 })
  console.log(`Discovered ${discovered.length} capability/capabilities:`)
  for (const c of discovered) {
    console.log(`  • ${c.name} → ${c.endpoint} @ ${c.pricePerCall} sat`)
  }

  if (discovered.length === 0) {
    throw new Error('discovery returned 0 capabilities')
  }

  const target = discovered[0]
  console.log(`\nBuyer selected: ${target.name}`)

  // Buyer pays + calls
  const buyerKey = PrivateKey.fromHex(wallets.worker2.hex)
  const buyerUtxo = new UTXOManager(buyerKey, 'test')
  await buyerUtxo.initialSync()

  const { tx, txid } = await buyerUtxo.buildTx(
    sellerAddress,
    target.pricePerCall,
    { discovered: target.name, ts: Date.now() },
  )
  await buyerUtxo.broadcastNow(tx)
  console.log(`payment tx: ${txid}`)

  const res = await fetch(target.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-BSV-Payment-Txid': txid,
      'X-BSV-Payer': buyerKey.toAddress('testnet'),
    },
    body: JSON.stringify({ prompt: 'discovered call' }),
  })
  const data = await res.json() as any
  console.log(`seller responded: ${data.response}`)

  console.log('\n=== M4 SUCCESS ===')
  console.log(`advert tx:  https://test.whatsonchain.com/tx/${advertTxid}`)
  console.log(`payment tx: https://test.whatsonchain.com/tx/${txid}`)
  process.exit(0)
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })
