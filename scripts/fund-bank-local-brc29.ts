/**
 * fund-bank-local-brc29.ts — fund the local bank.peck.to (wallet-infra)
 * via a proper BRC-29 wallet payment from a worker wallet in .wallets.json.
 *
 * Flow:
 *   1. Fetch bank-local /health to get its identity public key
 *   2. Generate random derivationPrefix + derivationSuffix
 *   3. Use sender's KeyDeriver to derive the recipient's one-time pubkey
 *      via BRC-29 protocol [2, '3241645161d8'] with keyID = "<prefix> <suffix>"
 *   4. Build a P2PKH tx from FUNDER → derived address
 *   5. Broadcast directly via ARC, wait for 1 confirmation
 *   6. POST /receiveBrc29 with {txid, vout, prefix, suffix, senderIdentityKey}
 *      so wallet-toolbox internalizes it as a spendable wallet payment
 *
 * Usage:
 *   FUNDER=worker1 SATS=5000 npx tsx scripts/fund-bank-local-brc29.ts
 *
 * Env:
 *   FUNDER         — wallet name in .wallets.json (default worker1)
 *   SATS           — satoshis to send (default 5000)
 *   BANK_LOCAL_URL — internal API URL (default http://localhost:8088)
 *   NETWORK        — 'test'|'main' (default test)
 *   WAIT_BLOCKS    — confirmations to wait for before internalize (default 1)
 */
import 'dotenv/config'
import fs from 'node:fs'
import { Transaction, P2PKH, PrivateKey, KeyDeriver, Random, Utils } from '@bsv/sdk'
import { arcBroadcast, type Network } from '../src/ladder/arc.js'
import { BankLocal } from '../src/clients/bank-local.js'

const FUNDER = process.env.FUNDER ?? 'worker1'
const SATS = Number(process.env.SATS ?? 5000)
const NETWORK: Network = (process.env.NETWORK as Network) ?? 'test'
const WAIT_CONFS = Number(process.env.WAIT_BLOCKS ?? 1)
const WOC = NETWORK === 'test'
  ? 'https://api.whatsonchain.com/v1/bsv/test'
  : 'https://api.whatsonchain.com/v1/bsv/main'

const bank = new BankLocal()

async function main() {
  // 1. Bank-local identity key
  const health = await bank.health()
  const recipientIdentityKey = health.identityKey
  console.log(`[brc29] bank-local identityKey=${recipientIdentityKey.slice(0, 16)}… chain=${health.chain}`)
  if (health.chain !== NETWORK) {
    throw new Error(`bank-local is on '${health.chain}', script set for '${NETWORK}'`)
  }

  // 2. Funder wallet
  const wallets = JSON.parse(fs.readFileSync('.wallets.json', 'utf8'))
  const f = wallets[FUNDER]
  if (!f) throw new Error(`unknown funder ${FUNDER} in .wallets.json`)
  const funderKey = PrivateKey.fromHex(f.hex)
  const funderAddr: string = f.address
  const senderIdentityKey = funderKey.toPublicKey().toString()
  console.log(`[brc29] funder=${FUNDER} addr=${funderAddr} senderIdentityKey=${senderIdentityKey.slice(0, 16)}…`)

  // 3. BRC-29 derivation
  const derivationPrefix = Utils.toBase64(Random(8))
  const derivationSuffix = Utils.toBase64(Random(8))
  const protocolID: [number, string] = [2, '3241645161d8']
  const keyID = `${derivationPrefix} ${derivationSuffix}`

  const keyDeriver = new KeyDeriver(funderKey)
  const destPub = keyDeriver.derivePublicKey(
    protocolID,
    keyID,
    recipientIdentityKey,
    false, // not for self
  )
  const destAddr = destPub.toAddress(NETWORK === 'test' ? 'testnet' : 'mainnet')
  console.log(`[brc29] derived dest address: ${destAddr}`)
  console.log(`[brc29] prefix=${derivationPrefix} suffix=${derivationSuffix}`)

  // 4. Pick a UTXO from funder
  const utxos = await (await fetch(`${WOC}/address/${funderAddr}/unspent`)).json() as any[]
  const big = utxos.filter(u => u.value >= SATS + 500 && u.height > 0).sort((a, b) => b.value - a.value)[0]
  if (!big) throw new Error(`no UTXO ≥ ${SATS + 500} sat on ${funderAddr}`)
  console.log(`[brc29] using funder UTXO ${big.tx_hash}:${big.tx_pos} (${big.value} sat)`)

  const parentHex = (await (await fetch(`${WOC}/tx/${big.tx_hash}/hex`)).text()).trim()
  const parentTx = Transaction.fromHex(parentHex)

  // 5. Build P2PKH tx funder → derived address (vout 0), change back (vout 1)
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: parentTx,
    sourceOutputIndex: big.tx_pos,
    unlockingScriptTemplate: new P2PKH().unlock(funderKey),
  })
  tx.addOutput({
    lockingScript: new P2PKH().lock(destAddr),
    satoshis: SATS,
  })
  tx.addOutput({
    lockingScript: new P2PKH().lock(funderAddr),
    change: true,
  })
  await tx.fee()
  await tx.sign()
  const txid = tx.id('hex') as string
  const rawHex = tx.toHex()
  console.log(`[brc29] built tx ${txid}, broadcasting…`)

  const r = await arcBroadcast(rawHex, NETWORK)
  if (!r.txid && !r.alreadyKnown) throw new Error(`ARC error status ${r.status}`)
  console.log(`[brc29] ✅ broadcast via ${r.endpoint}`)
  console.log(`[brc29]    https://${NETWORK === 'test' ? 'test.' : ''}whatsonchain.com/tx/${txid}`)

  // Persist metadata BEFORE waiting so we can retry internalize without
  // re-broadcasting (the 5000 sat is locked to a derived key — losing
  // prefix/suffix would strand it).
  fs.mkdirSync('.peck-state', { recursive: true })
  const metaPath = `.peck-state/brc29-pending-${txid}.json`
  fs.writeFileSync(metaPath, JSON.stringify({
    txid, outputIndex: 0, derivationPrefix, derivationSuffix,
    senderIdentityKey, satoshis: SATS, network: NETWORK,
  }, null, 2))
  console.log(`[brc29] persisted metadata to ${metaPath}`)

  // 6. Wait for confirmations
  console.log(`[brc29] waiting for ${WAIT_CONFS} confirmation(s)…`)
  for (let attempt = 1; attempt <= 80; attempt++) {
    await new Promise(r => setTimeout(r, 30_000))
    let confs = 0
    try {
      const tx = await (await fetch(`${WOC}/tx/${txid}`)).json() as any
      confs = Number(tx?.confirmations ?? 0)
    } catch { /* ignore */ }
    if (confs >= WAIT_CONFS) {
      console.log(`[brc29] confirmed (${confs} confs)`)
      break
    }
    console.log(`[brc29]  attempt ${attempt}: ${confs} confs, sleeping 30s`)
  }

  // 7. Internalize via /receiveBrc29
  console.log('[brc29] calling bank-local /receiveBrc29…')
  const internalize = await fetch(`${bank.baseUrl}/receiveBrc29`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      txid,
      outputIndex: 0,
      derivationPrefix,
      derivationSuffix,
      senderIdentityKey,
    }),
  })
  const ibody = await internalize.text()
  console.log(`[brc29] /receiveBrc29 → ${internalize.status} ${ibody}`)
  if (!internalize.ok) throw new Error('internalize failed (metadata kept at ' + metaPath + ' for retry)')

  // 8. Show new bank-local balance, clean up metadata file
  const balance = await bank.balance()
  console.log(`[brc29] bank-local balance now: ${balance.balance} sat in ${balance.spendableOutputs} outputs`)
  fs.unlinkSync(metaPath)
  console.log(`[brc29] removed pending metadata ${metaPath}`)
}

main().catch(e => {
  console.error('[brc29] FAILED:', e?.message ?? e)
  process.exit(1)
})
