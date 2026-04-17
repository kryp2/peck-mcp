/**
 * Build a TINY ladder on testnet — proof of concept for the pre-built
 * UTXO ladder approach.
 *
 * What it does:
 *   1. Loads worker1 from .wallets.json
 *   2. Queries WoC for worker1's largest unspent UTXO
 *   3. Fetches the parent tx hex (needed for signing)
 *   4. Calls buildFlatLadder() to create N exact-fit leaves owned by worker1
 *   5. Persists everything to .ladder-state/leaves.db
 *
 * Defaults:
 *   LEAF_COUNT=10  LEAF_SATS=300  (10 × 300 = 3000 sat + ~50 sat fee)
 *
 * Run:
 *   npx tsx scripts/build-tiny-ladder.ts < /dev/null
 */
import 'dotenv/config'
import { readFileSync, existsSync } from 'fs'
import { PrivateKey, Transaction } from '@bsv/sdk'
import { LadderDB } from '../src/ladder/db.js'
import { buildFlatLadder } from '../src/ladder/builder.js'
import { arcEndpointInfo } from '../src/ladder/arc.js'

const NETWORK: 'test' | 'main' = (process.env.NETWORK as any) || 'test'
const FUNDER_NAME = process.env.FUNDER || 'worker1'
const LEAF_COUNT = parseInt(process.env.LEAF_COUNT || '10', 10)
const LEAF_SATS  = parseInt(process.env.LEAF_SATS  || '300', 10)
const DB_PATH    = process.env.LADDER_DB || '.ladder-state/leaves.db'
// OWNER_AGENT is computed below for FUNDER=auto so it matches the
// address-scoped label the MCP server uses (auto-{addr suffix}).
let OWNER_AGENT = process.env.OWNER_AGENT || FUNDER_NAME

const WOC = NETWORK === 'test'
  ? 'https://api.whatsonchain.com/v1/bsv/test'
  : 'https://api.whatsonchain.com/v1/bsv/main'

async function pickLargestUtxo(address: string): Promise<{ txid: string; vout: number; satoshis: number }> {
  const r = await fetch(`${WOC}/address/${address}/unspent`)
  if (!r.ok) throw new Error(`WoC unspent ${r.status}`)
  const data = await r.json() as Array<{ tx_hash: string; tx_pos: number; value: number; height: number }>
  if (data.length === 0) throw new Error(`address ${address} has no unspent UTXOs on ${NETWORK}`)
  // Pick the largest UTXO regardless of confirmation status. ARC accepts
  // chained mempool spends, and a big mempool UTXO is more useful than a
  // tiny confirmed one.
  data.sort((a, b) => b.value - a.value)
  const top = data[0]
  return { txid: top.tx_hash, vout: top.tx_pos, satoshis: top.value }
}

async function fetchTxHex(txid: string): Promise<string> {
  // WoC's /tx/{txid}/hex is laggy on mempool-fresh transactions. Retry
  // with exponential backoff so we don't fail right after a faucet send.
  const delays = [0, 4000, 8000, 16000]
  let lastErr: any = null
  for (const delay of delays) {
    if (delay > 0) {
      console.log(`  waiting ${delay}ms before retrying WoC /tx/${txid.slice(0, 12)}…`)
      await new Promise(r => setTimeout(r, delay))
    }
    try {
      const r = await fetch(`${WOC}/tx/${txid}/hex`)
      if (r.ok) {
        const hex = (await r.text()).trim()
        if (hex && hex.length > 0) return hex
      }
      lastErr = new Error(`WoC tx hex ${r.status} for ${txid}`)
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error(`WoC tx hex unavailable for ${txid} after retries`)
}

async function main() {
  console.log(`=== Build tiny ladder ===`)
  console.log(`  network:    ${NETWORK}`)
  console.log(`  arc:        ${arcEndpointInfo(NETWORK)}`)
  console.log(`  funder:     ${FUNDER_NAME}`)
  console.log(`  owner:      ${OWNER_AGENT}`)
  console.log(`  leaves:     ${LEAF_COUNT} × ${LEAF_SATS} sat = ${LEAF_COUNT * LEAF_SATS} sat`)
  console.log(`  db:         ${DB_PATH}`)
  console.log()

  // Load funder. Special FUNDER='auto' loads from .peck-state/wallet.json
  // (the MCP server's auto-generated hot wallet).
  let funderKey: PrivateKey
  let funderAddress: string
  // If the auto-wallet has a `lastFundingTx` from a recent faucet call,
  // we can use it directly without going through WoC for parent fetch
  // (which is laggy on mempool-fresh transactions).
  let cachedFundingTx: { txid: string; rawHex: string; vout: number; satoshis: number } | null = null
  if (FUNDER_NAME === 'auto') {
    const path = process.env.PECK_WALLET_PATH || '.peck-state/wallet.json'
    if (!existsSync(path)) {
      throw new Error(`no auto-wallet at ${path} — start peck-mcp once to generate it`)
    }
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    funderKey = PrivateKey.fromHex(data.privateKeyHex)
    funderAddress = data.address
    if (data.lastFundingTx?.rawHex) {
      cachedFundingTx = data.lastFundingTx
      console.log(`  funder: auto-wallet from ${path}`)
      console.log(`  cached funding tx available: ${cachedFundingTx!.txid.slice(0, 16)}…:${cachedFundingTx!.vout} (${cachedFundingTx!.satoshis} sat)`)
    } else {
      console.log(`  funder: auto-wallet from ${path}`)
    }
    // Auto-wallet uses an address-scoped agent label so leaves from old
    // auto-wallets (after a wipe + regen) don't get reused under the new key.
    if (!process.env.OWNER_AGENT) {
      OWNER_AGENT = `auto-${(funderAddress as string).slice(-8)}`
      console.log(`  owner agent (scoped): ${OWNER_AGENT}`)
    }
  } else {
    const wallets = JSON.parse(readFileSync('.wallets.json', 'utf-8'))
    if (!wallets[FUNDER_NAME]) throw new Error(`no wallet '${FUNDER_NAME}' in .wallets.json`)
    funderKey = PrivateKey.fromHex(wallets[FUNDER_NAME].hex)
    funderAddress = wallets[FUNDER_NAME].address
  }
  console.log(`  funder addr: ${funderAddress}`)

  // Pick UTXO. Priority:
  //   1. cached funding tx from auto-wallet (no WoC needed — fresh-friendly)
  //   2. explicit SEED_TXID/SEED_VOUT env override
  //   3. auto-pick largest from WoC
  let utxo: { txid: string; vout: number; satoshis: number }
  let sourceTransaction: Transaction

  if (cachedFundingTx) {
    utxo = {
      txid: cachedFundingTx.txid,
      vout: cachedFundingTx.vout,
      satoshis: cachedFundingTx.satoshis,
    }
    sourceTransaction = Transaction.fromHex(cachedFundingTx.rawHex)
    console.log(`  source utxo: ${utxo.txid}:${utxo.vout} (${utxo.satoshis} sat) [cached funding tx, no WoC]`)
  } else if (process.env.SEED_TXID && process.env.SEED_VOUT !== undefined) {
    const seedTxid = process.env.SEED_TXID
    const seedVout = parseInt(process.env.SEED_VOUT, 10)
    const all = await fetch(`${WOC}/address/${funderAddress}/unspent`)
      .then(r => r.json()) as Array<{ tx_hash: string; tx_pos: number; value: number }>
    const found = all.find(u => u.tx_hash === seedTxid && u.tx_pos === seedVout)
    if (!found) throw new Error(`SEED_TXID ${seedTxid}:${seedVout} not in WoC unspent for ${funderAddress}`)
    utxo = { txid: seedTxid, vout: seedVout, satoshis: found.value }
    console.log(`  source utxo: ${utxo.txid}:${utxo.vout} (${utxo.satoshis} sat) [explicit SEED]`)
    sourceTransaction = Transaction.fromHex(await fetchTxHex(utxo.txid))
  } else {
    utxo = await pickLargestUtxo(funderAddress)
    console.log(`  source utxo: ${utxo.txid}:${utxo.vout} (${utxo.satoshis} sat) [auto-picked]`)
    sourceTransaction = Transaction.fromHex(await fetchTxHex(utxo.txid))
  }

  if (utxo.satoshis < LEAF_COUNT * LEAF_SATS + 200) {
    throw new Error(
      `source UTXO ${utxo.satoshis} sat too small for ${LEAF_COUNT * LEAF_SATS} sat in leaves + ~200 sat fee headroom`
    )
  }

  // Open ladder DB
  const db = new LadderDB(DB_PATH)
  await db.init()

  // Build it
  console.log(`\n  building setup tx + leaves…`)
  const result = await buildFlatLadder({
    funderKey,
    funding: { ...utxo, sourceTransaction },
    leafCount: LEAF_COUNT,
    leafSats: LEAF_SATS,
    ownerAgent: OWNER_AGENT,
    network: NETWORK,
    db,
  })

  console.log()
  console.log(`=== RESULT ===`)
  console.log(`  setup txid:        ${result.setupTxid}`)
  console.log(`  leaves created:    ${result.leavesCreated}`)
  console.log(`  total spent:       ${result.totalSpent} sat`)
  console.log(`  change returned:   ${result.changeReturned} sat`)
  console.log(`  fee paid:          ${result.totalSpent - result.leavesCreated * LEAF_SATS} sat`)
  console.log()
  console.log(`  WoC:  https://${NETWORK === 'test' ? 'test.' : ''}whatsonchain.com/tx/${result.setupTxid}`)
  console.log()

  const stats = await db.stats(OWNER_AGENT)
  console.log(`  ladder stats: ${stats.remaining}/${stats.total} leaves available for ${OWNER_AGENT}`)

  await db.close()
  process.exit(0)
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })
