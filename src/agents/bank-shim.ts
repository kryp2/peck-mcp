/**
 * bank-shim — exposes bank-local (wallet-infra) as a paid Peck Pay
 * marketplace service-agent.
 *
 * The point: bank-local is the SHARED wallet backend used by every
 * service-agent, but conceptually it IS itself a service that other
 * agents pay for. This shim makes that explicit:
 *
 *   1. Annonces itself to marketplace-registry as `wallet-as-a-service`
 *      with capabilities ['wallet','tx-build','broadcast','signing']
 *      and a per-call price.
 *   2. Wraps bank-local /createAction with a paid passthrough.
 *      For each call, FIRST writes a tiny OP_RETURN "fee receipt" tx via
 *      bank-local (sells itself a fee), THEN forwards the actual
 *      createAction request and returns the underlying txid.
 *   3. Each shim call therefore produces TWO on-chain txs: the fee
 *      receipt + the actual write. This is the "self-ref" multiplier
 *      Thomas wanted — every service hop becomes a real meaningful tx.
 *
 * For the hackathon demo this proves the architectural pitch:
 * "every hop in the agent economy is naturally a transaction".
 *
 * Run:
 *   PORT=4020 npx tsx src/agents/bank-shim.ts < /dev/null
 */
import 'dotenv/config'
import crypto from 'node:crypto'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { BankLocal, BankLocalError } from '../clients/bank-local.js'

const SERVICE_ID = process.env.SERVICE_ID || 'bank-as-a-service'
const PORT = parseInt(process.env.PORT || '4020', 10)
const PRICE_PER_CALL = parseInt(process.env.PRICE_PER_CALL || '15', 10)
const REGISTRY_URL = process.env.REGISTRY_URL || 'http://localhost:8080'
const ANNOUNCE_TO_REGISTRY = process.env.ANNOUNCE_TO_REGISTRY !== '0'
const FEE_RECEIPT_TAG = process.env.FEE_RECEIPT_TAG || 'bank-shim-fee'

// Held-earnings escrow split (Wright §5.4 — auto-held-earnings variant
// proposed 2026-04-09). Customer pays N sat, virtually split into:
//   recipient %  → service operator's withdrawable balance
//   held %       → escrow held against audit reports (slashable virtually)
//   marketplace% → bank-shim's own revenue
// All three accumulate in bank-local's actual wallet — they're virtual
// claims against the same custodial pool. No on-chain dust generated.
const SPLIT_RECIPIENT_PCT = parseInt(process.env.SPLIT_RECIPIENT_PCT || '60', 10)
const SPLIT_HELD_PCT = parseInt(process.env.SPLIT_HELD_PCT || '30', 10)
const SPLIT_MARKETPLACE_PCT = parseInt(process.env.SPLIT_MARKETPLACE_PCT || '10', 10)

// Ledger storage: memory-agent v2 with _skip_shim flag (NO local file).
// This puts the per-service ledger ON-CHAIN as proof-of-existence entries
// rather than in localhost JSON. Bank-shim caches reads in-memory for
// fast balance computation, rehydrated from memory-agent at startup.
//
// Why not sCrypt covenants for non-custodial slashing? Because that's
// days of work to design, audit, and test. The on-chain memory-agent
// approach gives us proof-of-existence per economic event, custodial
// trust to bank-local (acceptable for hackathon), and a clean upgrade
// path: replace the memory-agent backend with sCrypt-locked UTXOs and
// the bank-shim API stays the same.
const MEMORY_AGENT_URL = process.env.MEMORY_AGENT_URL || 'http://localhost:4011'
const LEDGER_CREDITS_NS = 'peck-pay:ledger:credits'
const LEDGER_WITHDRAWALS_NS = 'peck-pay:ledger:withdrawals'

const bank = new BankLocal()

const stats = {
  paid_calls: 0,
  fee_txs: 0,
  failed_fee_txs: 0,
  passthroughs: 0,
  started_at: Date.now(),
}

// ─── Per-service ledger ───────────────────────────────────────────────
//
// Append-only credit/withdrawal log keyed by service_id. Balance for a
// service is computed as:
//   earned_total       = sum of credit.recipient_share for that service
//   held_total         = sum of credit.held_share for that service
//   withdrawn_total    = sum of withdrawal.amount for that service
//   available_balance  = earned_total - withdrawn_total
//   slashed_held       = if true (after threshold reports), held_total is locked
//
// The ledger is persisted to LEDGER_PATH on each mutation (atomic write).
// In-memory cache for fast reads.

interface CreditEntry {
  service_id: string
  call_txid: string         // dedupe key — same tx → idempotent
  gross_sat: number
  recipient_share: number
  held_share: number
  marketplace_share: number
  ts: number
  description?: string
}

interface WithdrawalEntry {
  service_id: string
  amount: number
  recipient_address: string
  withdrawal_txid: string
  ts: number
}

// In-memory cache rebuilt from memory-agent at startup. Reads/writes are
// always reflected here immediately; the on-chain entry is the durable
// proof but not the source of truth for balance computation (which would
// be too slow if we re-queried memory-agent on every call).
const cache = {
  credits: [] as CreditEntry[],
  withdrawals: [] as WithdrawalEntry[],
  hydrated: false,
}

/** Hydrate the in-memory cache by reading every credit + withdrawal entry
 * from memory-agent. Best effort — if memory-agent is down at startup,
 * we boot empty and accept new credits going forward. */
async function hydrateLedgerFromChain(): Promise<void> {
  try {
    // Credits
    const creditList = await fetch(`${MEMORY_AGENT_URL}/memory-list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace: LEDGER_CREDITS_NS }),
    })
    if (creditList.ok) {
      const list = await creditList.json() as any
      for (const item of list.items ?? []) {
        try {
          const r = await fetch(`${MEMORY_AGENT_URL}/memory-read?handle=${encodeURIComponent(item.handle)}`)
          if (!r.ok) continue
          const e = await r.json() as any
          const data = typeof e.value === 'string' ? JSON.parse(e.value) : e.value
          if (data?.service_id && data?.call_txid) {
            cache.credits.push(data as CreditEntry)
          }
        } catch {}
      }
    }
    // Withdrawals
    const withList = await fetch(`${MEMORY_AGENT_URL}/memory-list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace: LEDGER_WITHDRAWALS_NS }),
    })
    if (withList.ok) {
      const list = await withList.json() as any
      for (const item of list.items ?? []) {
        try {
          const r = await fetch(`${MEMORY_AGENT_URL}/memory-read?handle=${encodeURIComponent(item.handle)}`)
          if (!r.ok) continue
          const e = await r.json() as any
          const data = typeof e.value === 'string' ? JSON.parse(e.value) : e.value
          if (data?.service_id && data?.withdrawal_txid) {
            cache.withdrawals.push(data as WithdrawalEntry)
          }
        } catch {}
      }
    }
    cache.hydrated = true
    console.log(`[${SERVICE_ID}] hydrated ledger: ${cache.credits.length} credits, ${cache.withdrawals.length} withdrawals`)
  } catch (e: any) {
    console.warn(`[${SERVICE_ID}] ledger hydration failed (memory-agent down?):`, e?.message ?? e)
  }
}

/** Persist a credit on-chain via memory-agent v2 with the _skip_shim flag.
 * The flag bypasses bank-shim's own paid-createAction wrapping (else we'd
 * get a recursive loop here). Returns the on-chain handle. */
async function persistCreditOnChain(credit: CreditEntry): Promise<string | null> {
  try {
    const r = await fetch(`${MEMORY_AGENT_URL}/memory-write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        namespace: LEDGER_CREDITS_NS,
        key: `${credit.service_id}:${credit.call_txid}`,
        value: credit,
        tags: ['ledger-credit', credit.service_id],
        _skip_shim: true,
      }),
    })
    if (!r.ok) return null
    const body = await r.json() as any
    return body.handle ?? null
  } catch {
    return null
  }
}

async function persistWithdrawalOnChain(w: WithdrawalEntry): Promise<string | null> {
  try {
    const r = await fetch(`${MEMORY_AGENT_URL}/memory-write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        namespace: LEDGER_WITHDRAWALS_NS,
        key: `${w.service_id}:${w.withdrawal_txid}`,
        value: w,
        tags: ['ledger-withdrawal', w.service_id],
        _skip_shim: true,
      }),
    })
    if (!r.ok) return null
    const body = await r.json() as any
    return body.handle ?? null
  } catch {
    return null
  }
}

async function recordCredit(serviceId: string, callTxid: string, grossSat: number, description?: string) {
  // Dedupe by (service_id + call_txid). If we've seen this tx before, skip.
  if (cache.credits.some(c => c.service_id === serviceId && c.call_txid === callTxid)) return
  // Round-down splits so totals never exceed gross. Marketplace gets the leftover.
  const recipient_share = Math.floor((grossSat * SPLIT_RECIPIENT_PCT) / 100)
  const held_share = Math.floor((grossSat * SPLIT_HELD_PCT) / 100)
  const marketplace_share = grossSat - recipient_share - held_share
  const credit: CreditEntry = {
    service_id: serviceId,
    call_txid: callTxid,
    gross_sat: grossSat,
    recipient_share,
    held_share,
    marketplace_share,
    ts: Date.now(),
    description,
  }
  cache.credits.push(credit)
  // Persist on-chain (best-effort, doesn't block the call)
  await persistCreditOnChain(credit)
}

async function recordWithdrawal(serviceId: string, amount: number, recipient: string, withdrawalTxid: string) {
  const w: WithdrawalEntry = {
    service_id: serviceId,
    amount,
    recipient_address: recipient,
    withdrawal_txid: withdrawalTxid,
    ts: Date.now(),
  }
  cache.withdrawals.push(w)
  await persistWithdrawalOnChain(w)
}

function computeBalance(serviceId: string) {
  let earned = 0, held = 0, marketplace = 0, calls = 0
  for (const c of cache.credits) {
    if (c.service_id !== serviceId) continue
    earned += c.recipient_share
    held += c.held_share
    marketplace += c.marketplace_share
    calls++
  }
  let withdrawn = 0
  for (const w of cache.withdrawals) {
    if (w.service_id === serviceId) withdrawn += w.amount
  }
  return {
    service_id: serviceId,
    calls_count: calls,
    earned_total: earned,
    held_total: held,
    marketplace_total: marketplace,
    withdrawn_total: withdrawn,
    available_balance: earned - withdrawn,
    gross_total: earned + held + marketplace,
  }
}

function listAllServices(): string[] {
  const ids = new Set<string>()
  for (const c of cache.credits) ids.add(c.service_id)
  return Array.from(ids).sort()
}

function jsonResponse(res: ServerResponse, status: number, body: any) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
async function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', c => data += c)
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}

/**
 * Write a small OP_RETURN "fee receipt" tx through bank-local to settle
 * the fee for one shim call. Payload identifies the shim, the price, and
 * a sha256 of whatever the caller is paying for so the receipt is
 * cryptographically bound to a specific request.
 *
 * Returns the receipt txid. If broadcast fails we don't block the call —
 * we just log it and increment failed_fee_txs. The caller's actual write
 * still goes through. (Mainnet would gate the call on receipt success.)
 */
async function writeFeeReceipt(opaqueRequestId: string): Promise<string | null> {
  try {
    const payload = JSON.stringify({
      shim: SERVICE_ID,
      tag: FEE_RECEIPT_TAG,
      price_sats: PRICE_PER_CALL,
      req_hash: crypto.createHash('sha256').update(opaqueRequestId).digest('hex').slice(0, 16),
      ts: Date.now(),
    })
    const script = BankLocal.opReturnScriptHex(Buffer.from(payload, 'utf8'))
    const result = await bank.createAction(`${SERVICE_ID} fee receipt`, [{ script, satoshis: 0 }])
    stats.fee_txs++
    return result.txid
  } catch (e: any) {
    stats.failed_fee_txs++
    console.warn(`[${SERVICE_ID}] fee receipt failed:`, e?.message ?? e)
    return null
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')

  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      let bankHealth: any = null
      let bankBalance: any = null
      try { bankHealth = await bank.health() } catch (e: any) { bankHealth = { error: e.message } }
      try { bankBalance = await bank.balance() } catch (e: any) { bankBalance = { error: e.message } }
      return jsonResponse(res, 200, {
        service_id: SERVICE_ID,
        wraps: bank.baseUrl,
        bank_health: bankHealth,
        bank_balance: bankBalance,
        price_per_call_sats: PRICE_PER_CALL,
        capabilities: ['wallet', 'tx-build', 'broadcast', 'signing'],
        port: PORT,
      })
    }

    if (req.method === 'GET' && req.url?.startsWith('/stats')) {
      return jsonResponse(res, 200, { ...stats, uptime_ms: Date.now() - stats.started_at })
    }

    /**
     * POST /paid-createAction
     * Same shape as bank-local /createAction, but each call also burns
     * a fee receipt OP_RETURN tx through bank-local first AND optionally
     * credits a service's virtual ledger entry per Wright §5.4 held-earnings
     * model.
     *
     * Body: {
     *   description,
     *   outputs: [{script, satoshis}],
     *   credit_service_id?: string,    // optional — service to credit for this call
     *   credit_gross_sat?: number,     // optional — gross satoshis to virtually distribute (defaults to PRICE_PER_CALL)
     * }
     * Returns: { txid, fee_receipt_txid, price_paid_sats, credited?: {...} }
     */
    if (req.method === 'POST' && req.url === '/paid-createAction') {
      const body = await readJsonBody(req)
      const { description, outputs, credit_service_id, credit_gross_sat } = body
      if (!description || !Array.isArray(outputs) || outputs.length === 0) {
        return jsonResponse(res, 400, { error: 'description and outputs[] required' })
      }

      // Cryptographically bind the fee receipt to this exact request
      const reqId = crypto.createHash('sha256')
        .update(JSON.stringify({ description, outputs }))
        .digest('hex')

      // Step 1: write fee receipt (its own on-chain tx)
      const feeReceiptTxid = await writeFeeReceipt(reqId)

      // Step 2: forward the actual createAction
      const result = await bank.createAction(description, outputs)
      stats.paid_calls++
      stats.passthroughs++

      // Step 3: on-chain ledger credit (if caller declared a recipient service)
      let credited: any = null
      if (credit_service_id && typeof credit_service_id === 'string') {
        const grossSat = Number(credit_gross_sat ?? PRICE_PER_CALL)
        await recordCredit(credit_service_id, result.txid, grossSat, description?.slice(0, 100))
        const bal = computeBalance(credit_service_id)
        credited = {
          service_id: credit_service_id,
          this_call_gross_sat: grossSat,
          new_available_balance: bal.available_balance,
          new_held_total: bal.held_total,
        }
      }

      return jsonResponse(res, 200, {
        service_id: SERVICE_ID,
        price_paid_sats: PRICE_PER_CALL,
        txid: result.txid,
        fee_receipt_txid: feeReceiptTxid,
        fee_receipt_explorer: feeReceiptTxid
          ? `https://test.whatsonchain.com/tx/${feeReceiptTxid}` : null,
        write_explorer: `https://test.whatsonchain.com/tx/${result.txid}`,
        credited,
      })
    }

    /**
     * GET /balance/<service_id>
     * Returns the per-service ledger balance computed live from credits + withdrawals.
     */
    if (req.method === 'GET' && req.url?.startsWith('/balance/')) {
      const serviceId = decodeURIComponent(req.url.substring('/balance/'.length).split('?')[0])
      if (!serviceId) return jsonResponse(res, 400, { error: 'service_id required in path' })
      const bal = computeBalance(serviceId)
      return jsonResponse(res, 200, bal)
    }

    /**
     * GET /ledger
     * Returns aggregate stats across all services in the ledger.
     */
    if (req.method === 'GET' && req.url === '/ledger') {
      const services = listAllServices()
      return jsonResponse(res, 200, {
        total_services: services.length,
        total_credits: cache.credits.length,
        total_withdrawals: cache.withdrawals.length,
        cache_hydrated_from_chain: cache.hydrated,
        services: services.map(id => computeBalance(id)),
        split_pct: {
          recipient: SPLIT_RECIPIENT_PCT,
          held: SPLIT_HELD_PCT,
          marketplace: SPLIT_MARKETPLACE_PCT,
        },
        backend: 'memory-agent v2 (on-chain via _skip_shim writes to bank-local). Cache rebuilt from chain at startup. Production extension: sCrypt-locked covenants for non-custodial slashing.',
        memory_agent_url: MEMORY_AGENT_URL,
      })
    }

    /**
     * POST /withdraw
     * Body: { service_id, recipient_address, max_amount? }
     * - Looks up balance for service_id
     * - Builds a P2PKH payout via bank-local /createAction
     * - Records the withdrawal in the ledger
     * - Returns withdrawal txid + new balance
     *
     * Slashing: callers can pre-check reputation via the MCP layer; for
     * MVP we don't auto-block here. peck_withdraw_earnings handles the
     * reputation gate before calling this endpoint.
     */
    if (req.method === 'POST' && req.url === '/withdraw') {
      const body = await readJsonBody(req)
      const serviceId = String(body.service_id || '').trim()
      const recipient = String(body.recipient_address || '').trim()
      const maxAmount = body.max_amount ? Number(body.max_amount) : undefined
      if (!serviceId) return jsonResponse(res, 400, { error: 'service_id required' })
      if (!recipient) return jsonResponse(res, 400, { error: 'recipient_address required' })

      const bal = computeBalance(serviceId)
      if (bal.available_balance < 1) {
        return jsonResponse(res, 400, { error: 'no available balance', balance: bal })
      }
      const amount = maxAmount ? Math.min(maxAmount, bal.available_balance) : bal.available_balance

      // Build P2PKH output for the recipient and forward via bank-local
      const script = BankLocal.p2pkhScriptHex(recipient)
      try {
        const result = await bank.createAction(
          `${SERVICE_ID} withdrawal ${serviceId.slice(0, 30)}`,
          [{ script, satoshis: amount }],
        )
        await recordWithdrawal(serviceId, amount, recipient, result.txid)
        const newBal = computeBalance(serviceId)
        return jsonResponse(res, 200, {
          service_id: serviceId,
          amount_withdrawn: amount,
          recipient_address: recipient,
          withdrawal_txid: result.txid,
          explorer: `https://test.whatsonchain.com/tx/${result.txid}`,
          new_balance: newBal,
          held_locked: newBal.held_total,
          held_locked_note: 'The held-escrow portion is NOT included in this withdrawal. It accumulates as virtual collateral against future audit reports. Production-extension: held escrow is released after a delay if no critical reports.',
        })
      } catch (e: any) {
        return jsonResponse(res, 502, { error: 'withdrawal createAction failed', detail: String(e?.message ?? e) })
      }
    }

    return jsonResponse(res, 404, { error: 'not_found', path: req.url })
  } catch (e: any) {
    if (e instanceof BankLocalError) {
      return jsonResponse(res, 502, { error: 'bank_local_error', detail: e.message, status: e.status })
    }
    return jsonResponse(res, 500, { error: 'internal', detail: String(e?.message ?? e) })
  }
})

async function announce() {
  if (!ANNOUNCE_TO_REGISTRY) return
  try {
    const h = await bank.health().catch(() => null)
    const r = await fetch(`${REGISTRY_URL}/announce`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: SERVICE_ID,
        name: SERVICE_ID,
        identityKey: h?.identityKey ?? '00'.repeat(33),
        endpoint: `http://localhost:${PORT}`,
        capabilities: ['wallet', 'tx-build', 'broadcast', 'signing'],
        pricePerCall: PRICE_PER_CALL,
        paymentAddress: '',
        description: 'Wallet-as-a-Service: build, sign, and broadcast BSV transactions via wallet-toolbox. Each paid call also writes a fee receipt OP_RETURN tx — every hop is a meaningful tx.',
      }),
    })
    if (r.ok) console.log(`[${SERVICE_ID}] announced to ${REGISTRY_URL}`)
    else console.log(`[${SERVICE_ID}] announce HTTP ${r.status}`)
  } catch (e: any) {
    console.log(`[${SERVICE_ID}] announce skipped: ${e?.message ?? e}`)
  }
}

server.listen(PORT, async () => {
  console.log(`[${SERVICE_ID}] listening on http://localhost:${PORT}`)
  console.log(`[${SERVICE_ID}] wraps=${bank.baseUrl} price=${PRICE_PER_CALL} sat/call`)
  console.log(`[${SERVICE_ID}] split: recipient=${SPLIT_RECIPIENT_PCT}% held=${SPLIT_HELD_PCT}% marketplace=${SPLIT_MARKETPLACE_PCT}%`)
  // Hydrate ledger cache from memory-agent on startup. Best-effort — if
  // memory-agent isn't up yet, we boot empty and start fresh.
  await hydrateLedgerFromChain()
  await announce()
})
