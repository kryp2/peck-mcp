/**
 * fund-fanout.ts — atomic fan-out funding to N agents in ONE transaction.
 *
 * Eliminates the double-spend risk from fund-one-brc29.ts (which picked a
 * WoC-reported unspent UTXO per invocation — same parent across rapid
 * sequential calls because WoC lags mempool). Here we pick ONE parent,
 * build ONE TX with N BRC-29 outputs + change, broadcast ONCE, then
 * internalize each output into its owner's wallet-infra account.
 *
 * Usage:
 *   npx tsx scripts/fund-fanout.ts <sats-per-agent> <agent1,agent2,...>
 *
 * Example:
 *   npx tsx scripts/fund-fanout.ts 50000 curator-art,curator-finance,curator-meta
 */
import 'dotenv/config'
import { readFileSync, existsSync } from 'fs'
import {
  PrivateKey, KeyDeriver, P2PKH, Transaction, Beef, Random, Utils,
} from '@bsv/sdk'
import { SetupClient, Services } from '@bsv/wallet-toolbox'

const AMOUNT = parseInt(process.argv[2] || '50000', 10)
const AGENTS = (process.argv[3] || '').split(',').map(s => s.trim()).filter(Boolean)
if (AGENTS.length === 0) { console.error('need at least one agent'); process.exit(1) }

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
  return list.filter(u => u.height > 0 && !u.isSpentInMempoolTx).sort((a, b) => b.value - a.value)
}
async function fetchTxHex(txid: string): Promise<string> {
  const r = await fetch(`${WOC}/tx/${txid}/hex`)
  if (!r.ok) throw new Error(`WoC tx hex ${r.status}`)
  return (await r.text()).trim()
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
  console.log(`[fanout] funder: ${funderAddr}`)
  console.log(`[fanout] agents: ${AGENTS.length} × ${AMOUNT} sat = ${(AGENTS.length * AMOUNT).toLocaleString()} total`)

  const reg = JSON.parse(readFileSync(REGISTRY, 'utf-8'))
  const idents = AGENTS.map(n => {
    const id = reg[n]
    if (!id) throw new Error(`no identity for ${n}`)
    return { name: n, ident: id }
  })

  // Derive BRC-29 destination per agent — one prefix/suffix pair each
  const deriv = idents.map(({ name, ident }) => {
    const prefix = Utils.toBase64(Random(8))
    const suffix = Utils.toBase64(Random(8))
    const keyID = `${prefix} ${suffix}`
    const destPub = funderDeriver.derivePublicKey(BRC29.protocolID, keyID, ident.identityKey)
    const destAddress = destPub.toAddress('mainnet') as string
    return { name, ident, prefix, suffix, destAddress }
  })

  // Pick ONE parent UTXO — no polling, no retry, single source of truth
  console.log(`[fanout] picking parent utxo from funder...`)
  const utxos = await fetchUtxos(funderAddr)
  const need = AGENTS.length * AMOUNT + 2000  // buffer for fees + outputs overhead
  const u = utxos.find(x => x.value >= need)
  if (!u) throw new Error(`no utxo ≥ ${need} sat (largest: ${utxos[0]?.value})`)
  console.log(`[fanout]   parent ${u.tx_hash.slice(0, 16)}…:${u.tx_pos} value=${u.value}`)

  const parentHex = await fetchTxHex(u.tx_hash)
  const parentTx = Transaction.fromHex(parentHex)

  // Merkle path for parent via wallet-toolbox Services (WoC TSC → BUMP)
  const services = new Services('main')
  const bumpRes = await services.getMerklePath(u.tx_hash)
  if (!bumpRes.merklePath) throw new Error(`no merkle path for parent: ${JSON.stringify(bumpRes.notes?.slice(-2))}`)

  // Build one TX: 1 input → N BRC-29 outputs + change
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: parentTx,
    sourceOutputIndex: u.tx_pos,
    unlockingScriptTemplate: new P2PKH().unlock(funderKey),
  })
  for (const d of deriv) {
    tx.addOutput({ lockingScript: new P2PKH().lock(d.destAddress), satoshis: AMOUNT })
  }
  tx.addOutput({ lockingScript: new P2PKH().lock(funderAddr), change: true })
  await tx.fee()
  await tx.sign()

  const fundingTxid = tx.id('hex') as string
  const fundingHex = tx.toHex()
  console.log(`[fanout] built tx: ${fundingTxid}  (${fundingHex.length / 2} bytes, ${tx.outputs.length} outputs)`)

  console.log(`[fanout] broadcasting via ARC...`)
  await broadcast(fundingHex)
  console.log(`[fanout]   ✓ broadcast OK`)

  // Build atomic BEEF once — all agents share same parent + funding TX
  const beef = new Beef()
  beef.mergeRawTx(parentTx.toBinary())
  beef.mergeBump(bumpRes.merklePath)
  beef.mergeRawTx(Utils.toArray(fundingHex, 'hex'))
  const atomicBeef = beef.toBinaryAtomic(fundingTxid)

  // Internalize each output to its owner's bank.peck.to wallet
  console.log(`[fanout] internalizing ${deriv.length} outputs...`)
  const results: Array<{ agent: string; ok: boolean; error?: string }> = []
  for (let i = 0; i < deriv.length; i++) {
    const d = deriv[i]
    try {
      const wallet = await SetupClient.createWalletClientNoEnv({
        chain: 'main', rootKeyHex: d.ident.privKeyHex, storageUrl: STORAGE_URL,
      })
      const res = await wallet.internalizeAction({
        tx: atomicBeef,
        outputs: [{
          outputIndex: i,
          protocol: 'wallet payment',
          paymentRemittance: {
            derivationPrefix: d.prefix,
            derivationSuffix: d.suffix,
            senderIdentityKey: funderDeriver.identityKey,
          },
        }],
        description: `Fanout fund ${d.name}`,
      })
      if (res.accepted) {
        console.log(`  ✓ ${d.name.padEnd(22)} outputIndex=${i} → ${AMOUNT} sat`)
        results.push({ agent: d.name, ok: true })
      } else {
        console.error(`  ❌ ${d.name}: internalizeAction rejected`)
        results.push({ agent: d.name, ok: false, error: 'rejected' })
      }
    } catch (e: any) {
      console.error(`  ❌ ${d.name}: ${(e.message || String(e)).slice(0, 120)}`)
      results.push({ agent: d.name, ok: false, error: e.message })
    }
  }

  const ok = results.filter(r => r.ok).length
  console.log(`\n[fanout] ${ok}/${results.length} agents funded`)
  console.log(`[fanout] fanout txid: ${fundingTxid}`)
  console.log(`[fanout] explorer:    https://whatsonchain.com/tx/${fundingTxid}`)
}

main().catch(e => { console.error('[fanout] FAIL:', e.message || e); process.exit(1) })
