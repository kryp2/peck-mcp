/**
 * sweep-via-peck-desktop.ts — sweep peck-desktop wallet via its local
 * HTTP wallet RPC (127.0.0.1:3321). Uses noSend:true so peck-desktop
 * SIGNS but doesn't broadcast (its broadcast path is broken). We then
 * POST the raw tx directly to ARC GorillaPool ourselves.
 *
 * Usage:
 *   npx tsx scripts/sweep-via-peck-desktop.ts [dest=fleet-funder] [sats?]
 *   sats omitted → sweep max (leave small change)
 */
import 'dotenv/config'
import { HTTPWalletJSON, P2PKH, Beef } from '@bsv/sdk'

const DEST = process.argv[2] || '1HxHKNUwPMvWwX7CwcviDMvjP5FMDcx66X'
const SATS_OVERRIDE = process.argv[3] ? parseInt(process.argv[3], 10) : undefined
const PECK_DESKTOP_URL = process.env.PECK_WALLET_URL || 'http://127.0.0.1:3321'
const ARC = process.env.ARC_URL || 'https://arc.gorillapool.io/v1/tx'

async function main() {
  console.log(`[sweep-pd] peck-desktop: ${PECK_DESKTOP_URL}`)
  console.log(`[sweep-pd] dest: ${DEST}`)

  const wallet = new HTTPWalletJSON('sweep-to-fleet-funder', PECK_DESKTOP_URL) as any

  const auth = await wallet.isAuthenticated({})
  console.log(`[sweep-pd] auth: ${JSON.stringify(auth)}`)

  // listOutputs is admin-only on peck-desktop — just try createAction directly,
  // wallet-toolbox picks inputs. If fails, caller can pass explicit sats.
  const amount = SATS_OVERRIDE ?? 9000000  // default: try to send 0.09 BSV
  console.log(`[sweep-pd] requesting createAction noSend with ${amount} sat → ${DEST}`)

  const destLock = new P2PKH().lock(DEST)
  const res = await wallet.createAction({
    description: `sweep to fleet-funder`,
    outputs: [{
      lockingScript: destLock.toHex(),
      satoshis: amount,
      outputDescription: 'sweep output',
    }],
    options: { noSend: true, acceptDelayedBroadcast: false, returnTXIDOnly: false },
  })

  if (!res.tx) { console.error('[sweep-pd] no tx returned:', JSON.stringify(res).slice(0, 500)); process.exit(1) }
  const atomicBeef = res.tx as number[]
  const subjectTxid = Buffer.from(atomicBeef.slice(4, 36)).reverse().toString('hex')
  const beefBody = Buffer.from(atomicBeef.slice(36))
  const beef = Beef.fromBinary(Array.from(beefBody))
  const tx = beef.findAtomicTransaction(subjectTxid)
  if (!tx) { console.error('no subject tx'); process.exit(1) }
  const rawHex = tx.toHex()
  const computedTxid = tx.id('hex') as string
  console.log(`[sweep-pd] signed: ${computedTxid}  size=${rawHex.length / 2}B`)

  console.log(`[sweep-pd] broadcasting direct to ${ARC} ...`)
  const r = await fetch(ARC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from(rawHex, 'hex'),
  })
  const body = await r.json().catch(() => ({})) as any
  console.log(`[sweep-pd] ARC ${r.status}  status=${body.txStatus}  txid=${body.txid}`)
  if (body.txStatus === 'SEEN_ON_NETWORK' || body.txStatus === 'ANNOUNCED_TO_NETWORK' || body.txStatus === 'MINED') {
    console.log(`[sweep-pd] ✓ ON NETWORK: https://whatsonchain.com/tx/${computedTxid}`)
  } else {
    console.log(`[sweep-pd] body:`, JSON.stringify(body).slice(0, 500))
  }
}

main().catch(e => { console.error('[sweep-pd] FAIL:', e.message || e); process.exit(1) })
