/**
 * Chained funding bootstrap for ALL BRC wallets from a single source UTXO.
 *
 * Process:
 *   1. Take ONE confirmed parent UTXO (default: worker2 99904 sat)
 *   2. Build N chained funding txs locally:
 *        tx-1: parent          → [BRC-29 pay to gateway, change]
 *        tx-2: change of tx-1  → [BRC-29 pay to weather, change]
 *        tx-3: change of tx-2  → [BRC-29 pay to translate, change]
 *        ... etc for all 10 agents
 *   3. Broadcast each tx in order via TAAL ARC (uses Extended Format)
 *   4. For each receiver: build its atomic BEEF from the parent + all
 *      preceding chained txs + its own funding tx, then internalize.
 *
 * Single source, single broadcast pass, all receivers funded.
 * After this: WoC is never touched again. wallet-toolbox + ARC only.
 */
import 'dotenv/config'
import {
  PrivateKey, KeyDeriver, P2PKH, Transaction,
  Beef, Random, Utils,
} from '@bsv/sdk'
import { readFileSync } from 'fs'
import { getWallet } from '../src/peckpay-wallet.js'

const FUND_PER_WALLET = parseInt(process.env.FUND_PER_WALLET || '5000', 10)
const TAAL_KEY = process.env.TAAL_TESTNET_KEY!
const ARC = 'https://arc-test.taal.com'
const WOC = 'https://api.whatsonchain.com/v1/bsv/test'

const SOURCE_NAME = process.env.SOURCE_NAME || 'worker2'  // .wallets.json key
const SEED_TXID = process.env.SEED_TXID || 'bde8d52b954044ea15756ec0d3bfd24f6a76de89c0144a0f2b7343c8b81d6725'
const SEED_VOUT = parseInt(process.env.SEED_VOUT || '0', 10)
const SEED_SATS = parseInt(process.env.SEED_SATS || '99904', 10)

const TARGETS = [
  'gateway', 'weather', 'translate', 'summarize', 'price',
  'geocode', 'evm-compute', 'wasm-compute', 'gas-oracle', 'metering',
]

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function fetchTxHex(txid: string): Promise<string> {
  const r = await fetch(`${WOC}/tx/${txid}/hex`)
  if (!r.ok) throw new Error(`WoC tx hex ${r.status}`)
  return (await r.text()).trim()
}

// Use wallet-toolbox's multi-provider Services to fetch merkle paths.
// Falls back across Bitails, WhatsOnChain, etc — handles older confirmed
// txs that ARC's index has rotated out.
import { MerklePath } from '@bsv/sdk'
async function fetchMerklePathViaServices(setup: any, txid: string): Promise<MerklePath> {
  const r = await setup.services.getMerklePath(txid)
  if (!r.merklePath) throw new Error(`getMerklePath: ${r.error?.message || 'no proof'}`)
  return r.merklePath
}

async function broadcastViaArc(rawHex: string): Promise<{ txid: string }> {
  const r = await fetch(`${ARC}/v1/tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TAAL_KEY}` },
    body: JSON.stringify({ rawTx: rawHex }),
  })
  const data = await r.json().catch(() => ({})) as any
  if (!r.ok && !String(data.detail || '').toLowerCase().includes('already')) {
    throw new Error(`ARC ${r.status} ${JSON.stringify(data)}`)
  }
  return { txid: data.txid }
}

async function main() {
  console.log(`=== BRC chained funding (${FUND_PER_WALLET} sat × ${TARGETS.length} = ${FUND_PER_WALLET * TARGETS.length} sat needed) ===`)

  // Source key
  const wallets = JSON.parse(readFileSync('.wallets.json', 'utf-8'))
  const sourceKey = PrivateKey.fromHex(wallets[SOURCE_NAME].hex)
  const sourceDeriver = new KeyDeriver(sourceKey)
  console.log(`source: ${SOURCE_NAME} (${wallets[SOURCE_NAME].address})  identityKey=${sourceDeriver.identityKey.slice(0, 16)}…`)

  // We need ANY wallet setup to access Services for merkle path lookup.
  // Use the gateway wallet (which is already initialized in the registry).
  const gwSetup = await getWallet('gateway')

  // Parent
  console.log(`parent: ${SEED_TXID}:${SEED_VOUT} (${SEED_SATS} sat)`)
  const parentHex = await fetchTxHex(SEED_TXID)
  const parentTx = Transaction.fromHex(parentHex)
  const parentMerklePath = await fetchMerklePathViaServices(gwSetup, SEED_TXID)
  console.log(`parent merklePath fetched (block ${parentMerklePath.blockHeight})`)

  // Pre-resolve all receiver identities (so we can build chain offline)
  const receivers: Array<{ name: string; identityKey: string; prefix: string; suffix: string; destAddress: string }> = []
  console.log(`\nResolving receiver identities…`)
  for (const name of TARGETS) {
    const setup = await getWallet(name)
    const prefix = Utils.toBase64(Random(8))
    const suffix = Utils.toBase64(Random(8))
    const destPub = sourceDeriver.derivePublicKey(
      [2, '3241645161d8'],
      `${prefix} ${suffix}`,
      setup.identityKey
    )
    const destAddress = destPub.toAddress('testnet')
    receivers.push({ name, identityKey: setup.identityKey, prefix, suffix, destAddress })
    console.log(`  ${name.padEnd(15)} ${destAddress}`)
  }

  // Build chain locally
  console.log(`\nBuilding chained funding txs (${TARGETS.length} txs)…`)
  let prevTx = parentTx
  let prevVout = SEED_VOUT
  let prevSats = SEED_SATS
  const builtTxs: Transaction[] = []

  for (let i = 0; i < receivers.length; i++) {
    const r = receivers[i]
    const tx = new Transaction()
    tx.addInput({
      sourceTransaction: prevTx,
      sourceOutputIndex: prevVout,
      unlockingScriptTemplate: new P2PKH().unlock(sourceKey),
    })
    // Output 0: BRC-29 payment to receiver
    tx.addOutput({
      lockingScript: new P2PKH().lock(r.destAddress),
      satoshis: FUND_PER_WALLET,
    })
    // Output 1: change back to source for next iteration
    tx.addOutput({
      lockingScript: new P2PKH().lock(sourceKey.toAddress('testnet')),
      change: true,
    })
    await tx.fee()
    await tx.sign()

    builtTxs.push(tx)
    const changeOut = tx.outputs[1]
    prevTx = tx
    prevVout = 1
    prevSats = changeOut.satoshis ?? 0
    console.log(`  tx${i + 1}: ${tx.id('hex')}  → ${r.name}  change=${prevSats}`)
  }

  // Broadcast all in order
  console.log(`\nBroadcasting ${builtTxs.length} txs via TAAL ARC…`)
  for (let i = 0; i < builtTxs.length; i++) {
    try {
      await broadcastViaArc(builtTxs[i].toHex())
      console.log(`  ✅ tx${i + 1} broadcast`)
      await sleep(150)
    } catch (e) {
      console.error(`  ❌ tx${i + 1}: ${String(e).slice(0, 200)}`)
      throw e
    }
  }

  // Internalize each into the corresponding receiver wallet
  console.log(`\nInternalizing into receiver wallets…`)
  for (let i = 0; i < receivers.length; i++) {
    const r = receivers[i]
    const fundingTx = builtTxs[i]
    const fundingTxid = fundingTx.id('hex') as string

    // Build atomic BEEF: parent + parent bump + all preceding chained txs + this funding tx
    const beef = new Beef()
    beef.mergeRawTx(parentTx.toBinary())
    beef.mergeBump(parentMerklePath)
    for (let j = 0; j <= i; j++) {
      beef.mergeRawTx(builtTxs[j].toBinary())
    }
    const atomicBeef = beef.toBinaryAtomic(fundingTxid)

    try {
      const setup = await getWallet(r.name)
      const result = await setup.wallet.internalizeAction({
        tx: atomicBeef,
        outputs: [{
          outputIndex: 0,
          protocol: 'wallet payment',
          paymentRemittance: {
            derivationPrefix: r.prefix,
            derivationSuffix: r.suffix,
            senderIdentityKey: sourceDeriver.identityKey,
          },
        }],
        description: `Bootstrap funding ${r.name}`,
        seekPermission: false,
      })
      console.log(`  ✅ ${r.name.padEnd(15)} ${fundingTxid.slice(0, 16)}…`)
    } catch (e) {
      console.error(`  ❌ ${r.name.padEnd(15)} ${String(e).slice(0, 200)}`)
    }
  }

  console.log(`\n=== Done ===`)
  process.exit(0)
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })
