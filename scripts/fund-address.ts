/**
 * fund-address.ts — sends sats from .wallets.json wallet to an arbitrary address.
 *
 * Usage:
 *   FUNDER=worker1 TO=<addr> SATS=5000 npx tsx scripts/fund-address.ts
 */
import 'dotenv/config'
import fs from 'node:fs'
import { Transaction, P2PKH, PrivateKey } from '@bsv/sdk'
import { arcBroadcast, type Network } from '../src/ladder/arc.js'

const FUNDER = process.env.FUNDER ?? 'worker1'
const TO = process.env.TO
const SATS = Number(process.env.SATS ?? 5000)
const NETWORK: Network = (process.env.NETWORK as Network) ?? 'test'
if (!TO) throw new Error('TO=<address> required')

const WOC = NETWORK === 'test' ? 'https://api.whatsonchain.com/v1/bsv/test' : 'https://api.whatsonchain.com/v1/bsv/main'
const wallets = JSON.parse(fs.readFileSync('.wallets.json', 'utf8'))
const f = wallets[FUNDER]
if (!f) throw new Error(`unknown funder ${FUNDER}`)
const key = PrivateKey.fromHex(f.hex)

const utxos = await (await fetch(`${WOC}/address/${f.address}/unspent`)).json() as any[]
const big = utxos.filter(u => u.value >= SATS + 500 && u.height > 0).sort((a, b) => b.value - a.value)[0]
if (!big) throw new Error(`no UTXO ≥ ${SATS + 500} sat on ${f.address}`)
console.log(`[fund] funder=${FUNDER}(${f.address}) → ${TO}: ${SATS} sat`)
console.log(`[fund] using UTXO ${big.tx_hash}:${big.tx_pos} (${big.value} sat)`)

const hex = (await (await fetch(`${WOC}/tx/${big.tx_hash}/hex`)).text()).trim()
const parent = Transaction.fromHex(hex)
const tx = new Transaction()
tx.addInput({ sourceTransaction: parent, sourceOutputIndex: big.tx_pos, unlockingScriptTemplate: new P2PKH().unlock(key) })
tx.addOutput({ lockingScript: new P2PKH().lock(TO), satoshis: SATS })
tx.addOutput({ lockingScript: new P2PKH().lock(f.address), change: true })
await tx.fee()
await tx.sign()
const txid = tx.id('hex') as string
const r = await arcBroadcast(tx.toHex(), NETWORK)
if (!r.txid && !r.alreadyKnown) throw new Error(`ARC error status ${r.status}`)
console.log(`[fund] ✅ ${txid} via ${r.endpoint}`)
console.log(`[fund]    https://${NETWORK === 'test' ? 'test.' : ''}whatsonchain.com/tx/${txid}`)
