/**
 * fund-p2pkh-fanout.ts — fund N agents via ONE raw P2PKH fanout tx.
 *
 * Sends sats directly to each agent's identity P2PKH address (no BRC-29,
 * no wallet-infra). Saves each agent's funding outpoint to
 * .agent-wallets/<agent>.json so the tagger can spend it client-side.
 *
 * One TX, no chained-sequential WoC polling, zero double-spend risk.
 *
 * Usage:
 *   npx tsx scripts/fund-p2pkh-fanout.ts <sats-per-agent> <agent1,agent2,...>
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { PrivateKey, P2PKH, Transaction } from '@bsv/sdk'
import { Services } from '@bsv/wallet-toolbox'

const AMOUNT = parseInt(process.argv[2] || '1000000', 10)
const AGENTS = (process.argv[3] || '').split(',').map(s => s.trim()).filter(Boolean)
if (!AGENTS.length) { console.error('need agents'); process.exit(1) }

const FUNDER_FILE = '.fleet-funder.json'
const REGISTRY = '.brc-identities.json'
const WALLET_DIR = '.agent-wallets'
const TAAL_KEY = process.env.MAIN_TAAL_API_KEY || process.env.TAAL_MAINNET_KEY
const ARC = process.env.ARC_URL || 'https://arc.gorillapool.io'
const WOC = 'https://api.whatsonchain.com/v1/bsv/main'

if (!TAAL_KEY) { console.error('MAIN_TAAL_API_KEY missing'); process.exit(1) }
if (!existsSync(FUNDER_FILE)) { console.error(`${FUNDER_FILE} missing`); process.exit(1) }
if (!existsSync(WALLET_DIR)) mkdirSync(WALLET_DIR, { recursive: true })

interface Utxo { tx_hash: string; tx_pos: number; value: number; height: number; isSpentInMempoolTx?: boolean }

async function fetchUtxos(addr: string): Promise<Utxo[]> {
  const r = await fetch(`${WOC}/address/${addr}/unspent`)
  if (!r.ok) throw new Error(`WoC unspent ${r.status}`)
  const list = await r.json() as Utxo[]
  const exclude = (process.env.EXCLUDE_UTXO || '').split(',').filter(Boolean)
  return list
    .filter(u => !u.isSpentInMempoolTx)
    .filter(u => !exclude.includes(u.tx_hash))
    .sort((a, b) => b.value - a.value)
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
  throw new Error(`WoC tx hex: exhausted retries`)
}
async function broadcastArc(rawHex: string): Promise<string> {
  // GorillaPool accepts octet-stream rawtx; TAAL wants JSON {rawTx}
  const isGorilla = ARC.includes('gorillapool')
  const r = await fetch(`${ARC}/v1/tx`, {
    method: 'POST',
    headers: isGorilla
      ? { 'Content-Type': 'application/octet-stream' }
      : { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TAAL_KEY}` },
    body: isGorilla ? Buffer.from(rawHex, 'hex') : JSON.stringify({ rawTx: rawHex }),
  })
  const d = await r.json().catch(() => ({})) as any
  if (!r.ok) throw new Error(`ARC ${r.status} ${JSON.stringify(d)}`)
  return d.txid || ''
}

async function main() {
  const funder = JSON.parse(readFileSync(FUNDER_FILE, 'utf-8'))
  const funderKey = PrivateKey.fromString(funder.privKeyHex)
  const funderAddr = funderKey.toAddress('mainnet') as string
  console.log(`[p2pkh] funder: ${funderAddr}`)
  console.log(`[p2pkh] agents: ${AGENTS.length} × ${AMOUNT} sat = ${(AGENTS.length * AMOUNT).toLocaleString()} total`)

  const reg = JSON.parse(readFileSync(REGISTRY, 'utf-8'))
  const targets = AGENTS.map(name => {
    const id = reg[name]
    if (!id) throw new Error(`no id for ${name}`)
    const k = PrivateKey.fromHex(id.privKeyHex)
    const addr = k.toAddress('mainnet') as string
    return { name, privKeyHex: id.privKeyHex, addr }
  })

  console.log(`[p2pkh] selecting parent utxos (largest first)...`)
  const utxos = await fetchUtxos(funderAddr)
  const need = AGENTS.length * AMOUNT + 5000 // buffer for fees + multi-input
  const picked: Utxo[] = []
  let acc = 0
  for (const u of utxos) {
    picked.push(u); acc += u.value
    if (acc >= need) break
  }
  if (acc < need) throw new Error(`insufficient funds: ${acc} < ${need} (across ${utxos.length} utxos)`)
  console.log(`[p2pkh]   picked ${picked.length} UTXOs totaling ${acc.toLocaleString()} sat`)

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
  for (const t of targets) {
    tx.addOutput({ lockingScript: new P2PKH().lock(t.addr), satoshis: AMOUNT })
  }
  tx.addOutput({ lockingScript: new P2PKH().lock(funderAddr), change: true })
  await tx.fee()
  await tx.sign()

  const txid = tx.id('hex') as string
  const rawHex = tx.toHex()
  console.log(`[p2pkh] tx: ${txid}  (${rawHex.length / 2} bytes, ${tx.outputs.length} outputs)`)
  console.log(`[p2pkh] broadcasting to ARC TAAL...`)
  await broadcastArc(rawHex)
  console.log(`[p2pkh]   ✓ broadcast OK`)

  // Save one wallet JSON per agent
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]
    const state = {
      agent: t.name,
      address: t.addr,
      privKeyHex: t.privKeyHex,
      currentUtxo: {
        txid,
        vout: i,
        satoshis: AMOUNT,
        rawTxHex: rawHex,  // needed as sourceTransaction for child signing
      },
      stats: { emitted: 0, totalSpent: 0, createdAt: new Date().toISOString() },
    }
    writeFileSync(`${WALLET_DIR}/${t.name}.json`, JSON.stringify(state, null, 2))
    console.log(`  ✓ ${t.name.padEnd(22)} vout=${i} → ${WALLET_DIR}/${t.name}.json`)
  }

  console.log(`\n[p2pkh] ${targets.length}/${targets.length} agents funded`)
  console.log(`[p2pkh] verify: https://whatsonchain.com/tx/${txid}`)
}

main().catch(e => { console.error('[p2pkh] FAIL:', e.message || e); process.exit(1) })
