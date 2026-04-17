/**
 * refund-scribes-fresh.ts — atomic reset of 24 scribe wallets.
 *
 * Breaks chain-of-change assumption from prior sessions. Builds ONE fanout
 * TX from .fleet-funder.json → 24 scribe addresses (100k sat each), broadcasts
 * via TAAL ARC, and only after ARC-ack overwrites each .agent-wallets/scribe-XX.json
 * with a fresh utxos[] containing exactly the new outpoint.
 *
 * Preserves privKeyHex + address from existing wallet files (fail-fast if
 * privKey→address mismatch). Old utxos[] content is discarded — those coins
 * remain on chain and can be swept separately.
 *
 * Usage:
 *   MAIN_TAAL_API_KEY=... npx tsx scripts/refund-scribes-fresh.ts [sats_per_scribe=100000]
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { PrivateKey, P2PKH, Transaction } from '@bsv/sdk'

const AMOUNT = parseInt(process.argv[2] || '100000', 10)
const SCRIBE_COUNT = 24
const FUNDER_FILE = '.fleet-funder.json'
const WALLET_DIR = '.agent-wallets'
const TAAL_KEY = process.env.MAIN_TAAL_API_KEY || process.env.TAAL_MAINNET_KEY
const ARC_TAAL = 'https://arc.taal.com/v1/tx'
const WOC = 'https://api.whatsonchain.com/v1/bsv/main'

if (!TAAL_KEY) { console.error('MAIN_TAAL_API_KEY missing'); process.exit(1) }
if (!existsSync(FUNDER_FILE)) { console.error(`${FUNDER_FILE} missing`); process.exit(1) }

interface WocUtxo { tx_hash: string; tx_pos: number; value: number; height: number; isSpentInMempoolTx?: boolean }
interface Scribe { agent: string; address: string; privKeyHex: string; walletPath: string }

async function fetchUtxos(addr: string): Promise<WocUtxo[]> {
  const r = await fetch(`${WOC}/address/${addr}/unspent`)
  if (!r.ok) throw new Error(`WoC unspent ${r.status}`)
  const list = await r.json() as WocUtxo[]
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

async function broadcastArc(rawHex: string): Promise<{ status: string; txid: string; raw: any }> {
  const r = await fetch(ARC_TAAL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TAAL_KEY}` },
    body: JSON.stringify({ rawTx: rawHex }),
  })
  const d = await r.json().catch(() => ({})) as any
  const status = String(d.txStatus || d.title || `http-${r.status}`)
  const ok = ['SEEN_ON_NETWORK', 'ANNOUNCED_TO_NETWORK', 'STORED', 'MINED', 'SEEN_IN_ORPHAN_MEMPOOL'].includes(status)
  if (!ok) throw new Error(`ARC rejected: ${status} ${JSON.stringify(d).slice(0, 400)}`)
  return { status, txid: d.txid || '', raw: d }
}

function loadScribes(): Scribe[] {
  const scribes: Scribe[] = []
  for (let i = 1; i <= SCRIBE_COUNT; i++) {
    const agent = `scribe-${String(i).padStart(2, '0')}`
    const walletPath = `${WALLET_DIR}/${agent}.json`
    if (!existsSync(walletPath)) throw new Error(`missing ${walletPath}`)
    const w = JSON.parse(readFileSync(walletPath, 'utf-8'))
    if (!w.privKeyHex || !w.address) throw new Error(`${agent}: privKeyHex or address missing`)
    // Verify privKey → address
    const derived = PrivateKey.fromHex(w.privKeyHex).toAddress('mainnet') as string
    if (derived !== w.address) throw new Error(`${agent}: privKey→address mismatch (got ${derived}, expected ${w.address})`)
    scribes.push({ agent, address: w.address, privKeyHex: w.privKeyHex, walletPath })
  }
  return scribes
}

async function main() {
  console.log(`[refund-fresh] amount=${AMOUNT} × ${SCRIBE_COUNT} = ${(AMOUNT * SCRIBE_COUNT).toLocaleString()} sat`)

  const funder = JSON.parse(readFileSync(FUNDER_FILE, 'utf-8'))
  const funderKey = PrivateKey.fromString(funder.privKeyHex)
  const funderAddr = funderKey.toAddress('mainnet') as string
  console.log(`[refund-fresh] funder: ${funderAddr}`)

  const scribes = loadScribes()
  console.log(`[refund-fresh] loaded ${scribes.length} scribe identities (privKey → address verified)`)

  console.log(`[refund-fresh] fetching funder unspent...`)
  const utxos = await fetchUtxos(funderAddr)
  const need = AMOUNT * SCRIBE_COUNT + 5000
  const picked: WocUtxo[] = []
  let acc = 0
  for (const u of utxos) {
    picked.push(u); acc += u.value
    if (acc >= need) break
  }
  if (acc < need) throw new Error(`insufficient: ${acc} < ${need} across ${utxos.length} utxos`)
  console.log(`[refund-fresh] picked ${picked.length} parent UTXOs totaling ${acc.toLocaleString()} sat`)

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
  for (const s of scribes) {
    tx.addOutput({ lockingScript: new P2PKH().lock(s.address), satoshis: AMOUNT })
  }
  tx.addOutput({ lockingScript: new P2PKH().lock(funderAddr), change: true })
  await tx.fee()
  await tx.sign()

  const txid = tx.id('hex') as string
  const rawHex = tx.toHex()
  console.log(`[refund-fresh] tx: ${txid}  size=${rawHex.length / 2}B  outputs=${tx.outputs.length}`)

  console.log(`[refund-fresh] broadcasting to TAAL ARC...`)
  const res = await broadcastArc(rawHex)
  console.log(`[refund-fresh] ARC status: ${res.status}  txid: ${res.txid || txid}`)

  const nowIso = new Date().toISOString()
  for (let i = 0; i < scribes.length; i++) {
    const s = scribes[i]
    const state = {
      agent: s.agent,
      address: s.address,
      privKeyHex: s.privKeyHex,
      utxos: [{
        txid,
        vout: i,
        satoshis: AMOUNT,
        rawTxHex: rawHex,
      }],
      index: 0,
      stats: {
        refundedAt: nowIso,
        refundTxid: txid,
        refundStatus: res.status,
      },
    }
    writeFileSync(s.walletPath, JSON.stringify(state, null, 2))
    console.log(`  ✓ ${s.agent.padEnd(10)} vout=${String(i).padStart(2)} → ${s.address}`)
  }

  console.log(`\n[refund-fresh] 24/24 scribes reset`)
  console.log(`[refund-fresh] verify: https://whatsonchain.com/tx/${txid}`)
}

main().catch(e => { console.error('[refund-fresh] FAIL:', e.message || e); process.exit(1) })
