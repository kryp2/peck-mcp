/**
 * sweep-to-fleet.ts — consolidate idle scribe UTXOs back to fleet-funder.
 *
 * Builds a single multi-input → one-output TX:
 *   N inputs (one per agent's current UTXO) signed by each agent's key
 *   1 output to fleet-funder address (value = sum - fee)
 *
 * Preserves agent privKey+address, clears utxos[] after successful broadcast.
 *
 * Usage:
 *   npx tsx scripts/sweep-to-fleet.ts --range scribe-07..scribe-24
 *   npx tsx scripts/sweep-to-fleet.ts --agents scribe-07,scribe-08 --min-balance 200
 *   npx tsx scripts/sweep-to-fleet.ts --pattern 'scribe-*' --exclude scribe-01,scribe-02,scribe-03,scribe-04,scribe-05,scribe-06
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { PrivateKey, P2PKH, Transaction } from '@bsv/sdk'

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}

const MIN_BALANCE = parseInt(arg('min-balance', '300')!, 10)
const FUNDER_FILE = '.fleet-funder.json'
const WALLET_DIR = '.agent-wallets'
const TAAL_KEY = process.env.MAIN_TAAL_API_KEY || process.env.TAAL_MAINNET_KEY
const ARC_TAAL = 'https://arc.taal.com/v1/tx'

if (!TAAL_KEY) { console.error('MAIN_TAAL_API_KEY missing'); process.exit(1) }

function resolveAgents(): string[] {
  const fromAgents = arg('agents')
  const fromRange = arg('range')
  const fromPattern = arg('pattern')
  const exclude = new Set((arg('exclude') || '').split(',').map(s => s.trim()).filter(Boolean))
  let names: string[] = []
  if (fromAgents) names = fromAgents.split(',').map(s => s.trim()).filter(Boolean)
  else if (fromRange) {
    const m = fromRange.match(/^(.+?)(\d+)\.\.\1(\d+)$/) || fromRange.match(/^(.+?)(\d+)\.\.(\d+)$/)
    if (!m) { console.error(`invalid --range: ${fromRange}`); process.exit(1) }
    const prefix = m[1]
    const start = parseInt(m[2], 10)
    const end = parseInt(m[3], 10)
    const width = m[2].length
    for (let i = start; i <= end; i++) names.push(`${prefix}${String(i).padStart(width, '0')}`)
  } else if (fromPattern) {
    const re = new RegExp('^' + fromPattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '\\.json$')
    names = readdirSync(WALLET_DIR).filter(f => re.test(f)).map(f => f.replace(/\.json$/, '')).sort()
  } else {
    console.error('specify --agents, --range, or --pattern')
    process.exit(1)
  }
  return names.filter(n => !exclude.has(n))
}

async function broadcastArc(rawHex: string): Promise<{ status: string; txid: string }> {
  const r = await fetch(ARC_TAAL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TAAL_KEY}` },
    body: JSON.stringify({ rawTx: rawHex }),
  })
  const d = await r.json().catch(() => ({})) as any
  const status = String(d.txStatus || d.title || `http-${r.status}`)
  const ok = ['SEEN_ON_NETWORK', 'ANNOUNCED_TO_NETWORK', 'STORED', 'MINED', 'SEEN_IN_ORPHAN_MEMPOOL'].includes(status)
  if (!ok) throw new Error(`ARC rejected: ${status} ${JSON.stringify(d).slice(0, 400)}`)
  return { status, txid: d.txid || '' }
}

interface WalletUtxo { txid: string; vout: number; satoshis: number; rawTxHex: string }
interface WalletState { agent: string; address: string; privKeyHex: string; utxos: WalletUtxo[]; [k: string]: any }

async function main() {
  const funder = JSON.parse(readFileSync(FUNDER_FILE, 'utf-8'))
  const funderAddr = PrivateKey.fromString(funder.privKeyHex).toAddress('mainnet') as string
  console.log(`[sweep] sending to funder: ${funderAddr}`)

  const names = resolveAgents()
  console.log(`[sweep] ${names.length} agents in scope`)

  const tx = new Transaction()
  let totalIn = 0
  const swept: Array<{ name: string; state: WalletState; walletPath: string; utxo: WalletUtxo }> = []

  for (const name of names) {
    const walletPath = `${WALLET_DIR}/${name}.json`
    if (!existsSync(walletPath)) continue
    const w: WalletState = JSON.parse(readFileSync(walletPath, 'utf-8'))
    if (!w.utxos?.length) continue
    // Pick biggest utxo only (simpler, and most scribes have 1 utxo anyway)
    const u = [...w.utxos].sort((a, b) => b.satoshis - a.satoshis)[0]
    if (u.satoshis < MIN_BALANCE) continue

    const key = PrivateKey.fromHex(w.privKeyHex)
    const parentTx = Transaction.fromHex(u.rawTxHex)
    tx.addInput({
      sourceTransaction: parentTx,
      sourceOutputIndex: u.vout,
      unlockingScriptTemplate: new P2PKH().unlock(key),
    })
    swept.push({ name, state: w, walletPath, utxo: u })
    totalIn += u.satoshis
  }

  if (!swept.length) { console.log('[sweep] nothing to sweep'); return }

  console.log(`[sweep] ${swept.length} inputs, total ${totalIn.toLocaleString()} sat`)
  tx.addOutput({ lockingScript: new P2PKH().lock(funderAddr), change: true })
  await tx.fee()
  await tx.sign()

  const txid = tx.id('hex') as string
  const rawHex = tx.toHex()
  console.log(`[sweep] tx: ${txid}  size=${rawHex.length / 2}B  inputs=${tx.inputs.length}`)

  const res = await broadcastArc(rawHex)
  console.log(`[sweep] ARC status: ${res.status}`)

  // Clear utxos[] on each swept wallet
  const nowIso = new Date().toISOString()
  for (const s of swept) {
    // Remove the swept utxo from array (may have been only one)
    s.state.utxos = s.state.utxos.filter(u => !(u.txid === s.utxo.txid && u.vout === s.utxo.vout))
    s.state.stats = { ...(s.state.stats || {}), sweptAt: nowIso, sweptTxid: txid }
    writeFileSync(s.walletPath, JSON.stringify(s.state, null, 2))
  }
  console.log(`[sweep] ✓ ${swept.length} wallets cleared. Funder gained ~${totalIn.toLocaleString()} sat`)
  console.log(`[sweep] verify: https://whatsonchain.com/tx/${txid}`)
}

main().catch(e => { console.error('[sweep] FAIL:', e.message || e); process.exit(1) })
