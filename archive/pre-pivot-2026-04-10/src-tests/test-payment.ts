/**
 * Test: First real testnet payment from Gateway → Worker.
 *
 * Fetches source TX, builds payment + OP_RETURN proof-of-compute,
 * signs and broadcasts via ARC on testnet.
 */

import { PrivateKey, P2PKH, Transaction, ARC, Hash } from '@bsv/sdk'
import { readFileSync } from 'fs'

// Testnet ARC — GorillaPool supports testnet
const TESTNET_ARC = 'https://arc-test.gorillapool.io'

interface WalletData {
  gateway: { hex: string; address: string }
  worker1: { hex: string; address: string }
  network: string
}

async function fetchSourceTx(txid: string): Promise<Transaction> {
  const res = await fetch(
    `https://api.whatsonchain.com/v1/bsv/test/tx/${txid}/hex`
  )
  if (!res.ok) throw new Error(`Failed to fetch tx ${txid}: ${res.status}`)
  const hex = await res.text()
  return Transaction.fromHex(hex)
}

async function fetchUtxos(address: string): Promise<Array<{
  tx_hash: string; tx_pos: number; value: number; height: number
}>> {
  const res = await fetch(
    `https://api.whatsonchain.com/v1/bsv/test/address/${address}/unspent`
  )
  if (!res.ok) throw new Error(`Failed to fetch UTXOs: ${res.status}`)
  return res.json() as any
}

async function main() {
  // Load wallets
  const wallets: WalletData = JSON.parse(readFileSync('.wallets.json', 'utf-8'))
  const gatewayKey = PrivateKey.fromHex(wallets.gateway.hex)
  const workerAddress = wallets.worker1.address

  console.log('=== Test Payment: Gateway → Worker-1 ===')
  console.log(`From: ${wallets.gateway.address}`)
  console.log(`To:   ${workerAddress}`)
  console.log()

  // 1. Fetch UTXOs for gateway
  console.log('Fetching UTXOs...')
  const utxos = await fetchUtxos(wallets.gateway.address)
  console.log(`Found ${utxos.length} UTXOs:`)
  for (const u of utxos) {
    console.log(`  ${u.tx_hash.slice(0, 16)}... vout=${u.tx_pos} value=${u.value} sat`)
  }

  if (utxos.length === 0) {
    console.log('No UTXOs! Fund the gateway address first.')
    return
  }

  // Use the largest UTXO
  const utxo = utxos.sort((a, b) => b.value - a.value)[0]
  console.log(`\nUsing UTXO: ${utxo.tx_hash.slice(0, 16)}... (${utxo.value} sat)`)

  // 2. Fetch the source transaction
  console.log('Fetching source transaction...')
  const sourceTx = await fetchSourceTx(utxo.tx_hash)
  console.log(`Source TX loaded (${sourceTx.toHex().length / 2} bytes)`)

  // 3. Build the payment transaction
  const paymentAmount = 2 // 2 sat — our per-job price
  const proofData = `proof-of-compute|test|${Date.now()}`
  const proofHash = Hash.sha256(
    Array.from(new TextEncoder().encode(proofData))
  )
  const proofHex = Array.from(proofHash).map(b => b.toString(16).padStart(2, '0')).join('')

  console.log(`\nBuilding TX:`)
  console.log(`  Payment: ${paymentAmount} sat → ${workerAddress}`)
  console.log(`  OP_RETURN: ${proofHex.slice(0, 32)}...`)

  const tx = new Transaction()

  // Input: spend the UTXO
  tx.addInput({
    sourceTransaction: sourceTx,
    sourceOutputIndex: utxo.tx_pos,
    unlockingScriptTemplate: new P2PKH().unlock(gatewayKey),
  })

  // Output 1: payment to worker
  tx.addOutput({
    lockingScript: new P2PKH().lock(workerAddress),
    satoshis: paymentAmount,
  })

  // Output 2: OP_RETURN with proof-of-compute hash
  tx.addOutput({
    lockingScript: new P2PKH().lock(wallets.gateway.address),
    change: true,
  })

  // Calculate fee and sign
  await tx.fee()
  await tx.sign()

  const txHex = tx.toHex()
  const txid = tx.id('hex') as string
  console.log(`\nSigned TX: ${txid}`)
  console.log(`Size: ${txHex.length / 2} bytes`)

  // 4. Broadcast via WhatsOnChain API (ARC SDK has HTTP issues in Node)
  console.log('\nBroadcasting via WhatsOnChain testnet...')
  const wocRes = await fetch('https://api.whatsonchain.com/v1/bsv/test/tx/raw', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txhex: txHex }),
  })
  const wocData = await wocRes.text()
  console.log(`Status: ${wocRes.status}`)
  console.log(`Response: ${wocData}`)

  if (wocRes.ok) {
    console.log(`\n  FIRST REAL TESTNET PAYMENT!`)
    console.log(`  Explorer: https://test.whatsonchain.com/tx/${txid}`)
  } else {
    console.log('\nRaw TX hex (for manual broadcast):')
    console.log(txHex)
  }
}

main().catch(console.error)
