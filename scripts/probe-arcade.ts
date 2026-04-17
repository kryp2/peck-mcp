/**
 * probe-arcade.ts — submit a fresh tx directly to ARCADE to see the full
 * error body, so we know what error 467 actually means and whether we can
 * work around it.
 */
import 'dotenv/config'
import fs from 'node:fs'
import { Transaction, P2PKH, PrivateKey, Beef } from '@bsv/sdk'

const ARCADE = process.env.ARCADE_URL ?? 'https://arcade-testnet-us-1.bsvb.tech'
const FUNDER = process.env.FUNDER ?? 'worker2'

async function main() {
  const wallets = JSON.parse(fs.readFileSync('.wallets.json', 'utf8'))
  const w = wallets[FUNDER]
  if (!w) throw new Error(`unknown funder ${FUNDER}`)
  const key = PrivateKey.fromHex(w.hex)

  const utxos = await (await fetch(`https://api.whatsonchain.com/v1/bsv/test/address/${w.address}/unspent`)).json() as any[]
  const big = utxos.filter(u => u.value >= 2000 && u.height > 0).sort((a, b) => b.value - a.value)[0]
  if (!big) throw new Error(`no UTXO ≥ 2000 sat on ${w.address}`)
  console.log(`[probe] funder=${FUNDER} addr=${w.address} utxo=${big.tx_hash}:${big.tx_pos} val=${big.value}`)

  const hex = (await (await fetch(`https://api.whatsonchain.com/v1/bsv/test/tx/${big.tx_hash}/hex`)).text()).trim()
  const parent = Transaction.fromHex(hex)

  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: parent,
    sourceOutputIndex: big.tx_pos,
    unlockingScriptTemplate: new P2PKH().unlock(key),
  })
  tx.addOutput({
    lockingScript: new P2PKH().lock(w.address),
    change: true,
  })
  await tx.fee()
  await tx.sign()

  const rawHex = tx.toHex()
  const txid = tx.id('hex') as string
  console.log(`[probe] built ${txid}, raw ${rawHex.length} bytes`)

  // Per github.com/bsv-blockchain/arcade docs: Content-Type text/plain, body = raw hex
  console.log(`[probe] submitting to ${ARCADE}/tx as text/plain raw hex (per docs)`)
  const t0 = Date.now()
  const r = await fetch(`${ARCADE}/tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: rawHex,
  })
  const elapsed = Date.now() - t0
  const body = await r.text()
  console.log(`[probe] arcade status=${r.status} elapsed=${elapsed}ms`)
  console.log(`[probe] arcade body: ${body}`)

  // Variant: try with BEEF format (self-contained tx + parent + merkle proof).
  // Teranode-backed services often require this because they don't pull
  // arbitrary parents from a different network's mempool.
  console.log(`[probe] building BEEF including parent…`)
  const beef = new Beef()
  beef.mergeTransaction(parent)
  beef.mergeTransaction(tx)
  const beefBin = beef.toBinary()
  const beefHex = Buffer.from(beefBin).toString('hex')
  console.log(`[probe] beef hex len=${beefHex.length}`)

  const r3 = await fetch(`${ARCADE}/tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rawTx: beefHex }),
  })
  console.log(`[probe] /tx with beef-as-rawTx: status=${r3.status} body=${(await r3.text()).slice(0, 300)}`)

  const r4 = await fetch(`${ARCADE}/tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ beef: beefHex }),
  })
  console.log(`[probe] /tx with {beef:hex}: status=${r4.status} body=${(await r4.text()).slice(0, 300)}`)

  // Try binary octet-stream too
  const r5 = await fetch(`${ARCADE}/tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(beefBin),
  })
  console.log(`[probe] /tx with binary BEEF: status=${r5.status} body=${(await r5.text()).slice(0, 300)}`)
}

main().catch(e => { console.error('FAILED', e); process.exit(1) })
