/**
 * retry-brc29-internalize.ts — retry a /receiveBrc29 call from a pending
 * metadata file (.peck-state/brc29-pending-<txid>.json).
 *
 * Use this when the original fund-bank-local-brc29.ts run succeeded with
 * the broadcast but failed at the internalize step (e.g. bank-local
 * couldn't fetch the raw tx). The funds are locked to a derived key —
 * the metadata is the only way bank-local can spend them.
 *
 * Usage:
 *   PENDING=.peck-state/brc29-pending-<txid>.json npx tsx scripts/retry-brc29-internalize.ts
 *   # or it auto-picks the most recent pending file
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { BankLocal } from '../src/clients/bank-local.js'

const bank = new BankLocal()

let pendingPath = process.env.PENDING
if (!pendingPath) {
  const dir = '.peck-state'
  if (!fs.existsSync(dir)) throw new Error('no .peck-state dir')
  const files = fs.readdirSync(dir).filter(f => f.startsWith('brc29-pending-')).map(f => path.join(dir, f))
  if (files.length === 0) throw new Error('no brc29-pending-*.json files')
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  pendingPath = files[0]
  console.log(`[retry] auto-picked ${pendingPath}`)
}

const meta = JSON.parse(fs.readFileSync(pendingPath, 'utf8'))
console.log('[retry] metadata:', meta)
console.log(`[retry] calling bank-local /receiveBrc29 (${bank.baseUrl})`)

const r = await fetch(`${bank.baseUrl}/receiveBrc29`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    txid: meta.txid,
    outputIndex: meta.outputIndex,
    derivationPrefix: meta.derivationPrefix,
    derivationSuffix: meta.derivationSuffix,
    senderIdentityKey: meta.senderIdentityKey,
  }),
})
const body = await r.text()
console.log(`[retry] → ${r.status} ${body}`)
if (!r.ok) process.exit(1)

const balance = await bank.balance()
console.log(`[retry] bank-local balance: ${balance.balance} sat in ${balance.spendableOutputs} outputs`)
fs.unlinkSync(pendingPath)
console.log(`[retry] cleaned up ${pendingPath}`)
