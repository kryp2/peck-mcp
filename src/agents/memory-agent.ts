/**
 * Memory Agent — pay-per-write/read on-chain key/value store for AI agents.
 *
 * The pitch: AI agents need persistent memory between runs. Existing
 * solutions (Postgres, Redis, S3) require accounts, vendors, and monthly
 * subscriptions. BSV makes per-write pricing economically viable
 * (60 sat / fraction of a cent), with no account.
 *
 * Tagline: "Agent recall as a service. The first storage layer where
 * you pay only when you remember."
 *
 * BSV is the only chain where this pricing works:
 *   ETH:      $5-50 per write
 *   Solana:   tight size limit, account-rent
 *   Filecoin: bulk file storage, not k/v
 *   BSV:      60 sat per write, sub-cent, unbounded size, no account
 *
 * API surface:
 *   POST /memory-write   {namespace, key, value, tags?} → {txid, vout, handle}
 *   GET  /memory-read    ?handle=txid:vout              → {namespace, key, value}
 *   POST /memory-list    {namespace}                    → [{key, handle}]
 *   POST /memory-search-tag {tag}                       → [{namespace, key, handle}]
 *   GET  /health
 *   GET  /stats
 *
 * Storage model:
 *   - Each /memory-write builds a 1-in-2-out tx: OP_RETURN payload + change
 *     output back to the agent's wallet. Payload is JSON
 *     {ns, k, v, tags?, hash} with v inline (testnet OP_RETURN limit ~100KB,
 *     this MVP caps value at 10KB to keep fees predictable).
 *   - The change output becomes the next write's input — a sequential
 *     write-chain rooted in the agent's funding UTXO.
 *   - A local JSON index maps (namespace, key) → txid:vout so reads and
 *     listings are O(1) without scanning the chain. Reads themselves fetch
 *     the canonical bytes from WoC, so the index is a cache, not the truth.
 *
 * Funding the agent:
 *   - On first start the agent auto-generates a wallet at
 *     .peck-state/memory-agent-wallet.json
 *   - It then probes WoC for unspent outputs on its address. If none, it
 *     logs a faucet hint and refuses writes until funded.
 *   - You can fund it manually or call peck_request_faucet against the
 *     printed address.
 *
 * Run:
 *   PORT=4010 PRICE=60 npx tsx src/agents/memory-agent.ts < /dev/null
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { Transaction, P2PKH, PrivateKey, Script, OP } from '@bsv/sdk'
import { arcBroadcast, type Network } from '../ladder/arc.js'

const SERVICE_ID = process.env.SERVICE_ID || 'memory-store'
const PORT = parseInt(process.env.PORT || '4010', 10)
const PRICE_WRITE = parseInt(process.env.PRICE_WRITE || '60', 10)
const PRICE_READ = parseInt(process.env.PRICE_READ || '5', 10)
const PRICE_LIST = parseInt(process.env.PRICE_LIST || '10', 10)
const PRICE_SEARCH = parseInt(process.env.PRICE_SEARCH || '20', 10)
const NETWORK: Network = (process.env.NETWORK as Network) ?? 'test'
const REGISTRY_URL = process.env.REGISTRY_URL || 'http://localhost:8080'
const ANNOUNCE_TO_REGISTRY = process.env.ANNOUNCE_TO_REGISTRY !== '0'
const MAX_VALUE_BYTES = parseInt(process.env.MAX_VALUE_BYTES || '10240', 10)

const STATE_DIR = path.resolve('.peck-state')
const WALLET_PATH = path.join(STATE_DIR, 'memory-agent-wallet.json')
const INDEX_PATH = path.join(STATE_DIR, 'memory-agent-index.json')

const WOC_BASE = NETWORK === 'test'
  ? 'https://api.whatsonchain.com/v1/bsv/test'
  : 'https://api.whatsonchain.com/v1/bsv/main'

interface WalletFile {
  hex: string
  address: string
  network: Network
  // Cached UTXO state — the agent's current spendable output. After every
  // write we update this to point at the change output of the new tx, and
  // we cache its raw hex so we can sign without going back to WoC.
  current?: {
    txid: string
    vout: number
    satoshis: number
    rawHex: string
  }
}

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
interface IndexFile {
  byHandle: Record<string, IndexEntry>          // "txid:vout" → entry
  byNsKey: Record<string, string>               // "ns\u0000key" → handle
  byTag: Record<string, string[]>               // tag → [handle, …]
}

function loadJson<T>(p: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fallback }
}
function saveJson(p: string, v: unknown) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(v, null, 2))
}

function loadOrCreateWallet(): WalletFile {
  if (fs.existsSync(WALLET_PATH)) return JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'))
  const key = PrivateKey.fromRandom()
  const addr = key.toAddress(NETWORK === 'test' ? 'testnet' : 'mainnet')
  const w: WalletFile = { hex: key.toHex(), address: addr, network: NETWORK }
  saveJson(WALLET_PATH, w)
  return w
}

let wallet = loadOrCreateWallet()
const walletKey = PrivateKey.fromHex(wallet.hex)
let index: IndexFile = loadJson(INDEX_PATH, { byHandle: {}, byNsKey: {}, byTag: {} })

function persistWallet() { saveJson(WALLET_PATH, wallet) }
function persistIndex() { saveJson(INDEX_PATH, index) }

// ---- WoC helpers (only used at startup / read paths) -----------------------

async function wocFetchUnspent(addr: string) {
  const r = await fetch(`${WOC_BASE}/address/${addr}/unspent`)
  if (!r.ok) throw new Error(`WoC unspent: ${r.status}`)
  return await r.json() as Array<{ height: number; tx_pos: number; tx_hash: string; value: number }>
}
async function wocFetchTxHex(txid: string): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(`${WOC_BASE}/tx/${txid}/hex`)
    if (r.ok) return (await r.text()).trim()
    if (r.status === 429 || r.status >= 500) {
      await new Promise(r => setTimeout(r, 400 * (attempt + 1)))
      continue
    }
    throw new Error(`WoC tx hex ${txid}: ${r.status}`)
  }
  throw new Error(`WoC tx hex ${txid}: gave up`)
}

// ---- Tx builder -----------------------------------------------------------

function buildOpReturnScript(payload: Buffer): Script {
  const s = new Script()
  s.writeOpCode(OP.OP_FALSE)
  s.writeOpCode(OP.OP_RETURN)
  s.writeBin(Array.from(payload))
  return s
}

async function ensureCurrentUtxo(): Promise<void> {
  if (wallet.current) return
  const utxos = await wocFetchUnspent(wallet.address)
  if (utxos.length === 0) {
    throw new Error(`memory-agent wallet ${wallet.address} has no UTXOs — fund it via faucet first`)
  }
  // Pick the largest confirmed.
  const best = utxos
    .filter(u => u.height > 0)
    .sort((a, b) => b.value - a.value)[0] || utxos[0]
  const hex = await wocFetchTxHex(best.tx_hash)
  wallet.current = { txid: best.tx_hash, vout: best.tx_pos, satoshis: best.value, rawHex: hex }
  persistWallet()
}

interface WriteResult {
  txid: string
  vout: number
  handle: string
  size: number
  hash: string
  fee: number
}

async function writeOnChain(payload: Buffer): Promise<WriteResult> {
  await ensureCurrentUtxo()
  const cur = wallet.current!
  const parent = Transaction.fromHex(cur.rawHex)

  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: parent,
    sourceOutputIndex: cur.vout,
    unlockingScriptTemplate: new P2PKH().unlock(walletKey),
  })
  // OP_RETURN payload (vout 0)
  tx.addOutput({ lockingScript: buildOpReturnScript(payload), satoshis: 0 })
  // Change back to self (vout 1) — the next write's input
  tx.addOutput({ lockingScript: new P2PKH().lock(wallet.address), change: true })
  await tx.fee()
  await tx.sign()

  const txid = tx.id('hex') as string
  const rawHex = tx.toHex()
  const changeOut = tx.outputs[1]
  const changeSats = changeOut?.satoshis ?? 0
  const fee = cur.satoshis - changeSats

  const result = await arcBroadcast(rawHex, NETWORK)
  if (!result.txid && !result.alreadyKnown) {
    throw new Error(`ARC accepted but no txid (status ${result.status})`)
  }

  // Roll the wallet's current UTXO forward
  wallet.current = { txid, vout: 1, satoshis: changeSats, rawHex }
  persistWallet()

  const hash = crypto.createHash('sha256').update(payload).digest('hex')
  return { txid, vout: 0, handle: `${txid}:0`, size: payload.length, hash, fee }
}

async function readFromChain(handle: string): Promise<{ payload: Buffer; txid: string; vout: number }> {
  const m = handle.match(/^([0-9a-fA-F]{64}):(\d+)$/)
  if (!m) throw new Error('handle must be "txid:vout"')
  const [, txid, voutStr] = m
  const vout = parseInt(voutStr, 10)
  const hex = await wocFetchTxHex(txid)
  const tx = Transaction.fromHex(hex)
  const out = tx.outputs[vout]
  if (!out) throw new Error('vout out of range')
  // Strip OP_FALSE OP_RETURN prefix and return the data push.
  const ls = out.lockingScript
  // Find the first data chunk after OP_RETURN.
  const chunks: any[] = (ls as any).chunks ?? []
  const dataChunk = chunks.find((c: any) => c?.data && c.data.length > 0)
  if (!dataChunk) throw new Error('no data in OP_RETURN at this vout')
  const payload = Buffer.from(dataChunk.data)
  return { payload, txid, vout }
}

// ---- HTTP server ----------------------------------------------------------

const stats = { writes: 0, reads: 0, lists: 0, searches: 0, fees_spent: 0, started_at: Date.now() }

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
      return jsonResponse(res, 200, {
        service_id: SERVICE_ID,
        network: NETWORK,
        wallet: wallet.address,
        funded: !!wallet.current,
        current_satoshis: wallet.current?.satoshis ?? 0,
        prices: { write: PRICE_WRITE, read: PRICE_READ, list: PRICE_LIST, search: PRICE_SEARCH },
        max_value_bytes: MAX_VALUE_BYTES,
        port: PORT,
      })
    }

    if (req.method === 'GET' && req.url?.startsWith('/stats')) {
      return jsonResponse(res, 200, {
        ...stats,
        index_size: Object.keys(index.byHandle).length,
        wallet_balance: wallet.current?.satoshis ?? 0,
      })
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
      const payloadObj = { ns, k: key, v: valueStr, t: tags }
      const payload = Buffer.from(JSON.stringify(payloadObj), 'utf8')
      if (payload.length > MAX_VALUE_BYTES) {
        return jsonResponse(res, 413, { error: 'payload too large', size: payload.length, max: MAX_VALUE_BYTES })
      }

      const result = await writeOnChain(payload)
      const entry: IndexEntry = {
        namespace: ns, key, txid: result.txid, vout: result.vout,
        size: result.size, tags, hash: result.hash, written_at: Date.now(),
      }
      index.byHandle[result.handle] = entry
      // Overwrite previous handle for same (ns,key) — most-recent-wins
      index.byNsKey[`${ns}\u0000${key}`] = result.handle
      for (const t of tags) {
        if (!index.byTag[t]) index.byTag[t] = []
        if (!index.byTag[t].includes(result.handle)) index.byTag[t].push(result.handle)
      }
      persistIndex()
      stats.writes++
      stats.fees_spent += result.fee
      return jsonResponse(res, 200, {
        service_id: SERVICE_ID,
        price_paid_sats: PRICE_WRITE,
        handle: result.handle,
        txid: result.txid,
        vout: result.vout,
        size: result.size,
        hash: result.hash,
        explorer: `https://${NETWORK === 'test' ? 'test.' : ''}whatsonchain.com/tx/${result.txid}`,
      })
    }

    if (req.method === 'GET' && req.url?.startsWith('/memory-read')) {
      const u = new URL(req.url, 'http://x')
      const handle = u.searchParams.get('handle')
      if (!handle) return jsonResponse(res, 400, { error: 'handle query param required' })
      const { payload } = await readFromChain(handle)
      const obj = JSON.parse(payload.toString('utf8'))
      stats.reads++
      return jsonResponse(res, 200, {
        service_id: SERVICE_ID,
        price_paid_sats: PRICE_READ,
        handle,
        namespace: obj.ns,
        key: obj.k,
        value: obj.v,
        tags: obj.t ?? [],
      })
    }

    if (req.method === 'POST' && req.url === '/memory-list') {
      const body = await readJsonBody(req)
      const ns = String(body.namespace ?? '').trim()
      if (!ns) return jsonResponse(res, 400, { error: 'namespace required' })
      const prefix = `${ns}\u0000`
      const items = Object.entries(index.byNsKey)
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, handle]) => {
          const entry = index.byHandle[handle]
          return { key: k.slice(prefix.length), handle, size: entry?.size, tags: entry?.tags, written_at: entry?.written_at }
        })
      stats.lists++
      return jsonResponse(res, 200, { service_id: SERVICE_ID, price_paid_sats: PRICE_LIST, namespace: ns, count: items.length, items })
    }

    if (req.method === 'POST' && req.url === '/memory-search-tag') {
      const body = await readJsonBody(req)
      const tag = String(body.tag ?? '').trim()
      if (!tag) return jsonResponse(res, 400, { error: 'tag required' })
      const handles = index.byTag[tag] ?? []
      const items = handles.map(h => {
        const e = index.byHandle[h]
        return e && { namespace: e.namespace, key: e.key, handle: h, size: e.size, written_at: e.written_at }
      }).filter(Boolean)
      stats.searches++
      return jsonResponse(res, 200, { service_id: SERVICE_ID, price_paid_sats: PRICE_SEARCH, tag, count: items.length, items })
    }

    return jsonResponse(res, 404, { error: 'not_found', path: req.url })
  } catch (e: any) {
    return jsonResponse(res, 500, { error: 'internal', detail: String(e?.message ?? e) })
  }
})

async function announce() {
  if (!ANNOUNCE_TO_REGISTRY) return
  try {
    const r = await fetch(`${REGISTRY_URL}/announce`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: SERVICE_ID,
        name: SERVICE_ID,
        identityKey: '00'.repeat(33),
        endpoint: `http://localhost:${PORT}`,
        capabilities: ['memory', 'storage', 'kv', 'recall'],
        pricePerCall: PRICE_WRITE,
        paymentAddress: wallet.address,
        description: 'On-chain key/value memory for AI agents. Pay-per-write/read. The first storage layer where you pay only when you remember.',
      }),
    })
    if (r.ok) console.log(`[${SERVICE_ID}] announced to ${REGISTRY_URL}`)
    else console.log(`[${SERVICE_ID}] announce HTTP ${r.status} (registry maybe down)`)
  } catch (e: any) {
    console.log(`[${SERVICE_ID}] announce skipped: ${e?.message ?? e}`)
  }
}

server.listen(PORT, async () => {
  console.log(`[${SERVICE_ID}] listening on http://localhost:${PORT}`)
  console.log(`[${SERVICE_ID}] wallet=${wallet.address} network=${NETWORK}`)
  console.log(`[${SERVICE_ID}] prices write=${PRICE_WRITE} read=${PRICE_READ} list=${PRICE_LIST} search=${PRICE_SEARCH} sat`)
  // Try to load current UTXO eagerly so /health reports funded state
  try { await ensureCurrentUtxo(); console.log(`[${SERVICE_ID}] funded with ${wallet.current!.satoshis} sat at ${wallet.current!.txid}:${wallet.current!.vout}`) }
  catch (e: any) { console.log(`[${SERVICE_ID}] ⚠️  not funded yet: ${e?.message ?? e}`) }
  await announce()
})
