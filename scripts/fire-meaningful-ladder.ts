/**
 * Meaningful ladder demo — each shot is a real (payment + service call +
 * commitment) triple.
 *
 * What it does:
 *   1. Spins up a tiny in-process HTTP stub service that pretends to be
 *      a "translation" agent. It echoes the request_id and produces a
 *      deterministic response so we can verify the binding off-chain.
 *   2. Builds a fresh small ladder from worker2 (or whatever funder is
 *      configured) — small enough to fit in available testnet sats.
 *   3. Fires N "meaningful" shots through LadderClient. Each shot:
 *        - Picks a service "request" (a phrase to translate)
 *        - Generates a request_id and 32-byte commitment
 *        - Sends payment ON-CHAIN with commitment in OP_RETURN
 *        - Sends service request OFF-CHAIN via HTTP, in parallel
 *   4. Persists the receipt log to .ladder-state/receipts.jsonl
 *   5. Verifies the on-chain OP_RETURN matches the off-chain receipt for
 *      a few sample tx-es by re-fetching from WoC.
 *
 * Run:
 *   npx tsx scripts/fire-meaningful-ladder.ts < /dev/null
 *
 * Knobs:
 *   N=20            number of meaningful calls to make
 *   STUB_PORT=9871  port the in-process service listens on
 *   FUNDER=worker2  wallet that funds the (small) ladder if needed
 *   LEAF_SATS=200   leaf size — bumped up to cover OP_RETURN overhead
 */
import 'dotenv/config'
import { readFileSync, appendFileSync, mkdirSync } from 'fs'
import { createServer } from 'http'
import { PrivateKey, Transaction } from '@bsv/sdk'
import { LadderDB } from '../src/ladder/db.js'
import { PaymentRifle } from '../src/ladder/rifle.js'
import { LadderClient, computeCommitment } from '../src/ladder/client.js'
import { buildFlatLadder } from '../src/ladder/builder.js'
import { arcEndpointInfo } from '../src/ladder/arc.js'

const NETWORK: 'test' | 'main' = (process.env.NETWORK as any) || 'test'
const N = parseInt(process.env.N || '20', 10)
const STUB_PORT = parseInt(process.env.STUB_PORT || '9871', 10)
const FUNDER = process.env.FUNDER || 'worker2'
const OWNER_AGENT = process.env.OWNER_AGENT || FUNDER
const LEAF_SATS = parseInt(process.env.LEAF_SATS || '200', 10)
const PAYMENT_SATS = parseInt(process.env.PAYMENT_SATS || '150', 10)
const RECIPIENT_NAME = process.env.RECIPIENT || 'worker1'
const DB_PATH = process.env.LADDER_DB || '.ladder-state/leaves.db'
const RECEIPT_LOG = '.ladder-state/receipts.jsonl'
const SEED_TXID = process.env.SEED_TXID
const SEED_VOUT = process.env.SEED_VOUT ? parseInt(process.env.SEED_VOUT, 10) : undefined

const WOC = NETWORK === 'test'
  ? 'https://api.whatsonchain.com/v1/bsv/test'
  : 'https://api.whatsonchain.com/v1/bsv/main'

const SAMPLE_PHRASES = [
  'hello world',
  'good morning',
  'BSV scales',
  'the agentic future',
  'micropayments work',
  'open run hackathon',
  'chronicle activated',
  'taler i kjeden',
  'verifiable receipts',
  'one input one output',
]

interface StubServiceState {
  requestsHandled: number
  requestsByid: Map<string, { received_at: number; commitment_check: 'unverified' }>
}

function startStubService(state: StubServiceState): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => body += chunk)
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}')
          const requestId = parsed.request_id || 'unknown'
          state.requestsHandled++
          state.requestsByid.set(requestId, { received_at: Date.now(), commitment_check: 'unverified' })
          // Stub "translates" by reversing the phrase
          const phrase = parsed.phrase || ''
          const translation = phrase.split('').reverse().join('')
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            request_id: requestId,
            input: phrase,
            translation,
            served_by: 'stub-translation-service',
            served_at: Date.now(),
          }))
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })
    })
    server.listen(STUB_PORT, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${STUB_PORT}/translate`,
        close: () => new Promise(res => server.close(() => res())),
      })
    })
  })
}

async function maybeBuildLadder(db: LadderDB, agent: string, count: number): Promise<void> {
  const stats = await db.stats(agent)
  if (stats.remaining >= count) {
    console.log(`  ladder ok: ${stats.remaining} leaves available for ${agent}`)
    return
  }
  console.log(`  ladder short (${stats.remaining}/${count}) — building ${count} new leaves from ${FUNDER}…`)

  const wallets = JSON.parse(readFileSync('.wallets.json', 'utf-8'))
  if (!wallets[FUNDER]) throw new Error(`no wallet '${FUNDER}' in .wallets.json`)
  const funderKey = PrivateKey.fromHex(wallets[FUNDER].hex)
  const funderAddress = wallets[FUNDER].address

  // UTXO: explicit SEED override or auto-pick largest
  let utxo: { txid: string; vout: number; satoshis: number }
  if (SEED_TXID && SEED_VOUT !== undefined) {
    const all = await fetch(`${WOC}/address/${funderAddress}/unspent`).then(r => r.json()) as Array<{
      tx_hash: string; tx_pos: number; value: number
    }>
    const found = all.find(u => u.tx_hash === SEED_TXID && u.tx_pos === SEED_VOUT)
    if (!found) throw new Error(`SEED ${SEED_TXID}:${SEED_VOUT} not in WoC unspent for ${funderAddress}`)
    utxo = { txid: SEED_TXID, vout: SEED_VOUT, satoshis: found.value }
  } else {
    const r = await fetch(`${WOC}/address/${funderAddress}/unspent`)
    const data = await r.json() as Array<{ tx_hash: string; tx_pos: number; value: number }>
    if (data.length === 0) throw new Error(`no UTXOs at ${funderAddress}`)
    data.sort((a, b) => b.value - a.value)
    utxo = { txid: data[0].tx_hash, vout: data[0].tx_pos, satoshis: data[0].value }
  }
  console.log(`  funding utxo: ${utxo.txid.slice(0, 16)}…:${utxo.vout} (${utxo.satoshis} sat)`)

  const parentHex = await fetch(`${WOC}/tx/${utxo.txid}/hex`).then(r => r.text())
  const sourceTransaction = Transaction.fromHex(parentHex.trim())

  await buildFlatLadder({
    funderKey,
    funding: { ...utxo, sourceTransaction },
    leafCount: count,
    leafSats: LEAF_SATS,
    ownerAgent: agent,
    network: NETWORK,
    db,
  })
  const after = await db.stats(agent)
  console.log(`  built — ${after.remaining}/${after.total} leaves available`)
}

async function verifyOnChainCommitment(txid: string, expectedHex: string): Promise<boolean> {
  // Re-fetch the tx from WoC and check that its OP_RETURN output contains
  // the expected commitment hash.
  try {
    const r = await fetch(`${WOC}/tx/${txid}/hex`)
    if (!r.ok) return false
    const hex = (await r.text()).trim()
    const tx = Transaction.fromHex(hex)
    for (const out of tx.outputs) {
      const scriptHex = out.lockingScript.toHex()
      if (scriptHex.includes(expectedHex.toLowerCase())) return true
    }
    return false
  } catch { return false }
}

async function main() {
  console.log(`=== Meaningful ladder demo ===`)
  console.log(`  network:    ${NETWORK}`)
  console.log(`  arc:        ${arcEndpointInfo(NETWORK)}`)
  console.log(`  N calls:    ${N}`)
  console.log(`  leaf sats:  ${LEAF_SATS}  (covers OP_RETURN overhead)`)
  console.log(`  payment:    ${PAYMENT_SATS} sat  (fee = ${LEAF_SATS - PAYMENT_SATS} sat)`)
  console.log(`  owner:      ${OWNER_AGENT}`)
  console.log()

  // 1. Start the stub service
  const stubState: StubServiceState = { requestsHandled: 0, requestsByid: new Map() }
  const stub = await startStubService(stubState)
  console.log(`  stub service: ${stub.url}`)

  // 2. Open ladder DB and ensure we have enough ammo
  mkdirSync('.ladder-state', { recursive: true })
  const db = new LadderDB(DB_PATH)
  await db.init()
  await maybeBuildLadder(db, OWNER_AGENT, N)

  // 3. Set up rifle + client
  const wallets = JSON.parse(readFileSync('.wallets.json', 'utf-8'))
  const ownerKey = PrivateKey.fromHex(wallets[OWNER_AGENT].hex)
  const recipientAddress = wallets[RECIPIENT_NAME].address

  const rifle = new PaymentRifle({
    agentName: OWNER_AGENT,
    ownerKey,
    network: NETWORK,
    db,
  })
  const client = new LadderClient(rifle)

  // 4. Fire N meaningful calls
  console.log()
  console.log(`  firing ${N} meaningful calls (payment + commitment + HTTP)…`)
  console.log()

  const receipts = []
  for (let i = 0; i < N; i++) {
    const phrase = SAMPLE_PHRASES[i % SAMPLE_PHRASES.length]
    try {
      const receipt = await client.call({
        serviceId: 'translate',
        serviceEndpoint: stub.url,
        recipientAddress,
        paymentSats: PAYMENT_SATS,
        payload: { phrase },
      })
      receipts.push(receipt)
      appendFileSync(RECEIPT_LOG, JSON.stringify(receipt) + '\n')
      console.log(
        `  #${(i + 1).toString().padStart(3)} ✅ ` +
        `tx=${receipt.txid.slice(0, 14)}… ` +
        `commit=${receipt.commitmentHex.slice(0, 12)}… ` +
        `http=${receipt.responseStatus} ` +
        `${receipt.durationMs}ms ` +
        `[${receipt.endpoint}] "${phrase.slice(0, 20)}"`
      )
    } catch (e: any) {
      console.log(`  #${(i + 1).toString().padStart(3)} ❌ ${String(e?.message || e).slice(0, 150)}`)
    }
  }

  console.log()
  console.log(`=== RESULTS ===`)
  console.log(`  on-chain shots successful:    ${receipts.length}/${N}`)
  console.log(`  off-chain HTTP requests seen: ${stubState.requestsHandled}`)
  console.log(`  receipts persisted to:        ${RECEIPT_LOG}`)

  // 5. Verify a sample of receipts against on-chain
  if (receipts.length > 0) {
    console.log()
    console.log(`  verifying first 3 commitments on-chain via WoC…`)
    const samples = receipts.slice(0, Math.min(3, receipts.length))
    for (const r of samples) {
      // ARC may not have propagated to WoC instantly — wait briefly
      await new Promise(r => setTimeout(r, 1500))
      const ok = await verifyOnChainCommitment(r.txid, r.commitmentHex)
      console.log(
        `    ${ok ? '✅' : '⏳'} ${r.txid.slice(0, 16)}… commitment=${r.commitmentHex.slice(0, 16)}… ${ok ? 'matches OP_RETURN' : 'not yet visible on WoC'}`
      )
    }
  }

  console.log()
  console.log(`=== HOW THIS PROVES "MEANINGFUL" ===`)
  console.log(`  Each on-chain tx contains a 32-byte SHA-256 commitment in OP_RETURN.`)
  console.log(`  The off-chain receipt contains: request_id, service_id, payment_sats, timestamp.`)
  console.log(`  Anyone can re-compute commitment = SHA256(request_id|service_id|sats|ts)`)
  console.log(`  and verify it matches the OP_RETURN data on-chain.`)
  console.log(`  This binds each tx to a specific provable service exchange — no spam.`)
  console.log()

  await stub.close()
  await db.close()
  process.exit(0)
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })
