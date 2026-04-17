/**
 * split-agent.ts — fan out one agent's UTXO into N smaller UTXOs.
 *
 * Reads .agent-wallets/<agent>.json (legacy single-UTXO state), builds ONE
 * TX that spends the current UTXO and produces N outputs of roughly-equal
 * size back to the same P2PKH address. Broadcasts via ARC GorillaPool.
 * Rewrites the JSON to the multi-UTXO format so tagger/liker can round-robin.
 *
 * After this, the agent has N independent short-chain UTXOs. Each spend
 * uses one of them as input → chain-depth stays at 1 until all 50 are in
 * flight at depth 1, then depth 2 after round-robin wraps, etc.
 *
 * Usage:
 *   npx tsx scripts/split-agent.ts <agent> [n=50]
 *
 * JSON format (new):
 *   {
 *     agent, address, privKeyHex,
 *     utxos: [{txid, vout, satoshis, rawTxHex}, ...],   // length = N
 *     index: 0,                                          // round-robin cursor
 *     stats: {...}
 *   }
 */
import 'dotenv/config'
import { readFileSync, writeFileSync } from 'fs'
import { PrivateKey, P2PKH, Transaction } from '@bsv/sdk'

const AGENT = process.argv[2]
const N = parseInt(process.argv[3] || '50', 10)
if (!AGENT) { console.error('need agent'); process.exit(1) }

const WALLET_PATH = `.agent-wallets/${AGENT}.json`
const ARC = process.env.ARC_URL || 'https://arc.gorillapool.io/v1/tx'

interface OldState {
  agent: string; address: string; privKeyHex: string
  currentUtxo: { txid: string; vout: number; satoshis: number; rawTxHex: string }
  stats: any
}
interface NewState {
  agent: string; address: string; privKeyHex: string
  utxos: Array<{ txid: string; vout: number; satoshis: number; rawTxHex: string }>
  index: number
  stats: any
}

async function arcBroadcast(rawHex: string): Promise<{ ok: boolean; body: any }> {
  const isGorilla = ARC.includes('gorillapool')
  const taalKey = process.env.MAIN_TAAL_API_KEY || process.env.TAAL_MAINNET_KEY || ''
  const r = await fetch(ARC, {
    method: 'POST',
    headers: isGorilla
      ? { 'Content-Type': 'application/octet-stream' }
      : { 'Content-Type': 'application/json', 'Authorization': `Bearer ${taalKey}` },
    body: isGorilla ? Buffer.from(rawHex, 'hex') : JSON.stringify({ rawTx: rawHex }),
  })
  const body = await r.json().catch(() => ({})) as any
  const status = body.txStatus || body.status
  const ok = r.ok && (status === 'SEEN_ON_NETWORK' || status === 'ANNOUNCED_TO_NETWORK' || status === 'SENT_TO_NETWORK' || status === 'MINED')
  return { ok, body }
}

async function main() {
  const raw: OldState | NewState = JSON.parse(readFileSync(WALLET_PATH, 'utf-8'))

  // Normalize input — accept either old single-UTXO or new array state
  let inUtxo: { txid: string; vout: number; satoshis: number; rawTxHex: string }
  if ((raw as NewState).utxos && Array.isArray((raw as NewState).utxos)) {
    const arr = (raw as NewState).utxos
    const largest = arr.reduce((best, u) => u.satoshis > (best?.satoshis || 0) ? u : best, arr[0])
    inUtxo = largest
    console.log(`[split] existing multi-UTXO state — splitting the largest (${largest.satoshis} sat)`)
  } else if ((raw as OldState).currentUtxo) {
    inUtxo = (raw as OldState).currentUtxo
  } else {
    throw new Error('unknown wallet state shape')
  }

  const key = PrivateKey.fromHex(raw.privKeyHex)
  const addr = raw.address

  // Fee: ~200 bytes overhead + ~34 bytes × N outputs = ~200 + 34N bytes
  // At 100 sat/kb: (200 + 34*N) * 100 / 1000 ≈ 20 + 3.4*N sat
  const estSize = 200 + 34 * N
  const fee = Math.max(50, Math.ceil(estSize * 100 / 1000))
  const perOutput = Math.floor((inUtxo.satoshis - fee) / N)
  if (perOutput < 500) throw new Error(`not enough: ${inUtxo.satoshis} - ${fee} / ${N} = ${perOutput} per output (min 500)`)
  console.log(`[split] ${AGENT}  input=${inUtxo.satoshis}  N=${N}  perOutput=${perOutput}  fee=${fee}`)

  const parentTx = Transaction.fromHex(inUtxo.rawTxHex)
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: parentTx,
    sourceOutputIndex: inUtxo.vout,
    unlockingScriptTemplate: new P2PKH().unlock(key),
  })
  for (let i = 0; i < N; i++) {
    tx.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: perOutput })
  }
  // No explicit change — we've rounded perOutput down, small dust absorbed as extra fee
  await tx.sign()

  const rawHex = tx.toHex()
  const txid = tx.id('hex') as string
  console.log(`[split] tx: ${txid}  size=${rawHex.length / 2}B`)

  const r = await arcBroadcast(rawHex)
  if (!r.ok) {
    console.error(`[split] ARC rejected:`, JSON.stringify(r.body).slice(0, 400))
    process.exit(1)
  }
  console.log(`[split]   ✓ broadcast OK`)

  const newState: NewState = {
    agent: raw.agent,
    address: raw.address,
    privKeyHex: raw.privKeyHex,
    utxos: Array.from({ length: N }, (_, i) => ({
      txid, vout: i, satoshis: perOutput, rawTxHex: rawHex,
    })),
    index: 0,
    stats: { ...(raw.stats || {}), splitAt: new Date().toISOString(), splitN: N },
  }
  writeFileSync(WALLET_PATH, JSON.stringify(newState, null, 2))
  console.log(`[split] ✓ wrote ${N} UTXOs to ${WALLET_PATH}`)
}

main().catch(e => { console.error('[split] FAIL:', e.message || e); process.exit(1) })
