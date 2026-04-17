/**
 * fund-memory-agent.ts — sends a one-shot funding output from a named
 * wallet (default worker1) to the memory-agent's auto-generated address.
 *
 * Usage:
 *   FUND_SATS=6000 FUNDER=worker1 npx tsx scripts/fund-memory-agent.ts
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { Transaction, P2PKH, PrivateKey } from '@bsv/sdk'
import { arcBroadcast, type Network } from '../src/ladder/arc.js'

const FUNDER = process.env.FUNDER ?? 'worker1'
const FUND_SATS = Number(process.env.FUND_SATS ?? 6000)
const NETWORK: Network = (process.env.NETWORK as Network) ?? 'test'
const WOC_BASE = NETWORK === 'test' ? 'https://api.whatsonchain.com/v1/bsv/test' : 'https://api.whatsonchain.com/v1/bsv/main'

const wallets = JSON.parse(fs.readFileSync('.wallets.json', 'utf8'))
const f = wallets[FUNDER]
if (!f) throw new Error(`unknown funder ${FUNDER}`)
const funderKey = PrivateKey.fromHex(f.hex)
const funderAddr: string = f.address

const memWallet = JSON.parse(fs.readFileSync('.peck-state/memory-agent-wallet.json', 'utf8'))
const memAddr: string = memWallet.address

console.log(`[fund] funder=${FUNDER} (${funderAddr}) → memory-agent ${memAddr} : ${FUND_SATS} sat`)

const utxos = await (await fetch(`${WOC_BASE}/address/${funderAddr}/unspent`)).json() as any[]
const big = utxos.filter(u => u.value >= FUND_SATS + 500 && u.height > 0).sort((a, b) => b.value - a.value)[0]
if (!big) throw new Error(`no UTXO ≥ ${FUND_SATS + 500} sat on ${funderAddr}`)
console.log(`[fund] using UTXO ${big.tx_hash}:${big.tx_pos} (${big.value} sat)`)

const hex = await (await fetch(`${WOC_BASE}/tx/${big.tx_hash}/hex`)).text()
const parent = Transaction.fromHex(hex.trim())

const tx = new Transaction()
tx.addInput({
  sourceTransaction: parent,
  sourceOutputIndex: big.tx_pos,
  unlockingScriptTemplate: new P2PKH().unlock(funderKey),
})
tx.addOutput({ lockingScript: new P2PKH().lock(memAddr), satoshis: FUND_SATS })
tx.addOutput({ lockingScript: new P2PKH().lock(funderAddr), change: true })
await tx.fee()
await tx.sign()

const txid = tx.id('hex') as string
const rawHex = tx.toHex()
console.log(`[fund] built ${txid}`)

// Cache the funding tx hex into the memory-agent wallet so it can spend
// without WoC fetching the (mempool-fresh) parent tx itself.
memWallet.current = { txid, vout: 0, satoshis: FUND_SATS, rawHex }
fs.writeFileSync('.peck-state/memory-agent-wallet.json', JSON.stringify(memWallet, null, 2))
console.log('[fund] cached funding tx into memory-agent wallet')

const r = await arcBroadcast(rawHex, NETWORK)
if (!r.txid && !r.alreadyKnown) throw new Error(`ARC error status ${r.status}`)
console.log(`[fund] ✅ broadcast via ${r.endpoint}`)
console.log(`[fund]    https://${NETWORK === 'test' ? 'test.' : ''}whatsonchain.com/tx/${txid}`)
