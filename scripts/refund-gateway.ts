/**
 * One-shot: refund gateway BRC wallet from worker1 raw P2PKH UTXO.
 *
 * Usage:
 *   SOURCE_NAME=worker1 SEED_TXID=... SEED_VOUT=0 SEED_SATS=99904 \
 *   npx tsx scripts/refund-gateway.ts [target=gateway] [amount=50000]
 */
import 'dotenv/config'
import { PrivateKey, KeyDeriver, P2PKH, Transaction, Beef, Random, Utils } from '@bsv/sdk'
import { readFileSync } from 'fs'
import { getWallet } from '../src/peckpay-wallet.js'

const TAAL_KEY = process.env.TAAL_TESTNET_KEY!
const ARC = 'https://arc-test.taal.com'
const WOC = 'https://api.whatsonchain.com/v1/bsv/test'
const SOURCE_NAME = process.env.SOURCE_NAME || 'worker1'
const SEED_TXID = process.env.SEED_TXID!
const SEED_VOUT = parseInt(process.env.SEED_VOUT || '0', 10)
const SEED_SATS = parseInt(process.env.SEED_SATS || '0', 10)
const TARGET = process.argv[2] || 'gateway'
const AMOUNT = parseInt(process.argv[3] || '50000', 10)

async function main() {
  if (!SEED_TXID || !SEED_SATS) throw new Error('SEED_TXID and SEED_SATS env required')

  const wallets = JSON.parse(readFileSync('.wallets.json', 'utf-8'))
  const sourceKey = PrivateKey.fromHex(wallets[SOURCE_NAME].hex)
  const sourceDeriver = new KeyDeriver(sourceKey)
  console.log(`source: ${SOURCE_NAME} (${wallets[SOURCE_NAME].address})  identity=${sourceDeriver.identityKey.slice(0, 16)}…`)

  const target = await getWallet(TARGET)
  console.log(`target: ${TARGET} identity=${target.identityKey.slice(0, 16)}…`)

  const prefix = Utils.toBase64(Random(8))
  const suffix = Utils.toBase64(Random(8))
  const destPub = sourceDeriver.derivePublicKey([2, '3241645161d8'], `${prefix} ${suffix}`, target.identityKey)
  const destAddress = destPub.toAddress('testnet')
  console.log(`dest: ${destAddress}  amount=${AMOUNT}`)

  console.log(`parent: ${SEED_TXID}:${SEED_VOUT} (${SEED_SATS} sat)`)
  const parentR = await fetch(`${WOC}/tx/${SEED_TXID}/hex`)
  if (!parentR.ok) throw new Error(`WoC parent fetch ${parentR.status}`)
  const parentTx = Transaction.fromHex((await parentR.text()).trim())

  const mp = await target.services.getMerklePath(SEED_TXID)
  if (!mp.merklePath) throw new Error(`merklePath: ${mp.error?.message || 'none'}`)
  console.log(`merklePath: block ${mp.merklePath.blockHeight}`)

  const tx = new Transaction()
  tx.addInput({ sourceTransaction: parentTx, sourceOutputIndex: SEED_VOUT, unlockingScriptTemplate: new P2PKH().unlock(sourceKey) })
  tx.addOutput({ lockingScript: new P2PKH().lock(destAddress), satoshis: AMOUNT })
  tx.addOutput({ lockingScript: new P2PKH().lock(sourceKey.toAddress('testnet')), change: true })
  await tx.fee()
  await tx.sign()
  const fundingTxid = tx.id('hex') as string

  console.log(`broadcasting ${fundingTxid}…`)
  const br = await fetch(`${ARC}/v1/tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TAAL_KEY}` },
    body: JSON.stringify({ rawTx: tx.toHex() }),
  })
  const bd = await br.json().catch(() => ({})) as any
  if (!br.ok && !String(bd.detail || '').toLowerCase().includes('already')) {
    throw new Error(`ARC ${br.status} ${JSON.stringify(bd)}`)
  }
  console.log(`broadcast: ${bd.txid || fundingTxid}`)

  const beef = new Beef()
  beef.mergeRawTx(parentTx.toBinary())
  beef.mergeBump(mp.merklePath)
  beef.mergeRawTx(tx.toBinary())
  const atomicBeef = beef.toBinaryAtomic(fundingTxid)

  const ir = await target.wallet.internalizeAction({
    tx: atomicBeef,
    outputs: [{
      outputIndex: 0,
      protocol: 'wallet payment',
      paymentRemittance: {
        derivationPrefix: prefix,
        derivationSuffix: suffix,
        senderIdentityKey: sourceDeriver.identityKey,
      },
    }],
    description: `refund ${TARGET} ${AMOUNT}sat`.slice(0, 50),
    seekPermission: false,
  })
  console.log(`internalize: ${ir.accepted ? '✅' : '❌'}`)
  process.exit(0)
}

main().catch(e => { console.error('FAIL:', e?.message || e); process.exit(1) })
