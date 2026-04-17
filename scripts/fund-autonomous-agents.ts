/**
 * fund-autonomous-agents.ts — P2PKH fanout from fleet-funder to the 10
 * personas in .autonomous-agents.json. Writes the funding UTXO back into
 * the same file so agents know what to spend.
 *
 * Usage:
 *   npx tsx scripts/fund-autonomous-agents.ts <sats-per-agent>
 *   (default: 100000)
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { PrivateKey, P2PKH, Transaction } from '@bsv/sdk'

const AMOUNT = parseInt(process.argv[2] || '100000', 10)
const FUNDER_FILE = '.fleet-funder.json'
const AGENTS_FILE = '.autonomous-agents.json'
const TAAL_KEY = process.env.MAIN_TAAL_API_KEY || process.env.TAAL_MAINNET_KEY
const ARC = 'https://arc.taal.com'
const WOC = 'https://api.whatsonchain.com/v1/bsv/main'

if (!TAAL_KEY) { console.error('MAIN_TAAL_API_KEY missing'); process.exit(1) }
if (!existsSync(FUNDER_FILE)) { console.error(`${FUNDER_FILE} missing`); process.exit(1) }
if (!existsSync(AGENTS_FILE)) { console.error(`${AGENTS_FILE} missing`); process.exit(1) }

interface Utxo { tx_hash: string; tx_pos: number; value: number; height: number; isSpentInMempoolTx?: boolean }

async function fetchUtxos(addr: string): Promise<Utxo[]> {
  const r = await fetch(`${WOC}/address/${addr}/unspent`)
  if (!r.ok) throw new Error(`WoC unspent ${r.status}`)
  const list = await r.json() as Utxo[]
  return list.filter(u => !u.isSpentInMempoolTx).sort((a, b) => b.value - a.value)
}
async function fetchTxHex(txid: string): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`${WOC}/tx/${txid}/hex`)
    if (r.ok) return (await r.text()).trim()
    if (r.status === 429 && attempt < 3) {
      await new Promise(res => setTimeout(res, 1500 * (attempt + 1)))
      continue
    }
    throw new Error(`WoC tx hex ${r.status}`)
  }
  throw new Error('WoC tx hex retries exhausted')
}
async function broadcastArc(rawHex: string): Promise<string> {
  const r = await fetch(`${ARC}/v1/tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TAAL_KEY}` },
    body: JSON.stringify({ rawTx: rawHex }),
  })
  const d = await r.json().catch(() => ({})) as any
  if (!r.ok) throw new Error(`ARC ${r.status} ${JSON.stringify(d)}`)
  return d.txid || ''
}

async function main() {
  const funder = JSON.parse(readFileSync(FUNDER_FILE, 'utf-8'))
  const funderKey = PrivateKey.fromString(funder.privKeyHex)
  const funderAddr = funderKey.toAddress('mainnet') as string
  const agents = JSON.parse(readFileSync(AGENTS_FILE, 'utf-8')) as Record<string, any>
  const ids = Object.keys(agents)
  console.log(`[fanout] funder: ${funderAddr}`)
  console.log(`[fanout] agents: ${ids.length} × ${AMOUNT} sat = ${(ids.length * AMOUNT).toLocaleString()} total`)

  const utxos = await fetchUtxos(funderAddr)
  const need = ids.length * AMOUNT + 5000
  const picked: Utxo[] = []
  let acc = 0
  for (const u of utxos) {
    picked.push(u); acc += u.value
    if (acc >= need) break
  }
  if (acc < need) throw new Error(`insufficient funds: ${acc} < ${need} across ${utxos.length} utxos`)
  console.log(`[fanout] picked ${picked.length} UTXOs totaling ${acc.toLocaleString()}`)

  const tx = new Transaction()
  for (const u of picked) {
    const parentHex = await fetchTxHex(u.tx_hash)
    const parentTx = Transaction.fromHex(parentHex)
    tx.addInput({
      sourceTransaction: parentTx,
      sourceOutputIndex: u.tx_pos,
      unlockingScriptTemplate: new P2PKH().unlock(funderKey),
    })
    await new Promise(r => setTimeout(r, 600))
  }
  for (const id of ids) {
    tx.addOutput({ lockingScript: new P2PKH().lock(agents[id].address), satoshis: AMOUNT })
  }
  tx.addOutput({ lockingScript: new P2PKH().lock(funderAddr), change: true })
  await tx.fee()
  await tx.sign()

  const txid = tx.id('hex') as string
  const rawHex = tx.toHex()
  console.log(`[fanout] tx: ${txid}  size=${rawHex.length / 2}B outputs=${tx.outputs.length}`)
  await broadcastArc(rawHex)
  console.log(`[fanout] broadcast OK`)

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]
    agents[id].fundingUtxo = { txid, vout: i, satoshis: AMOUNT, rawTxHex: rawHex }
    agents[id].fundedAt = new Date().toISOString()
    console.log(`  ✓ ${id.padEnd(10)} vout=${i} → ${agents[id].address}`)
  }
  writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2), { mode: 0o600 })
  console.log(`[fanout] verify: https://whatsonchain.com/tx/${txid}`)
}

main().catch(e => { console.error('[fanout] FAIL:', e.message || e); process.exit(1) })
