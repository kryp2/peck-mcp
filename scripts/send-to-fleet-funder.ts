/**
 * Send 125k sats from peck-desktop (via createAction) to fleet-funder address.
 * Bypasses the BRC-29 peer-pay flow (which is stuck); uses raw P2PKH output
 * direct from peck-desktop's wallet-toolbox. Same pattern that's succeeded
 * tonight for OP_RETURN TXs — just with a P2PKH output instead.
 *
 * Run: npx tsx scripts/send-to-fleet-funder.ts [sats=125000]
 */
import { P2PKH, Script, OP } from '@bsv/sdk'
import { readFileSync } from 'fs'

const WALLET = 'http://localhost:3321'
const ORIGIN = 'https://peck.to'

async function wallet(method: string, args: any): Promise<any> {
  const r = await fetch(`${WALLET}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify(args),
  })
  if (!r.ok) throw new Error(`${method} ${r.status}: ${await r.text()}`)
  return await r.json()
}

async function main() {
  const sats = parseInt(process.argv[2] || '125000', 10)
  const funder = JSON.parse(readFileSync('.fleet-funder.json', 'utf-8'))
  const p2pkhScript = new P2PKH().lock(funder.address).toHex()

  // OP_RETURN marker — wallet-internal broadcast pipeline only fires for TXs
  // that include a data output. Minimal marker: OP_FALSE OP_RETURN "peck-fund"
  const marker = new Script()
  marker.writeOpCode(OP.OP_FALSE); marker.writeOpCode(OP.OP_RETURN)
  marker.writeBin(Array.from(Buffer.from('peck-fleet-fund', 'utf8')))

  console.log(`→ sending ${sats} sats to ${funder.address}`)
  console.log(`  p2pkh: ${p2pkhScript}`)

  const auth = await wallet('isAuthenticated', {})
  if (!auth.authenticated) throw new Error('peck-desktop not authenticated; unlock it first')

  const result = await wallet('createAction', {
    description: 'Fund fleet-funder for curator fleet',
    outputs: [
      { lockingScript: marker.toHex(), satoshis: 0, outputDescription: 'fleet-fund marker' },
      { lockingScript: p2pkhScript, satoshis: sats, outputDescription: 'fleet-funder bootstrap' },
    ],
    labels: ['peck', 'fleet', 'funding'],
    feeUnit: { satoshis: 100, bytes: 1000 },
    options: { acceptDelayedBroadcast: true, returnTXIDOnly: false },
  })

  console.log(`\n✅ txid: ${result.txid}`)
  console.log(`   view: https://whatsonchain.com/tx/${result.txid}`)
  console.log(`\nverify balance at fleet-funder:`)
  console.log(`   curl https://api.whatsonchain.com/v1/bsv/main/address/${funder.address}/balance`)
}

main().catch(e => { console.error('FAIL:', e.message || e); process.exit(1) })
