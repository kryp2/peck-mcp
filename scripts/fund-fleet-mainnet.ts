/**
 * Bootstrap-fund 25 curator-agents on MAINNET from fleet-funder.
 *
 * Source: .fleet-funder.json (P2PKH privkey funded via peck-desktop earlier)
 * Receivers: all curator-* agents in .brc-identities.json
 * Protocol: BRC-29 — each receiver gets ~5000 sats at a derived address +
 *           internalizeAction so wallet-toolbox tracks the UTXO.
 * Chain source: TAAL ARC mainnet (no WoC after initial UTXO scan).
 *
 * Run: npx tsx scripts/fund-fleet-mainnet.ts [perAgent=5000]
 */
import 'dotenv/config'
import {
  PrivateKey, KeyDeriver, P2PKH, Transaction, Beef, MerklePath, Random, Utils,
} from '@bsv/sdk'
import { readFileSync, existsSync } from 'fs'
import { getWallet } from '../src/peckpay-wallet.js'

const FUNDER_FILE = '.fleet-funder.json'
const REGISTRY = '.brc-identities.json'
const TAAL_KEY = process.env.MAIN_TAAL_API_KEY || process.env.TAAL_MAINNET_KEY
const ARC = 'https://arc.taal.com'
const WOC = 'https://api.whatsonchain.com/v1/bsv/main'
const BRC29 = { protocolID: [2, '3241645161d8'] as [number, string] }

if (!TAAL_KEY) { console.error('MAIN_TAAL_API_KEY missing in .env'); process.exit(1) }
if (!existsSync(FUNDER_FILE)) { console.error(`${FUNDER_FILE} missing — run create-fleet-funder.ts`); process.exit(1) }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

interface Utxo { tx_hash: string; tx_pos: number; value: number; height: number }

async function fetchUtxos(address: string): Promise<Utxo[]> {
  const r = await fetch(`${WOC}/address/${address}/unspent`)
  if (!r.ok) throw new Error(`WoC unspent ${r.status}`)
  const list = await r.json() as Utxo[]
  return list.filter(u => u.height > 0).sort((a, b) => b.value - a.value)
}

async function fetchTxHex(txid: string): Promise<string> {
  const r = await fetch(`${WOC}/tx/${txid}/hex`)
  if (!r.ok) throw new Error(`WoC tx hex ${r.status}`)
  return (await r.text()).trim()
}

async function fetchMerklePath(txid: string, parentHex?: string): Promise<string> {
  // First try — maybe TAAL already has it
  let r = await fetch(`${ARC}/v1/tx/${txid}`, {
    headers: { 'Authorization': `Bearer ${TAAL_KEY}` },
  })
  if (r.ok) {
    const data = await r.json() as any
    if (data.merklePath) return data.merklePath as string
  }
  // Not indexed by TAAL — rebroadcast raw hex to make TAAL index it
  if (parentHex) {
    await fetch(`${ARC}/v1/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TAAL_KEY}` },
      body: JSON.stringify({ rawTx: parentHex }),
    })
    // Wait briefly for TAAL to index
    await new Promise(r => setTimeout(r, 2000))
    r = await fetch(`${ARC}/v1/tx/${txid}`, {
      headers: { 'Authorization': `Bearer ${TAAL_KEY}` },
    })
    if (r.ok) {
      const data = await r.json() as any
      if (data.merklePath) return data.merklePath as string
    }
  }
  throw new Error(`no merklePath available for ${txid}`)
}

async function broadcast(rawHex: string): Promise<string> {
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

async function fundOne(
  receiverName: string,
  amountSat: number,
  source: { key: PrivateKey; deriver: KeyDeriver },
  utxo: Utxo, parentTx: Transaction, parentBumpHex: string,
): Promise<{ txid: string; receiver: string }> {
  const receiver = await getWallet(receiverName, 'main')
  const receiverIdentity = receiver.identityKey

  const prefix = Utils.toBase64(Random(8))
  const suffix = Utils.toBase64(Random(8))
  const keyID = `${prefix} ${suffix}`
  const destPub = source.deriver.derivePublicKey(BRC29.protocolID, keyID, receiverIdentity)
  const destAddress = destPub.toAddress('mainnet') as string

  if (utxo.value < amountSat + 300) throw new Error(`UTXO ${utxo.value} < ${amountSat + 300}`)

  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: parentTx,
    sourceOutputIndex: utxo.tx_pos,
    unlockingScriptTemplate: new P2PKH().unlock(source.key),
  })
  tx.addOutput({ lockingScript: new P2PKH().lock(destAddress), satoshis: amountSat })
  tx.addOutput({ lockingScript: new P2PKH().lock(source.key.toAddress('mainnet') as string), change: true })
  await tx.fee()
  await tx.sign()

  const fundingTxid = tx.id('hex') as string
  const fundingHex = tx.toHex()

  const beef = new Beef()
  beef.mergeRawTx(parentTx.toBinary())
  beef.mergeBump(MerklePath.fromHex(parentBumpHex))
  beef.mergeRawTx(Utils.toArray(fundingHex, 'hex'))
  const atomicBeef = beef.toBinaryAtomic(fundingTxid)

  await broadcast(fundingHex)

  const res = await receiver.wallet.internalizeAction({
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
    description: `Fleet bootstrap: ${receiverName}`,
    seekPermission: false,
  })
  if (!res.accepted) throw new Error(`internalizeAction rejected for ${receiverName}`)

  return { txid: fundingTxid, receiver: receiverName }
}

async function main() {
  const amountSat = parseInt(process.argv[2] || '5000', 10)
  const only = process.argv[3]  // optional single agent name

  const funder = JSON.parse(readFileSync(FUNDER_FILE, 'utf-8'))
  const funderKey = PrivateKey.fromString(funder.privKeyHex)
  const funderDeriver = new KeyDeriver(funderKey)
  const funderAddr = funderKey.toAddress('mainnet') as string
  console.log(`funder: ${funderAddr} (identity ${funderDeriver.identityKey.slice(0, 20)}…)`)

  const reg = JSON.parse(readFileSync(REGISTRY, 'utf-8'))
  const agents = only ? [only] : Object.keys(reg).filter(n => n.startsWith('curator-'))
  console.log(`funding ${agents.length} agents × ${amountSat} sats`)

  const results: Array<{ name: string; txid?: string; error?: string }> = []
  for (let i = 0; i < agents.length; i++) {
    const name = agents[i]
    // Refetch UTXOs each iteration — previous change outputs become available
    const utxos = await fetchUtxos(funderAddr); await sleep(400)
    const u = utxos.find(x => x.value >= amountSat + 500)
    if (!u) { results.push({ name, error: 'no utxo ≥ amount+fee' }); continue }
    console.log(`\n→ ${name}: parent ${u.tx_hash.slice(0, 16)}…:${u.tx_pos} (${u.value} sat)  [pool: ${utxos.length}]`)
    try {
      const parentHex = await fetchTxHex(u.tx_hash); await sleep(300)
      const parentTx = Transaction.fromHex(parentHex)
      const bump = await fetchMerklePath(u.tx_hash, parentHex); await sleep(300)
      const r = await fundOne(name, amountSat, { key: funderKey, deriver: funderDeriver }, u, parentTx, bump)
      results.push({ name, txid: r.txid })
      console.log(`   ✅ ${r.txid}`)
      await sleep(400)
    } catch (e: any) {
      results.push({ name, error: e.message?.slice(0, 160) || String(e) })
      console.error(`   ❌ ${e.message?.slice(0, 200)}`)
      await sleep(600)
    }
  }

  console.log(`\n=== result ===`)
  for (const r of results) {
    if (r.txid) console.log(`  ✅ ${r.name.padEnd(22)} ${r.txid}`)
    else console.log(`  ❌ ${r.name.padEnd(22)} ${r.error?.slice(0, 80)}`)
  }
  process.exit(results.some(r => !r.txid) ? 1 : 0)
}

main().catch(e => { console.error('FAIL:', e.message || e); process.exit(1) })
