/**
 * refund-autonomous-agents.ts — rebuild fanout using a SPECIFIC funder UTXO
 * (pass via env FUNDER_TXID + FUNDER_VOUT). Overwrites fundingUtxo fields in
 * .autonomous-agents.json so agents pick up the new parent.
 *
 * Usage:
 *   FUNDER_TXID=36b2bf14... FUNDER_VOUT=0 \
 *     npx tsx scripts/refund-autonomous-agents.ts <sats-per-agent>
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { PrivateKey, P2PKH, Transaction } from '@bsv/sdk'

const AMOUNT = parseInt(process.argv[2] || '80000', 10)
const FUNDER_TXID = process.env.FUNDER_TXID
const FUNDER_VOUT = parseInt(process.env.FUNDER_VOUT || '0', 10)
const FUNDER_FILE = '.fleet-funder.json'
const AGENTS_FILE = '.autonomous-agents.json'
const TAAL_KEY = process.env.MAIN_TAAL_API_KEY || process.env.TAAL_MAINNET_KEY
const ARC_GORILLA = 'https://arc.gorillapool.io/v1/tx'
const ARC_TAAL = 'https://arc.taal.com/v1/tx'
const WOC = 'https://api.whatsonchain.com/v1/bsv/main'

if (!FUNDER_TXID) { console.error('FUNDER_TXID env required'); process.exit(1) }
if (!existsSync(FUNDER_FILE) || !existsSync(AGENTS_FILE)) { console.error('missing state files'); process.exit(1) }

async function fetchTxHex(txid: string): Promise<string> {
  const r = await fetch(`${WOC}/tx/${txid}/hex`)
  if (!r.ok) throw new Error(`WoC tx hex ${r.status}`)
  return (await r.text()).trim()
}
async function broadcast(rawHex: string): Promise<any> {
  // Try GorillaPool (no key) first, then TAAL
  let lastErr: any
  for (const url of [ARC_GORILLA, ARC_TAAL]) {
    try {
      const headers: any = { 'Content-Type': 'application/octet-stream' }
      if (url.includes('taal') && TAAL_KEY) headers['Authorization'] = `Bearer ${TAAL_KEY}`
      const r = await fetch(url, { method: 'POST', headers, body: Buffer.from(rawHex, 'hex') })
      const d = await r.json().catch(() => ({})) as any
      console.log(`[refund] ${url.split('/')[2]} status=${r.status} txStatus=${d.txStatus}`)
      if (d.txStatus === 'SEEN_ON_NETWORK' || d.txStatus === 'ANNOUNCED_TO_NETWORK' || d.txStatus === 'MINED' || d.txStatus === 'STORED') {
        return d
      }
      lastErr = d
    } catch (e) { lastErr = e }
  }
  throw new Error(`broadcast failed: ${JSON.stringify(lastErr).slice(0, 300)}`)
}

async function main() {
  const funder = JSON.parse(readFileSync(FUNDER_FILE, 'utf-8'))
  const funderKey = PrivateKey.fromString(funder.privKeyHex)
  const funderAddr = funderKey.toAddress('mainnet') as string
  const agents = JSON.parse(readFileSync(AGENTS_FILE, 'utf-8')) as Record<string, any>
  const ids = Object.keys(agents)
  console.log(`[refund] funder: ${funderAddr}`)
  console.log(`[refund] input: ${FUNDER_TXID}:${FUNDER_VOUT}`)
  console.log(`[refund] agents: ${ids.length} × ${AMOUNT} = ${(ids.length * AMOUNT).toLocaleString()} sat`)

  const parentHex = await fetchTxHex(FUNDER_TXID!)
  const parentTx = Transaction.fromHex(parentHex)

  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: parentTx,
    sourceOutputIndex: FUNDER_VOUT,
    unlockingScriptTemplate: new P2PKH().unlock(funderKey),
  })
  for (const id of ids) {
    tx.addOutput({ lockingScript: new P2PKH().lock(agents[id].address), satoshis: AMOUNT })
  }
  tx.addOutput({ lockingScript: new P2PKH().lock(funderAddr), change: true })
  await tx.fee()
  await tx.sign()

  const txid = tx.id('hex') as string
  const rawHex = tx.toHex()
  console.log(`[refund] tx: ${txid} size=${rawHex.length / 2}B outputs=${tx.outputs.length}`)

  await broadcast(rawHex)
  console.log(`[refund] broadcast accepted`)

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]
    agents[id].fundingUtxo = { txid, vout: i, satoshis: AMOUNT, rawTxHex: rawHex }
    agents[id].fundedAt = new Date().toISOString()
    console.log(`  ✓ ${id.padEnd(10)} vout=${i}`)
  }
  writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2), { mode: 0o600 })
  console.log(`[refund] verify: https://whatsonchain.com/tx/${txid}`)
}

main().catch(e => { console.error('[refund] FAIL:', e.message || e); process.exit(1) })
