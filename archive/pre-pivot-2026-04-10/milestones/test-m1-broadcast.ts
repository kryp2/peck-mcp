/**
 * M1 sanity test: load gateway wallet, sync UTXOs from WoC,
 * build & broadcast a tiny payment to worker1, log the txid.
 */
import { PrivateKey } from '@bsv/sdk'
import { readFileSync } from 'fs'
import { UTXOManager } from './utxo-manager.js'

interface WalletData {
  gateway: { hex: string; address: string }
  worker1: { hex: string; address: string }
  worker2: { hex: string; address: string }
}

async function main() {
  const wallets: WalletData = JSON.parse(readFileSync('.wallets.json', 'utf-8'))

  console.log('Loading gateway wallet…')
  const key = PrivateKey.fromHex(wallets.gateway.hex)
  const mgr = new UTXOManager(key, 'test')

  console.log(`Address: ${mgr.getAddress()}`)
  console.log('Initial sync from WoC…')
  await mgr.initialSync()
  console.log('Stats after sync:', mgr.stats())

  if (mgr.balance < 2000) {
    throw new Error(`Balance too low: ${mgr.balance} sat`)
  }

  console.log('\nBuilding 1000 sat → worker1 with OP_RETURN commitment…')
  const { tx, txid } = await mgr.buildTx(
    wallets.worker1.address,
    1000,
    { test: 'm1-sanity', ts: Date.now() },
  )
  console.log(`Built txid: ${txid}`)
  console.log(`Tx size:    ${tx.toHex().length / 2} bytes`)

  console.log('\nBroadcasting via ARC…')
  const broadcastTxid = await mgr.broadcastNow(tx)
  console.log(`✅ ARC accepted: ${broadcastTxid}`)
  console.log(`   Explorer: https://test.whatsonchain.com/tx/${broadcastTxid}`)

  console.log('\nFinal stats:', mgr.stats())
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })
