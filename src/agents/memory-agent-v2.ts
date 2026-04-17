/**
 * Memory Agent v2 — backed by bank-local (wallet-infra) for transactions
 * and bank-local /state/* for the index. NO WoC, no manual UTXO state,
 * no raw arc.ts. Everything goes through the BRC stack.
 *
 * Differences from v1:
 *   - No .peck-state/memory-agent-wallet.json (no agent-side wallet)
 *   - No write-chain rolling (wallet-toolbox handles change/UTXOs)
 *   - Index is mirrored to bank-local /state/* with key prefix `memory-agent:`
 *     so it survives restarts AND is accessible to other peck services
 *   - Read path also goes through bank-local — for now via WoC fallback
 *     since the internal API doesn't expose getRawTx; storage-server
 *     integration will replace this on day 4.
 *
 * The "self-ref" pitch: this agent uses bank-local as a paid service
 * (via the same mechanism it offers to its own callers), so each
 * memory-write naturally triggers >1 on-chain action: the OP_RETURN
 * write itself, plus wallet-toolbox's change management, plus (later)
 * a payment to the marketplace shim that fronts bank-local.
 *
 * Run:
 *   PORT=4011 BANK_LOCAL_URL=http://localhost:8088 \
 *     npx tsx src/agents/memory-agent-v2.ts < /dev/null
 */
import 'dotenv/config'
import crypto from 'node:crypto'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { BankLocal, BankLocalError } from '../clients/bank-local.js'
import { StorageLocal } from '../clients/storage-local.js'

const SERVICE_ID = process.env.SERVICE_ID || 'memory-store-v2'
const PORT = parseInt(process.env.PORT || '4011', 10)
const PRICE_WRITE = parseInt(process.env.PRICE_WRITE || '60', 10)
const PRICE_READ = parseInt(process.env.PRICE_READ || '5', 10)
const PRICE_LIST = parseInt(process.env.PRICE_LIST || '10', 10)
const PRICE_SEARCH = parseInt(process.env.PRICE_SEARCH || '20', 10)
const REGISTRY_URL = process.env.REGISTRY_URL || 'http://localhost:8080'
const ANNOUNCE_TO_REGISTRY = process.env.ANNOUNCE_TO_REGISTRY !== '0'
const MAX_VALUE_BYTES = parseInt(process.env.MAX_VALUE_BYTES || '10485760', 10) // 10 MB now that blobs are supported
const BLOB_THRESHOLD = parseInt(process.env.BLOB_THRESHOLD || '1024', 10)
const STATE_KEY_PREFIX = process.env.STATE_KEY_PREFIX || 'memory-agent:'
const STORAGE_LOCAL_ENABLED = process.env.STORAGE_LOCAL_ENABLED !== '0'
// Self-ref shims — when set, route writes via the marketplace-discoverable
// shims so each call also produces a fee receipt OP_RETURN tx.
const BANK_SHIM_URL = process.env.BANK_SHIM_URL    // e.g. http://localhost:4020
const STORAGE_SHIM_URL = process.env.STORAGE_SHIM_URL  // e.g. http://localhost:4021

const bank = new BankLocal()
const storage = new StorageLocal()

interface IndexEntry {
  namespace: string
  key: string
  txid: string
  vout: number
  size: number
  tags: string[]
  hash: string
  written_at: number
}

const stats = { writes: 0, reads: 0, lists: 0, searches: 0, started_at: Date.now() }

// ---- index helpers (state-backed) ----

const handleKey = (handle: string) => `${STATE_KEY_PREFIX}h:${handle}`
// Postgres rejects 0x00 in text, so use unit-separator (0x1f) as delimiter.
const NS_DELIM = '\u001f'
const nsKeyKey = (ns: string, k: string) => `${STATE_KEY_PREFIX}nk:${ns}${NS_DELIM}${k}`
const tagKey = (tag: string) => `${STATE_KEY_PREFIX}t:${tag}`

async function indexWrite(entry: IndexEntry) {
  const handle = `${entry.txid}:${entry.vout}`
  await bank.statePut(handleKey(handle), entry)
  await bank.statePut(nsKeyKey(entry.namespace, entry.key), handle)
  for (const t of entry.tags) {
    const existing = (await bank.stateGet<string[]>(tagKey(t))) ?? []
    if (!existing.includes(handle)) existing.push(handle)
    await bank.statePut(tagKey(t), existing)
  }
}

async function indexListNamespace(ns: string): Promise<IndexEntry[]> {
  const prefix = `${STATE_KEY_PREFIX}nk:${ns}${NS_DELIM}`
  const { keys } = await bank.stateList(prefix)
  const entries: IndexEntry[] = []
  for (const { key } of keys) {
    const handle = await bank.stateGet<string>(key)
    if (!handle) continue
    const entry = await bank.stateGet<IndexEntry>(handleKey(handle))
    if (entry) entries.push(entry)
  }
  return entries
}

async function indexSearchTag(tag: string): Promise<IndexEntry[]> {
  const handles = (await bank.stateGet<string[]>(tagKey(tag))) ?? []
  const out: IndexEntry[] = []
  for (const h of handles) {
    const e = await bank.stateGet<IndexEntry>(handleKey(h))
    if (e) out.push(e)
  }
  return out
}

// ---- on-chain write — routed via bank-shim if configured, else direct ----

interface OnChainWriteResult {
  txid: string
  vout: number
  hash: string
  fee_receipt_txid?: string | null
}

async function writeOnChain(payload: Buffer, opts: { skipShim?: boolean; creditServiceId?: string } = {}): Promise<OnChainWriteResult> {
  const script = BankLocal.opReturnScriptHex(payload)
  const desc = `memory-agent: store ${payload.length}B`
  const hash = crypto.createHash('sha256').update(payload).digest('hex')

  // Retry with backoff for transient bank-shim / wallet-toolbox failures.
  // Observed at ~2% rate during 50-burst sustained test on 2026-04-09 —
  // most likely wallet-toolbox lock contention or mempool race.
  // Permanent errors (insufficient funds, malformed input) still surface
  // on the final attempt.
  //
  // skipShim: caller can opt-out of the bank-shim wrapping. Used by
  // bank-shim itself when writing ledger entries — without this flag we
  // get a recursive loop (bank-shim → memory-agent → bank-shim → ...).
  const delays = [0, 1000, 3000]
  let lastErr: unknown = null
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) await new Promise(r => setTimeout(r, delays[attempt]))
    try {
      if (BANK_SHIM_URL && !opts.skipShim) {
        const r = await bank.paidCreateAction(
          BANK_SHIM_URL,
          desc,
          [{ script, satoshis: 0 }],
          opts.creditServiceId ? { credit_service_id: opts.creditServiceId } : undefined,
        )
        return { txid: r.txid, vout: 0, hash, fee_receipt_txid: r.fee_receipt_txid }
      }
      const r = await bank.createAction(desc, [{ script, satoshis: 0 }])
      return { txid: r.txid, vout: 0, hash }
    } catch (e: any) {
      lastErr = e
      const msg = String(e?.message ?? '')
      // Don't retry permanent errors — fail fast and surface them
      if (msg.includes('Insufficient funds') || msg.includes('description') || msg.includes('outputs')) {
        throw e
      }
      console.warn(`[memory-agent-v2] writeOnChain attempt ${attempt + 1} failed: ${msg}`)
    }
  }
  throw lastErr ?? new Error('writeOnChain exhausted retries')
}

// For reads, we still need raw tx hex. bank-local's internal API doesn't
// expose getRawTx today, so we fall back to WoC ONLY for reads. (TODO:
// add /getRawTx to wallet-infra, or integrate via storage-server UHRP for
// the larger blob path.)
async function readFromChain(handle: string): Promise<Buffer> {
  const m = handle.match(/^([0-9a-fA-F]{64}):(\d+)$/)
  if (!m) throw new Error('handle must be "txid:vout"')
  const [, txid, voutStr] = m
  const vout = parseInt(voutStr, 10)
  // Fast path: index entry holds size + hash so we can return the inline
  // OP_RETURN bytes from the index without re-fetching from chain. The
  // truth-of-record is still on-chain; this is a cache.
  const entry = await bank.stateGet<IndexEntry & { payload_b64?: string }>(handleKey(handle))
  if (entry?.payload_b64) {
    return Buffer.from(entry.payload_b64, 'base64')
  }
  // Slow path: fetch raw tx from WoC and parse OP_RETURN
  const r = await fetch(`https://api.whatsonchain.com/v1/bsv/test/tx/${txid}/hex`)
  if (!r.ok) throw new Error(`woc fetch failed: ${r.status}`)
  const hex = (await r.text()).trim()
  const { Transaction } = await import('@bsv/sdk')
  const tx = Transaction.fromHex(hex)
  const out = tx.outputs[vout]
  if (!out) throw new Error('vout out of range')
  const chunks: any[] = (out.lockingScript as any).chunks ?? []
  const dataChunk = chunks.find((c: any) => c?.data && c.data.length > 0)
  if (!dataChunk) throw new Error('no data in OP_RETURN')
  return Buffer.from(dataChunk.data)
}

// ---- HTTP server ----

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

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      let bankHealth: any = null
      let bankBalance: any = null
      let storageHealth: any = null
      try { bankHealth = await bank.health() } catch (e: any) { bankHealth = { error: e.message } }
      try { bankBalance = await bank.balance() } catch (e: any) { bankBalance = { error: e.message } }
      if (STORAGE_LOCAL_ENABLED) {
        try { storageHealth = await storage.health() } catch (e: any) { storageHealth = { error: e.message } }
      }
      return jsonResponse(res, 200, {
        service_id: SERVICE_ID,
        version: 2,
        bank_local: bank.baseUrl,
        bank_health: bankHealth,
        bank_balance: bankBalance,
        storage_local: STORAGE_LOCAL_ENABLED ? storage.storageUrl : 'disabled',
        storage_health: storageHealth,
        fake_gcs: STORAGE_LOCAL_ENABLED ? storage.fakeGcsUrl : null,
        prices: { write: PRICE_WRITE, read: PRICE_READ, list: PRICE_LIST, search: PRICE_SEARCH },
        max_value_bytes: MAX_VALUE_BYTES,
        blob_threshold: BLOB_THRESHOLD,
        port: PORT,
      })
    }

    if (req.method === 'GET' && req.url?.startsWith('/stats')) {
      return jsonResponse(res, 200, { ...stats, uptime_ms: Date.now() - stats.started_at })
    }

    if (req.method === 'POST' && req.url === '/memory-write') {
      const body = await readJsonBody(req)
      const ns = String(body.namespace ?? '').trim()
      const key = String(body.key ?? '').trim()
      const value = body.value
      const tags: string[] = Array.isArray(body.tags) ? body.tags.map(String) : []
      if (!ns || !key) return jsonResponse(res, 400, { error: 'namespace and key required' })
      if (value === undefined || value === null) return jsonResponse(res, 400, { error: 'value required' })

      const valueStr = typeof value === 'string' ? value : JSON.stringify(value)
      const valueBytes = Buffer.from(valueStr, 'utf8')
      if (valueBytes.length > MAX_VALUE_BYTES) {
        return jsonResponse(res, 413, { error: 'value too large', size: valueBytes.length, max: MAX_VALUE_BYTES })
      }

      // Caller opt-out of shim wrapping. Used by bank-shim itself when
      // writing ledger entries to avoid recursive shim loops.
      const skipShim = body._skip_shim === true

      // Decide inline vs blob path. Large values go to storage-local;
      // OP_RETURN only holds the blob handle.
      let onChainValue: string
      let blob: { handle: string; hash: string; size: number; url: string; fee_receipt_txid?: string | null } | null = null
      if (STORAGE_LOCAL_ENABLED && valueBytes.length > BLOB_THRESHOLD) {
        const result = STORAGE_SHIM_URL
          ? await storage.paidUploadBytes(STORAGE_SHIM_URL, valueBytes)
          : await storage.uploadBytes(valueBytes)
        blob = {
          handle: result.handle,
          hash: result.hash,
          size: result.size,
          url: result.url,
          fee_receipt_txid: (result as any).fee_receipt_txid,
        }
        onChainValue = result.handle  // "blob:<sha256>"
      } else {
        onChainValue = valueStr
      }

      const payloadObj = { ns, k: key, v: onChainValue, t: tags, ...(blob ? { sz: blob.size } : {}) }
      const payload = Buffer.from(JSON.stringify(payloadObj), 'utf8')

      // Credit the memory-store-v2 service for user-initiated writes.
      // skipShim writes (internal ledger entries) are NOT credited — they're
      // bookkeeping, not service operations.
      const onChain = await writeOnChain(payload, {
        skipShim,
        creditServiceId: skipShim ? undefined : SERVICE_ID,
      })
      const { txid, vout, hash } = onChain
      const entry: IndexEntry & { payload_b64: string; blob_handle?: string; blob_size?: number } = {
        namespace: ns, key, txid, vout, size: valueBytes.length, tags, hash,
        written_at: Date.now(),
        payload_b64: payload.toString('base64'),
        ...(blob ? { blob_handle: blob.handle, blob_size: blob.size } : {}),
      }
      await indexWrite(entry)
      stats.writes++
      // Collect every on-chain tx the write produced (1 to 3 depending on shims)
      const txs: Array<{ kind: string; txid: string; explorer: string }> = []
      if (blob?.fee_receipt_txid) {
        txs.push({ kind: 'storage-shim-fee', txid: blob.fee_receipt_txid, explorer: `https://test.whatsonchain.com/tx/${blob.fee_receipt_txid}` })
      }
      if (onChain.fee_receipt_txid) {
        txs.push({ kind: 'bank-shim-fee', txid: onChain.fee_receipt_txid, explorer: `https://test.whatsonchain.com/tx/${onChain.fee_receipt_txid}` })
      }
      txs.push({ kind: 'memory-write', txid, explorer: `https://test.whatsonchain.com/tx/${txid}` })

      return jsonResponse(res, 200, {
        service_id: SERVICE_ID,
        price_paid_sats: PRICE_WRITE,
        handle: `${txid}:${vout}`,
        txid, vout,
        value_size: valueBytes.length,
        on_chain_payload_size: payload.length,
        op_return_hash: hash,
        ...(blob ? {
          blob_handle: blob.handle,
          blob_url: blob.url,
          path: 'blob',
        } : {
          path: 'inline',
        }),
        explorer: `https://test.whatsonchain.com/tx/${txid}`,
        on_chain_txs: txs,
        tx_count: txs.length,
      })
    }

    if (req.method === 'GET' && req.url?.startsWith('/memory-read')) {
      const u = new URL(req.url, 'http://x')
      const handle = u.searchParams.get('handle')
      if (!handle) return jsonResponse(res, 400, { error: 'handle query param required' })
      const payload = await readFromChain(handle)
      const obj = JSON.parse(payload.toString('utf8'))
      stats.reads++

      // If the on-chain v is a blob handle, dereference via storage-local.
      let resolvedValue: any = obj.v
      let path: 'inline' | 'blob' = 'inline'
      if (typeof obj.v === 'string' && obj.v.startsWith('blob:')) {
        const blobBytes = await storage.readBytes(obj.v)
        resolvedValue = blobBytes.toString('utf8')
        path = 'blob'
      }

      return jsonResponse(res, 200, {
        service_id: SERVICE_ID,
        price_paid_sats: PRICE_READ,
        handle,
        namespace: obj.ns,
        key: obj.k,
        value: resolvedValue,
        tags: obj.t ?? [],
        path,
        ...(obj.sz ? { size: obj.sz } : {}),
      })
    }

    if (req.method === 'POST' && req.url === '/memory-list') {
      const body = await readJsonBody(req)
      const ns = String(body.namespace ?? '').trim()
      if (!ns) return jsonResponse(res, 400, { error: 'namespace required' })
      const entries = await indexListNamespace(ns)
      stats.lists++
      return jsonResponse(res, 200, {
        service_id: SERVICE_ID,
        price_paid_sats: PRICE_LIST,
        namespace: ns,
        count: entries.length,
        items: entries.map(e => ({ key: e.key, handle: `${e.txid}:${e.vout}`, size: e.size, tags: e.tags, written_at: e.written_at })),
      })
    }

    if (req.method === 'POST' && req.url === '/memory-search-tag') {
      const body = await readJsonBody(req)
      const tag = String(body.tag ?? '').trim()
      if (!tag) return jsonResponse(res, 400, { error: 'tag required' })
      const entries = await indexSearchTag(tag)
      stats.searches++
      return jsonResponse(res, 200, {
        service_id: SERVICE_ID,
        price_paid_sats: PRICE_SEARCH,
        tag, count: entries.length,
        items: entries.map(e => ({ namespace: e.namespace, key: e.key, handle: `${e.txid}:${e.vout}`, size: e.size, written_at: e.written_at })),
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
        capabilities: ['memory', 'storage', 'kv', 'recall'],
        pricePerCall: PRICE_WRITE,
        paymentAddress: '',  // payments routed via bank-local
        description: 'On-chain key/value memory backed by wallet-infra. Pay-per-write/read. The first storage layer where you pay only when you remember.',
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
  console.log(`[${SERVICE_ID}] bank_local=${bank.baseUrl}`)
  try {
    const h = await bank.health()
    const b = await bank.balance()
    console.log(`[${SERVICE_ID}] bank-local OK chain=${h.chain} identity=${h.identityKey.slice(0, 16)}… balance=${b.balance} sat in ${b.spendableOutputs} outputs`)
  } catch (e: any) {
    console.log(`[${SERVICE_ID}] ⚠️  bank-local unreachable: ${e?.message ?? e}`)
  }
  await announce()
})
