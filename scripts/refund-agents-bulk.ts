/**
 * refund-agents-bulk.ts — atomic fanout refund for a list of agent wallets.
 *
 * Same precision guarantees as refund-scribes-fresh.ts but takes a flexible
 * agent list via CLI args, env, or glob-style pattern. Overwrites each
 * target .agent-wallets/<name>.json with a single fresh utxos[0] — old
 * utxos[] content is discarded (chain-of-change from prior sessions cannot
 * be trusted after async-Cloud-Run-kill incidents).
 *
 * Supports chunking: if agent count × output size would exceed single-TX
 * limits or fee-budget, splits into multiple fanout TXs from separate funder
 * UTXOs.
 *
 * Usage:
 *   # Explicit list
 *   npx tsx scripts/refund-agents-bulk.ts --agents cls-01,cls-02,wis-5 --amount 80000
 *
 *   # Name range
 *   npx tsx scripts/refund-agents-bulk.ts --range cls-01..cls-100 --amount 80000
 *
 *   # Glob pattern (reads matching .agent-wallets/*.json)
 *   npx tsx scripts/refund-agents-bulk.ts --pattern 'cls-*' --amount 80000
 *
 *   # Via file
 *   npx tsx scripts/refund-agents-bulk.ts --from /tmp/agents.txt --amount 80000
 *
 * Options:
 *   --amount <sat>      sats per agent (default 80000)
 *   --chunk <N>         max outputs per fanout TX (default 200)
 *   --dry-run           don't broadcast, don't overwrite wallets
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { PrivateKey, P2PKH, Transaction } from '@bsv/sdk'

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

const AMOUNT = parseInt(arg('amount', '80000')!, 10)
const CHUNK = parseInt(arg('chunk', '200')!, 10)
const DRY_RUN = flag('dry-run')

const FUNDER_FILE = '.fleet-funder.json'
const WALLET_DIR = '.agent-wallets'
const TAAL_KEY = process.env.MAIN_TAAL_API_KEY || process.env.TAAL_MAINNET_KEY
const ARC_TAAL = 'https://arc.taal.com/v1/tx'
const WOC = 'https://api.whatsonchain.com/v1/bsv/main'

if (!TAAL_KEY) { console.error('MAIN_TAAL_API_KEY missing'); process.exit(1) }
if (!existsSync(FUNDER_FILE)) { console.error(`${FUNDER_FILE} missing`); process.exit(1) }

function resolveAgents(): string[] {
  const fromArg = arg('agents')
  const fromRange = arg('range')
  const fromPattern = arg('pattern')
  const fromFile = arg('from')

  let names: string[] = []
  if (fromArg) names = fromArg.split(',').map(s => s.trim()).filter(Boolean)
  else if (fromFile) names = readFileSync(fromFile, 'utf-8').split(/\s+/).map(s => s.trim()).filter(Boolean)
  else if (fromRange) {
    // e.g. cls-01..cls-100 — extract prefix + numeric width
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
    console.error('specify one of: --agents, --range, --pattern, --from')
    process.exit(1)
  }
  return names
}

interface WocUtxo { tx_hash: string; tx_pos: number; value: number; height: number; isSpentInMempoolTx?: boolean }
interface Target { name: string; address: string; privKeyHex: string; walletPath: string }

async function fetchUtxos(addr: string): Promise<WocUtxo[]> {
  const r = await fetch(`${WOC}/address/${addr}/unspent`)
  if (!r.ok) throw new Error(`WoC unspent ${r.status}`)
  const list = await r.json() as WocUtxo[]
  const exclude = (process.env.EXCLUDE_UTXO || '').split(',').map(s => s.trim()).filter(Boolean)
  return list
    .filter(u => !u.isSpentInMempoolTx)
    .filter(u => !exclude.some(e => e === u.tx_hash || e === `${u.tx_hash}:${u.tx_pos}`))
    .sort((a, b) => b.value - a.value)
}
async function fetchTxHex(txid: string): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`${WOC}/tx/${txid}/hex`)
    if (r.ok) return (await r.text()).trim()
    if (r.status === 429 && attempt < 3) { await new Promise(res => setTimeout(res, 1500 * (attempt + 1))); continue }
    throw new Error(`WoC tx hex ${r.status}`)
  }
  throw new Error('WoC tx hex retries exhausted')
}
async function broadcastArc(rawHex: string): Promise<{ status: string; txid: string }> {
  const r = await fetch(ARC_TAAL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TAAL_KEY}` },
    body: JSON.stringify({ rawTx: rawHex }),
  })
  const d = await r.json().catch(() => ({})) as any
  const status = String(d.txStatus || d.title || `http-${r.status}`)
  const ok = ['SEEN_ON_NETWORK', 'ANNOUNCED_TO_NETWORK', 'STORED', 'MINED', 'SEEN_IN_ORPHAN_MEMPOOL', 'REQUESTED_BY_NETWORK', 'SENT_TO_NETWORK'].includes(status)
  if (!ok) throw new Error(`ARC rejected: ${status} ${JSON.stringify(d).slice(0, 400)}`)
  return { status, txid: d.txid || '' }
}

function loadTargets(names: string[]): Target[] {
  const missing: string[] = []
  const mismatched: string[] = []
  const t: Target[] = []
  for (const name of names) {
    const walletPath = `${WALLET_DIR}/${name}.json`
    if (!existsSync(walletPath)) { missing.push(name); continue }
    const w = JSON.parse(readFileSync(walletPath, 'utf-8'))
    if (!w.privKeyHex || !w.address) { missing.push(name); continue }
    const derived = PrivateKey.fromHex(w.privKeyHex).toAddress('mainnet') as string
    if (derived !== w.address) { mismatched.push(`${name}: ${w.address} vs derived ${derived}`); continue }
    t.push({ name, address: w.address, privKeyHex: w.privKeyHex, walletPath })
  }
  if (missing.length) console.error(`[refund-bulk] missing wallets: ${missing.length} first=${missing[0]}`)
  if (mismatched.length) { console.error(`[refund-bulk] key/addr mismatch: ${mismatched.length}`); for (const m of mismatched.slice(0, 3)) console.error('  ', m); process.exit(1) }
  return t
}

async function buildAndBroadcast(funderKey: PrivateKey, funderAddr: string, batch: Target[], remainingFunderUtxos: WocUtxo[]): Promise<{ txid: string; rawHex: string; status: string; consumedUtxos: number }> {
  const need = batch.length * AMOUNT + 5000
  const picked: WocUtxo[] = []
  let acc = 0
  while (picked.length < remainingFunderUtxos.length && acc < need) {
    const u = remainingFunderUtxos.shift()!
    picked.push(u); acc += u.value
  }
  if (acc < need) throw new Error(`insufficient: need ${need}, got ${acc}`)

  const tx = new Transaction()
  for (const u of picked) {
    const parentHex = await fetchTxHex(u.tx_hash)
    const parentTx = Transaction.fromHex(parentHex)
    tx.addInput({
      sourceTransaction: parentTx,
      sourceOutputIndex: u.tx_pos,
      unlockingScriptTemplate: new P2PKH().unlock(funderKey),
    })
    await new Promise(r => setTimeout(r, 400))
  }
  for (const tgt of batch) tx.addOutput({ lockingScript: new P2PKH().lock(tgt.address), satoshis: AMOUNT })
  tx.addOutput({ lockingScript: new P2PKH().lock(funderAddr), change: true })
  await tx.fee()
  await tx.sign()

  const txid = tx.id('hex') as string
  const rawHex = tx.toHex()
  if (DRY_RUN) {
    console.log(`[refund-bulk] DRY ${txid} size=${rawHex.length / 2}B outputs=${tx.outputs.length}`)
    return { txid, rawHex, status: 'DRY_RUN', consumedUtxos: picked.length }
  }
  const res = await broadcastArc(rawHex)
  return { ...res, rawHex, consumedUtxos: picked.length }
}

async function main() {
  const names = resolveAgents()
  const targets = loadTargets(names)
  console.log(`[refund-bulk] target_count=${targets.length} amount=${AMOUNT} sat per  chunk=${CHUNK}  dry=${DRY_RUN}`)
  const totalNeed = targets.length * AMOUNT + Math.ceil(targets.length / CHUNK) * 5000
  console.log(`[refund-bulk] total_budget=${totalNeed.toLocaleString()} sat`)

  const funder = JSON.parse(readFileSync(FUNDER_FILE, 'utf-8'))
  const funderKey = PrivateKey.fromString(funder.privKeyHex)
  const funderAddr = funderKey.toAddress('mainnet') as string
  console.log(`[refund-bulk] funder: ${funderAddr}`)

  console.log(`[refund-bulk] fetching funder unspent…`)
  const utxos = await fetchUtxos(funderAddr)
  const funderTotal = utxos.reduce((s, u) => s + u.value, 0)
  console.log(`[refund-bulk] funder balance: ${funderTotal.toLocaleString()} sat across ${utxos.length} utxos`)
  if (funderTotal < totalNeed) { console.error(`insufficient funder balance`); process.exit(1) }

  const chunks: Target[][] = []
  for (let i = 0; i < targets.length; i += CHUNK) chunks.push(targets.slice(i, i + CHUNK))
  console.log(`[refund-bulk] will broadcast ${chunks.length} fanout TXs`)

  const nowIso = new Date().toISOString()
  for (let ci = 0; ci < chunks.length; ci++) {
    const batch = chunks[ci]
    console.log(`\n[chunk ${ci + 1}/${chunks.length}] ${batch.length} agents ${batch[0].name}..${batch[batch.length - 1].name}`)
    const { txid, rawHex, status } = await buildAndBroadcast(funderKey, funderAddr, batch, utxos)
    console.log(`  tx=${txid} status=${status} size=${rawHex.length / 2}B`)

    if (!DRY_RUN) {
      for (let i = 0; i < batch.length; i++) {
        const t = batch[i]
        const state = {
          agent: t.name,
          address: t.address,
          privKeyHex: t.privKeyHex,
          utxos: [{ txid, vout: i, satoshis: AMOUNT, rawTxHex: rawHex }],
          index: 0,
          stats: { refundedAt: nowIso, refundTxid: txid, refundStatus: status },
        }
        writeFileSync(t.walletPath, JSON.stringify(state, null, 2))
      }
      console.log(`  ✓ wrote ${batch.length} wallet files`)
    }
  }

  console.log(`\n[refund-bulk] DONE ${targets.length} agents refunded across ${chunks.length} fanout TXs`)
}

main().catch(e => { console.error('[refund-bulk] FAIL:', e.message || e); process.exit(1) })
