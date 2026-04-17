/**
 * fund-one-brc29.ts — send ONE BRC-29 payment from fleet-funder to an
 * agent whose wallet lives at bank.peck.to, then internalize via the
 * remote wallet-toolbox client so the UTXO becomes spendable.
 *
 * Usage:  npx tsx scripts/fund-one-brc29.ts [agent=curator-tech] [sat=50000]
 */
import 'dotenv/config'
import {
  PrivateKey, KeyDeriver, P2PKH, Transaction, Beef, MerklePath, Random, Utils,
} from '@bsv/sdk'
import { SetupClient, Services } from '@bsv/wallet-toolbox'
import { readFileSync, existsSync } from 'fs'

const AGENT = process.argv[2] || 'curator-tech'
const AMOUNT = parseInt(process.argv[3] || '50000', 10)

const FUNDER_FILE = '.fleet-funder.json'
const REGISTRY = '.brc-identities.json'
const STORAGE_URL = process.env.BANK_URL || 'https://bank.peck.to'
const TAAL_KEY = process.env.MAIN_TAAL_API_KEY || process.env.TAAL_MAINNET_KEY
const ARC = 'https://arc.taal.com'
const WOC = 'https://api.whatsonchain.com/v1/bsv/main'
const BRC29 = { protocolID: [2, '3241645161d8'] as [number, string] }

if (!TAAL_KEY) { console.error('MAIN_TAAL_API_KEY missing'); process.exit(1) }
if (!existsSync(FUNDER_FILE)) { console.error(`${FUNDER_FILE} missing`); process.exit(1) }

interface Utxo { tx_hash: string; tx_pos: number; value: number; height: number; isSpentInMempoolTx?: boolean }

async function fetchUtxos(address: string): Promise<Utxo[]> {
  const r = await fetch(`${WOC}/address/${address}/unspent`)
  if (!r.ok) throw new Error(`WoC unspent ${r.status}`)
  const list = await r.json() as Utxo[]
  // Only confirmed AND not already spent in a pending mempool tx — otherwise
  // sequential fan-out calls will pick the same parent and build double-spends.
  return list.filter(u => u.height > 0 && !u.isSpentInMempoolTx).sort((a, b) => b.value - a.value)
}
async function fetchTxHex(txid: string): Promise<string> {
  const r = await fetch(`${WOC}/tx/${txid}/hex`)
  if (!r.ok) throw new Error(`WoC tx hex ${r.status}`)
  return (await r.text()).trim()
}
// Uses wallet-toolbox Services (WoC + Bitails) which converts TSC proof → MerklePath
const services = new Services('main')
async function fetchMerklePathObj(txid: string): Promise<MerklePath> {
  const r = await services.getMerklePath(txid)
  if (!r.merklePath) throw new Error(`no merklePath for ${txid}: ${JSON.stringify(r.notes?.slice(-2))}`)
  return r.merklePath
}
async function broadcast(rawHex: string): Promise<string> {
  const r = await fetch(`${ARC}/v1/tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TAAL_KEY}` },
    body: JSON.stringify({ rawTx: rawHex }),
  })
  const d = await r.json().catch(() => ({})) as any
  if (!r.ok) throw new Error(`ARC broadcast ${r.status} ${JSON.stringify(d)}`)
  return d.txid
}

async function main() {
  const funder = JSON.parse(readFileSync(FUNDER_FILE, 'utf-8'))
  const funderKey = PrivateKey.fromString(funder.privKeyHex)
  const funderDeriver = new KeyDeriver(funderKey)
  const funderAddr = funderKey.toAddress('mainnet') as string
  console.log(`[fund] funder: ${funderAddr}`)

  const reg = JSON.parse(readFileSync(REGISTRY, 'utf-8'))
  const ident = reg[AGENT]
  if (!ident) throw new Error(`No identity for ${AGENT}`)
  const receiverIdentity = ident.identityKey
  console.log(`[fund] receiver: ${AGENT} identity=${receiverIdentity.slice(0,16)}…`)
  console.log(`[fund] amount: ${AMOUNT} sat`)

  console.log(`[fund] opening receiver wallet (bank.peck.to)...`)
  const receiverWallet = await SetupClient.createWalletClientNoEnv({
    chain: 'main',
    rootKeyHex: ident.privKeyHex,
    storageUrl: STORAGE_URL,
  })

  console.log(`[fund] fetching parent utxo...`)
  const utxos = await fetchUtxos(funderAddr)
  const u = utxos.find(x => x.value >= AMOUNT + 500)
  if (!u) throw new Error(`no utxo ≥ ${AMOUNT + 500}`)
  console.log(`[fund]   parent ${u.tx_hash.slice(0,16)}…:${u.tx_pos} value=${u.value}`)
  const parentHex = await fetchTxHex(u.tx_hash)
  const parentTx = Transaction.fromHex(parentHex)
  const bump = await fetchMerklePathObj(u.tx_hash)

  // Derive BRC-29 destination from funder → receiver identity
  const prefix = Utils.toBase64(Random(8))
  const suffix = Utils.toBase64(Random(8))
  const keyID = `${prefix} ${suffix}`
  const destPub = funderDeriver.derivePublicKey(BRC29.protocolID, keyID, receiverIdentity)
  const destAddress = destPub.toAddress('mainnet') as string
  console.log(`[fund]   BRC-29 dest: ${destAddress} (derived)`)

  // Build + sign funding TX
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: parentTx,
    sourceOutputIndex: u.tx_pos,
    unlockingScriptTemplate: new P2PKH().unlock(funderKey),
  })
  tx.addOutput({ lockingScript: new P2PKH().lock(destAddress), satoshis: AMOUNT })
  tx.addOutput({ lockingScript: new P2PKH().lock(funderAddr), change: true })
  await tx.fee()
  await tx.sign()

  const fundingTxid = tx.id('hex') as string
  const fundingHex = tx.toHex()
  console.log(`[fund] signed tx: ${fundingTxid}`)

  // Build atomic BEEF for internalizeAction
  const beef = new Beef()
  beef.mergeRawTx(parentTx.toBinary())
  beef.mergeBump(bump)
  beef.mergeRawTx(Utils.toArray(fundingHex, 'hex'))
  const atomicBeef = beef.toBinaryAtomic(fundingTxid)

  console.log(`[fund] broadcasting via ARC...`)
  await broadcast(fundingHex)
  console.log(`[fund]   broadcast OK`)

  console.log(`[fund] internalizing via receiver wallet (bank.peck.to)...`)
  const res = await receiverWallet.internalizeAction({
    tx: atomicBeef,
    outputs: [{
      outputIndex: 0,
      protocol: 'wallet payment',
      paymentRemittance: {
        derivationPrefix: prefix,
        derivationSuffix: suffix,
        senderIdentityKey: funderDeriver.identityKey,
      },
    }],
    description: `Fund ${AGENT}`,
  })
  if (!res.accepted) throw new Error(`internalizeAction rejected`)
  console.log(`[fund] ✓ internalized — ${AGENT} wallet has ${AMOUNT} sat at bank.peck.to`)
  console.log(`[fund] verify: npx tsx scripts/test-brc100-single.ts ${AGENT}`)
}

main().catch(e => { console.error('[fund] FAIL:', e.message || e); process.exit(1) })
