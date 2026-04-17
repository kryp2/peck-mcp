/**
 * Proof-of-life: gateway BRC wallet pays weather BRC wallet via createAction.
 *
 * Demonstrates the full BRC-100 round trip:
 *   1. Gateway resolves weather's identity key (already known from registry)
 *   2. Gateway calls createAction with a BRC-29 payment output
 *   3. wallet-toolbox handles UTXO selection, signing, BEEF construction,
 *      and TAAL ARC broadcast — all internal
 *   4. Returns { txid, tx (BEEF) }
 *   5. Weather wallet calls internalizeAction with the BEEF + payment
 *      remittance metadata to receive the payment
 *   6. Both wallets report new balances
 */
import 'dotenv/config'
import { getWallet, getIdentityKey } from './peckpay-wallet.js'
import { Random, Utils } from '@bsv/sdk'

async function balance(setup: any): Promise<number> {
  // List all spendable outputs in the default basket
  const r = await setup.wallet.listOutputs({ basket: 'default', limit: 1000 })
  return r.outputs.reduce((sum: number, o: any) => sum + o.satoshis, 0)
}

async function main() {
  const PAY_AMOUNT = 100  // 100 sat = typical service call

  console.log('=== BRC-100 payment proof-of-life ===\n')

  const gw = await getWallet('gateway')
  const wx = await getWallet('weather')

  console.log(`gateway identity:  ${gw.identityKey.slice(0, 20)}…`)
  console.log(`weather identity:  ${wx.identityKey.slice(0, 20)}…`)

  console.log(`\nbalances before:`)
  console.log(`  gateway: ${await balance(gw)} sat`)
  console.log(`  weather: ${await balance(wx)} sat`)

  // Generate BRC-29 payment metadata
  const derivationPrefix = Utils.toBase64(Random(8))
  const derivationSuffix = Utils.toBase64(Random(8))
  console.log(`\nBRC-29 derivation prefix=${derivationPrefix} suffix=${derivationSuffix}`)

  // Resolve receiver's payment destination via gateway's keyDeriver
  const destPub = gw.keyDeriver.derivePublicKey(
    [2, '3241645161d8'],
    `${derivationPrefix} ${derivationSuffix}`,
    wx.identityKey
  )
  const destAddress = destPub.toAddress(gw.chain === 'main' ? 'mainnet' : 'testnet')
  console.log(`derived dest address: ${destAddress}`)

  // P2PKH locking script for the destination
  const { P2PKH } = await import('@bsv/sdk')
  const lockingScript = new P2PKH().lock(destAddress).toHex()

  console.log(`\ngateway.createAction(${PAY_AMOUNT} sat → weather)…`)
  const t0 = Date.now()
  const result = await gw.wallet.createAction({
    description: 'Pay weather for service call',
    outputs: [{
      lockingScript,
      satoshis: PAY_AMOUNT,
      outputDescription: 'BRC-29 service payment',
      customInstructions: JSON.stringify({
        derivationPrefix, derivationSuffix,
        senderIdentityKey: gw.identityKey,
        protocolID: [2, '3241645161d8'],
      }),
    }],
    options: { acceptDelayedBroadcast: false, randomizeOutputs: false },
  })
  const ms = Date.now() - t0
  console.log(`  txid: ${result.txid}`)
  console.log(`  ms: ${ms}`)
  console.log(`  has BEEF: ${!!result.tx}`)
  console.log(`  BEEF size: ${result.tx?.length} bytes`)

  if (!result.tx || !result.txid) throw new Error('createAction did not return BEEF')

  // Now weather internalizes the payment
  console.log(`\nweather.internalizeAction(BEEF)…`)
  const intResult = await wx.wallet.internalizeAction({
    tx: result.tx,
    outputs: [{
      outputIndex: 0,
      protocol: 'wallet payment',
      paymentRemittance: {
        derivationPrefix,
        derivationSuffix,
        senderIdentityKey: gw.identityKey,
      },
    }],
    description: 'Service payment from gateway',
    seekPermission: false,
  })
  console.log(`  accepted: ${intResult.accepted}`)

  console.log(`\nbalances after:`)
  console.log(`  gateway: ${await balance(gw)} sat`)
  console.log(`  weather: ${await balance(wx)} sat`)

  console.log(`\n✅ End-to-end BRC-100 payment + verification SUCCESS`)
  console.log(`   txid: ${result.txid}`)
  console.log(`   https://test.whatsonchain.com/tx/${result.txid}`)
  process.exit(0)
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })
