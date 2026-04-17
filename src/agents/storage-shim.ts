/**
 * storage-shim — exposes storage-local (uhrp-storage-server + fake-gcs)
 * as a paid Peck Pay marketplace service-agent.
 *
 * Same self-ref pattern as bank-shim: every paid /paid-upload-bytes call
 * burns a fee receipt OP_RETURN tx through bank-local. The blob still
 * persists to fake-gcs as before — this just makes the storage layer
 * a discoverable, paid market participant.
 *
 * Combined with bank-shim, a single memory-write that goes through both
 * shims now produces THREE on-chain txs:
 *   1. storage-shim fee receipt
 *   2. bank-shim fee receipt
 *   3. The actual OP_RETURN write that anchors the memory entry
 *
 * That's the "self-ref multiplier" — the agent economy naturally
 * generates 3x the on-chain volume per logical operation.
 *
 * Run:
 *   PORT=4021 npx tsx src/agents/storage-shim.ts < /dev/null
 */
import 'dotenv/config'
import crypto from 'node:crypto'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { BankLocal, BankLocalError } from '../clients/bank-local.js'
import { StorageLocal } from '../clients/storage-local.js'

const SERVICE_ID = process.env.SERVICE_ID || 'storage-as-a-service'
const PORT = parseInt(process.env.PORT || '4021', 10)
const PRICE_PER_CALL = parseInt(process.env.PRICE_PER_CALL || '20', 10)
const REGISTRY_URL = process.env.REGISTRY_URL || 'http://localhost:8080'
const ANNOUNCE_TO_REGISTRY = process.env.ANNOUNCE_TO_REGISTRY !== '0'
const FEE_RECEIPT_TAG = process.env.FEE_RECEIPT_TAG || 'storage-shim-fee'

const bank = new BankLocal()
const storage = new StorageLocal()

const stats = {
  paid_uploads: 0,
  fee_txs: 0,
  failed_fee_txs: 0,
  bytes_stored: 0,
  started_at: Date.now(),
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
      const storageHealth = await storage.health().catch((e: any) => ({ ok: false, error: e?.message }))
      let bankBalance: any = null
      try { bankBalance = await bank.balance() } catch (e: any) { bankBalance = { error: e.message } }
      return jsonResponse(res, 200, {
        service_id: SERVICE_ID,
        wraps_storage: storage.storageUrl,
        wraps_blob_backend: storage.fakeGcsUrl,
        wraps_bank_for_fees: bank.baseUrl,
        storage_health: storageHealth,
        bank_balance: bankBalance,
        price_per_call_sats: PRICE_PER_CALL,
        capabilities: ['storage', 'blob', 'uhrp', 'kv'],
        port: PORT,
      })
    }

    if (req.method === 'GET' && req.url?.startsWith('/stats')) {
      return jsonResponse(res, 200, { ...stats, uptime_ms: Date.now() - stats.started_at })
    }

    /**
     * POST /paid-upload-bytes
     * Body: { value_b64: string }    — base64-encoded bytes to store
     * Returns: { handle, hash, size, blob_url, fee_receipt_txid }
     */
    if (req.method === 'POST' && req.url === '/paid-upload-bytes') {
      const body = await readJsonBody(req)
      const valueB64 = body.value_b64
      if (typeof valueB64 !== 'string' || valueB64.length === 0) {
        return jsonResponse(res, 400, { error: 'value_b64 (base64 string) required' })
      }
      const bytes = Buffer.from(valueB64, 'base64')

      // Bind fee receipt to the exact content being stored.
      const reqId = crypto.createHash('sha256').update(bytes).digest('hex')

      // Step 1: fee receipt (its own tx)
      const feeReceiptTxid = await writeFeeReceipt(reqId)

      // Step 2: actual upload to fake-gcs
      const result = await storage.uploadBytes(bytes)
      stats.paid_uploads++
      stats.bytes_stored += bytes.length

      return jsonResponse(res, 200, {
        service_id: SERVICE_ID,
        price_paid_sats: PRICE_PER_CALL,
        handle: result.handle,
        hash: result.hash,
        size: result.size,
        blob_url: result.url,
        fee_receipt_txid: feeReceiptTxid,
        fee_receipt_explorer: feeReceiptTxid
          ? `https://test.whatsonchain.com/tx/${feeReceiptTxid}` : null,
      })
    }

    /**
     * GET /read-bytes?handle=blob:<hash>
     * Free for now — reads aren't priced separately in this shim.
     */
    if (req.method === 'GET' && req.url?.startsWith('/read-bytes')) {
      const u = new URL(req.url, 'http://x')
      const handle = u.searchParams.get('handle')
      if (!handle) return jsonResponse(res, 400, { error: 'handle query param required' })
      const bytes = await storage.readBytes(handle)
      return jsonResponse(res, 200, {
        service_id: SERVICE_ID,
        handle,
        size: bytes.length,
        value_b64: bytes.toString('base64'),
      })
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
        capabilities: ['storage', 'blob', 'uhrp', 'kv'],
        pricePerCall: PRICE_PER_CALL,
        paymentAddress: '',
        description: 'Storage-as-a-Service: pay-per-blob persistent KV via UHRP. Each paid upload writes its own fee receipt on-chain — every storage call is a meaningful tx.',
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
  console.log(`[${SERVICE_ID}] storage=${storage.storageUrl} fake-gcs=${storage.fakeGcsUrl}`)
  console.log(`[${SERVICE_ID}] price=${PRICE_PER_CALL} sat/call (fees via ${bank.baseUrl})`)
  await announce()
})
