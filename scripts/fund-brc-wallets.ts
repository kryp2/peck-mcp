/**
 * Bootstrap funding for BRC-100 wallets.
 *
 * Source of funds: the existing raw P2PKH gateway address from .wallets.json
 * (mm7Bcj…NkaPNR8) which holds ~1.2M sat from earlier testnet faucet drops.
 *
 * Process per receiver wallet:
 *   1. Pick a confirmed parent UTXO from the source address
 *   2. Fetch its merkle path from TAAL ARC (BUMP format) — proves parent on chain
 *   3. Generate BRC-29 derivation prefix/suffix
 *   4. Compute receiver's derived P2PKH destination via @bsv/sdk KeyDeriver
 *      using BRC-29 protocol [2, '3241645161d8'] and counterparty=receiverIdentity
 *   5. Build a funding tx: spend parent UTXO → derived destination + change
 *   6. Compose Beef with parent tx + parent merklePath + funding tx
 *   7. Broadcast funding tx via TAAL ARC
 *   8. Call receiverWallet.internalizeAction({tx: atomicBeef, outputs: [{
 *        outputIndex: 0,
 *        protocol: 'wallet payment',
 *        paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey }
 *      }]})
 *
 * After bootstrap each BRC wallet has its own funded UTXO and operates
 * 100% via wallet-toolbox + ARC, never touching WoC again.
 */
import 'dotenv/config'
import {
  PrivateKey, KeyDeriver, P2PKH, Hash, Transaction,
  Beef, MerklePath, Random, Utils,
} from '@bsv/sdk'
import { readFileSync } from 'fs'
import { getWallet } from '../src/peckpay-wallet.js'

const SOURCE_WALLETS = '.wallets.json'
const FUND_PER_WALLET = parseInt(process.env.FUND_PER_WALLET || '50000', 10)
const TAAL_KEY = process.env.TAAL_TESTNET_KEY!
const ARC = 'https://arc-test.taal.com'
const WOC = 'https://api.whatsonchain.com/v1/bsv/test'

if (!TAAL_KEY) {
  console.error('TAAL_TESTNET_KEY missing in .env')
  process.exit(1)
}

interface UnspentRow { tx_hash: string; tx_pos: number; value: number; height: number }

async function fetchConfirmedUtxos(address: string, minSats = 50250): Promise<UnspentRow[]> {
  const r = await fetch(`${WOC}/address/${address}/unspent`)
  if (!r.ok) throw new Error(`WoC unspent ${r.status}`)
  const list = await r.json() as UnspentRow[]
  return list.filter(u => u.height > 0 && u.value >= minSats).sort((a, b) => b.value - a.value)
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function fetchTxHex(txid: string): Promise<string> {
  const r = await fetch(`${WOC}/tx/${txid}/hex`)
  if (!r.ok) throw new Error(`WoC tx hex ${r.status}`)
  return (await r.text()).trim()
}

/**
 * Fetch a BUMP-format merkle path for a confirmed tx via TAAL ARC.
 * ARC returns merklePath when txStatus is MINED.
 */
async function fetchMerklePathBumpHex(txid: string): Promise<string> {
  const r = await fetch(`${ARC}/v1/tx/${txid}`, {
    headers: { 'Authorization': `Bearer ${TAAL_KEY}` },
  })
  if (!r.ok) throw new Error(`ARC tx info ${r.status}`)
  const data = await r.json() as any
  if (!data.merklePath) {
    throw new Error(`ARC has no merklePath for ${txid} (status: ${data.txStatus})`)
  }
  return data.merklePath as string
}

async function broadcastViaArc(rawHex: string): Promise<string> {
  const r = await fetch(`${ARC}/v1/tx`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TAAL_KEY}`,
    },
    body: JSON.stringify({ rawTx: rawHex }),
  })
  const data = await r.json().catch(() => ({})) as any
  if (!r.ok) throw new Error(`ARC broadcast ${r.status} ${JSON.stringify(data)}`)
  return data.txid
}

interface SourceWallets {
  gateway: { hex: string; address: string }
}

async function fundOne(
  receiverName: string,
  amountSat: number,
  source: { key: PrivateKey; deriver: KeyDeriver },
  pickedUtxo: UnspentRow,
  parentTx: Transaction,
  parentBumpHex: string,
): Promise<{ txid: string; receiver: string }> {
  // 1. Get receiver wallet + identity
  const receiverSetup = await getWallet(receiverName)
  const receiverIdentityKey = receiverSetup.identityKey  // pubkey hex

  // 2. Generate BRC-29 derivation
  const prefix = Utils.toBase64(Random(8))
  const suffix = Utils.toBase64(Random(8))
  const protocolID: [number, string] = [2, '3241645161d8']  // BRC-29
  const keyID = `${prefix} ${suffix}`

  // 3. Sender derives the destination pubkey using receiver as counterparty
  const destPub = source.deriver.derivePublicKey(protocolID, keyID, receiverIdentityKey)
  const destAddress = destPub.toAddress('testnet')

  // 4. Build the funding tx
  const feeEstimate = 250
  if (pickedUtxo.value < amountSat + feeEstimate) {
    throw new Error(`UTXO too small: ${pickedUtxo.value} < ${amountSat + feeEstimate}`)
  }

  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: parentTx,
    sourceOutputIndex: pickedUtxo.tx_pos,
    unlockingScriptTemplate: new P2PKH().unlock(source.key),
  })
  // Output 0 = the BRC-29 payment
  tx.addOutput({
    lockingScript: new P2PKH().lock(destAddress),
    satoshis: amountSat,
  })
  // Output 1 = change back to source
  tx.addOutput({
    lockingScript: new P2PKH().lock(source.key.toAddress('testnet')),
    change: true,
  })
  await tx.fee()
  await tx.sign()

  const fundingTxid = tx.id('hex') as string
  const fundingHex = tx.toHex()

  // 5. Build BEEF — parent rawTx first, THEN its bump (auto-linked by txid),
  // THEN the new funding tx (no bump yet, parent provides SPV chain).
  const beef = new Beef()
  beef.mergeRawTx(parentTx.toBinary())
  beef.mergeBump(MerklePath.fromHex(parentBumpHex))
  beef.mergeRawTx(Utils.toArray(fundingHex, 'hex'))
  const atomicBeef = beef.toBinaryAtomic(fundingTxid)

  // 6. Broadcast via ARC
  await broadcastViaArc(fundingHex)
  console.log(`    funding broadcast: ${fundingTxid}`)

  // 7. Internalize on receiver wallet
  const result = await receiverSetup.wallet.internalizeAction({
    tx: atomicBeef,
    outputs: [{
      outputIndex: 0,
      protocol: 'wallet payment',
      paymentRemittance: {
        derivationPrefix: prefix,
        derivationSuffix: suffix,
        senderIdentityKey: source.deriver.identityKey,
      },
    }],
    description: `Bootstrap funding for ${receiverName}`,
    seekPermission: false,
  })

  if (!result.accepted) {
    throw new Error(`internalizeAction rejected for ${receiverName}`)
  }

  return { txid: fundingTxid, receiver: receiverName }
}

async function main() {
  const which = process.argv[2] || 'all'
  const wallets: SourceWallets = JSON.parse(readFileSync(SOURCE_WALLETS, 'utf-8'))
  const sourceKey = PrivateKey.fromHex(wallets.gateway.hex)
  const sourceDeriver = new KeyDeriver(sourceKey)
  const sourceAddress = wallets.gateway.address

  console.log(`Source: ${sourceAddress} (${sourceDeriver.identityKey.slice(0, 20)}…)`)

  const utxos = await fetchConfirmedUtxos(sourceAddress, FUND_PER_WALLET + 250)
  console.log(`Found ${utxos.length} confirmed UTXOs ≥${FUND_PER_WALLET + 250} sat`)

  // Pick a single big UTXO; we'll consume it for one receiver and chain change
  // Actually for simplicity: one parent UTXO per receiver (avoids local mempool chain).
  if (utxos.length === 0) throw new Error('no confirmed UTXOs at source')

  const targets: string[] = which === 'all'
    ? ['gateway', 'weather', 'translate', 'summarize', 'price', 'geocode', 'evm-compute', 'wasm-compute', 'gas-oracle', 'metering']
    : [which]

  if (utxos.length < targets.length) {
    console.warn(`⚠️  only ${utxos.length} confirmed UTXOs for ${targets.length} targets — some will be skipped`)
  }

  const results: Array<{ name: string; txid?: string; error?: string }> = []
  // Filter targets: skip ones already funded (have a wallet.db with balance) — for simplicity we just try all
  const skipFunded = new Set<string>()
  if (process.env.SKIP_FUNDED) {
    // optional: caller can pass list of names to skip
    process.env.SKIP_FUNDED.split(',').forEach(n => skipFunded.add(n.trim()))
  }
  const filteredTargets = targets.filter(t => !skipFunded.has(t))

  if (utxos.length < filteredTargets.length) {
    console.warn(`⚠️  ${utxos.length} usable UTXOs for ${filteredTargets.length} targets`)
  }

  for (let i = 0; i < filteredTargets.length && i < utxos.length; i++) {
    const name = filteredTargets[i]
    const u = utxos[i]
    console.log(`\n→ Funding "${name}" with ${FUND_PER_WALLET} sat from ${u.tx_hash.slice(0, 16)}…:${u.tx_pos} (${u.value} sat, h=${u.height})`)
    try {
      const parentHex = await fetchTxHex(u.tx_hash)
      await sleep(400)  // gentle on WoC free tier
      const parentTx = Transaction.fromHex(parentHex)
      const parentBump = await fetchMerklePathBumpHex(u.tx_hash)
      const r = await fundOne(name, FUND_PER_WALLET, { key: sourceKey, deriver: sourceDeriver }, u, parentTx, parentBump)
      results.push({ name, txid: r.txid })
      console.log(`    ✅ ${name} internalized`)
      await sleep(300)  // ARC pause
    } catch (e) {
      results.push({ name, error: String(e) })
      console.error(`    ❌ ${name}: ${String(e).slice(0, 200)}`)
      await sleep(500)  // back off on error
    }
  }

  console.log(`\n=== Bootstrap result ===`)
  for (const r of results) {
    if (r.txid) console.log(`  ✅ ${r.name.padEnd(15)} ${r.txid}`)
    else console.log(`  ❌ ${r.name.padEnd(15)} ${r.error?.slice(0, 80)}`)
  }
  process.exit(results.some(r => r.error) ? 1 : 0)
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })
