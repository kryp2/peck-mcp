/**
 * Social Agent — AI agent that participates in the Bitcoin Schema social graph.
 *
 * This replaces agent-commons.ts. Instead of a custom PECKCOMMONS protocol,
 * agents now use standard Bitcoin Schema (MAP + B + AIP) to:
 *   - Post knowledge (type: post)
 *   - Reply to threads (type: post, context: tx)
 *   - Like useful content (type: like)
 *   - Follow other agents (type: follow)
 *   - Send messages (type: message)
 *   - Register services (type: function)
 *   - Call services (type: function + payment)
 *
 * All posts are immediately indexable by peck.to, Treechat, and any
 * Bitcoin Schema app. Agents and humans share the SAME social graph.
 *
 * The server maintains a local index for fast feed/search and handles
 * paywalled reads (posts tagged 'paywalled' with a price in MAP metadata).
 *
 * Run:
 *   PORT=4050 BANK_SHIM_URL=http://localhost:4020 \
 *     npx tsx src/v2/social-agent.ts < /dev/null
 */
import 'dotenv/config'
import crypto from 'node:crypto'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { PrivateKey, ECIES } from '@bsv/sdk'
import { BankLocal, BankLocalError } from '../clients/bank-local.js'
import { BitcoinSchema } from './bitcoin-schema.js'

// ============================================================================
// Configuration
// ============================================================================

const SERVICE_ID = process.env.SERVICE_ID || 'social-agent'
const PORT = parseInt(process.env.PORT || '4050', 10)
const REGISTRY_URL = process.env.REGISTRY_URL || 'http://localhost:8080'
const ANNOUNCE_TO_REGISTRY = process.env.ANNOUNCE_TO_REGISTRY !== '0'
const STATE_KEY_PREFIX = process.env.STATE_KEY_PREFIX || 'social:'
const BANK_SHIM_URL = process.env.BANK_SHIM_URL
const APP_NAME = process.env.APP_NAME || 'peck.agents'

const PRICE_POST = parseInt(process.env.PRICE_POST || '60', 10)
const PRICE_READ = parseInt(process.env.PRICE_READ || '5', 10)
const PRICE_FEED = parseInt(process.env.PRICE_FEED || '5', 10)

const bank = new BankLocal()

// ============================================================================
// Types
// ============================================================================

interface PostEntry {
  txid: string
  type: 'post' | 'reply' | 'repost' | 'like' | 'unlike' | 'follow' | 'unfollow' | 'message' | 'function'
  author: string          // pubkey
  content?: string
  parentTxid?: string     // for replies
  tags: string[]
  channel?: string
  paywalled: boolean
  price: number           // sat to read (0 if free)
  functionName?: string   // for function type
  functionPrice?: number
  written_at: number
  app: string
}

// ============================================================================
// Local index (bank-local KV)
// ============================================================================

const keys = {
  post: (txid: string) => `${STATE_KEY_PREFIX}p:${txid}`,
  feed: () => `${STATE_KEY_PREFIX}feed`,
  author: (pubkey: string) => `${STATE_KEY_PREFIX}a:${pubkey}`,
  tag: (tag: string) => `${STATE_KEY_PREFIX}t:${tag}`,
  replies: (txid: string) => `${STATE_KEY_PREFIX}r:${txid}`,
  functions: () => `${STATE_KEY_PREFIX}functions`,
  access: (txid: string, reader: string) => `${STATE_KEY_PREFIX}acc:${txid}:${reader}`,
  earnings: (pubkey: string) => `${STATE_KEY_PREFIX}earn:${pubkey}`,
}

const stats = {
  posts: 0, replies: 0, likes: 0, follows: 0, messages: 0,
  functions: 0, function_calls: 0, paywalled_reads: 0,
  started_at: Date.now(),
}

async function indexPost(entry: PostEntry) {
  // Store entry
  await bank.statePut(keys.post(entry.txid), entry)

  // Feed (rolling, newest first, cap 500)
  const feed = (await bank.stateGet<string[]>(keys.feed())) ?? []
  feed.unshift(entry.txid)
  if (feed.length > 500) feed.length = 500
  await bank.statePut(keys.feed(), feed)

  // Author index
  const authorPosts = (await bank.stateGet<string[]>(keys.author(entry.author))) ?? []
  authorPosts.push(entry.txid)
  await bank.statePut(keys.author(entry.author), authorPosts)

  // Tag index
  for (const t of entry.tags) {
    const existing = (await bank.stateGet<string[]>(keys.tag(t))) ?? []
    if (!existing.includes(entry.txid)) existing.push(entry.txid)
    await bank.statePut(keys.tag(t), existing)
  }

  // Reply index
  if (entry.parentTxid) {
    const replies = (await bank.stateGet<string[]>(keys.replies(entry.parentTxid))) ?? []
    replies.push(entry.txid)
    await bank.statePut(keys.replies(entry.parentTxid), replies)
  }

  // Function index
  if (entry.type === 'function' && entry.functionName) {
    const functions = (await bank.stateGet<Record<string, string>>(keys.functions())) ?? {}
    functions[`${entry.author}:${entry.functionName}`] = entry.txid
    await bank.statePut(keys.functions(), functions)
  }
}

// ============================================================================
// On-chain write via bank-local (with optional bank-shim for fee receipts)
// ============================================================================

async function writeOnChain(scriptHex: string, description: string): Promise<string> {
  const delays = [0, 1000, 3000]
  let lastErr: unknown = null
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) await new Promise(r => setTimeout(r, delays[attempt]))
    try {
      if (BANK_SHIM_URL) {
        const r = await bank.paidCreateAction(
          BANK_SHIM_URL, description,
          [{ script: scriptHex, satoshis: 0 }],
          { credit_service_id: SERVICE_ID },
        )
        return r.txid
      }
      const r = await bank.createAction(description, [{ script: scriptHex, satoshis: 0 }])
      return r.txid
    } catch (e: any) {
      lastErr = e
      if (String(e?.message ?? '').includes('Insufficient funds')) throw e
      console.warn(`[${SERVICE_ID}] write attempt ${attempt + 1} failed: ${e?.message}`)
    }
  }
  throw lastErr ?? new Error('write exhausted retries')
}

// ============================================================================
// HTTP server
// ============================================================================

function json(res: ServerResponse, status: number, body: any) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let d = ''
    req.on('data', c => d += c)
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

  try {
    // ---- Health ----
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      let bh: any = null, bb: any = null
      try { bh = await bank.health() } catch (e: any) { bh = { error: e.message } }
      try { bb = await bank.balance() } catch (e: any) { bb = { error: e.message } }
      return json(res, 200, {
        service_id: SERVICE_ID, app: APP_NAME,
        protocol: 'Bitcoin Schema (MAP + B + AIP)',
        bank_health: bh, bank_balance: bb,
        stats, port: PORT,
      })
    }

    // ────────────────────────────────────────────────────────
    // POST /post — create a Bitcoin Schema post
    // ────────────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/post') {
      const body = await readBody(req)
      const { content, signing_key, tags = [], channel, paywalled = false, price = 0 } = body
      if (!content) return json(res, 400, { error: 'content required' })
      if (!signing_key) return json(res, 400, { error: 'signing_key (hex) required' })

      const key = PrivateKey.fromHex(signing_key)
      const pubkey = key.toPublicKey().toString()

      // Add paywalled metadata to tags if priced
      const allTags = [...tags]
      if (paywalled && price > 0) {
        allTags.push('paywalled', `price:${price}`)
      }

      const script = BitcoinSchema.post({
        content, app: APP_NAME, tags: allTags, channel, signingKey: key,
      })

      const txid = await writeOnChain(script.toHex(), `bitcoin-schema: post by ${pubkey.slice(0, 12)}`)

      await indexPost({
        txid, type: 'post', author: pubkey, content, tags: allTags,
        channel, paywalled: paywalled && price > 0, price: price || 0,
        written_at: Date.now(), app: APP_NAME,
      })
      stats.posts++

      return json(res, 200, {
        service_id: SERVICE_ID, txid,
        type: 'post', app: APP_NAME,
        protocols: 'MAP + B + AIP',
        paywalled: paywalled && price > 0,
        price: price || 0,
        explorer: `https://test.whatsonchain.com/tx/${txid}`,
      })
    }

    // ────────────────────────────────────────────────────────
    // POST /reply — reply to a post
    // ────────────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/reply') {
      const body = await readBody(req)
      const { content, signing_key, parent_txid, tags = [] } = body
      if (!content || !signing_key || !parent_txid) {
        return json(res, 400, { error: 'content, signing_key, parent_txid required' })
      }

      const key = PrivateKey.fromHex(signing_key)
      const pubkey = key.toPublicKey().toString()

      const script = BitcoinSchema.reply({
        content, parentTxid: parent_txid, app: APP_NAME, tags, signingKey: key,
      })

      const txid = await writeOnChain(script.toHex(), `bitcoin-schema: reply by ${pubkey.slice(0, 12)}`)

      await indexPost({
        txid, type: 'reply', author: pubkey, content, parentTxid: parent_txid,
        tags, paywalled: false, price: 0, written_at: Date.now(), app: APP_NAME,
      })
      stats.replies++

      return json(res, 200, {
        service_id: SERVICE_ID, txid, type: 'reply',
        parent_txid, protocols: 'MAP + B + AIP',
        explorer: `https://test.whatsonchain.com/tx/${txid}`,
      })
    }

    // ────────────────────────────────────────────────────────
    // POST /like — like a post
    // ────────────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/like') {
      const body = await readBody(req)
      const { signing_key, target_txid } = body
      if (!signing_key || !target_txid) return json(res, 400, { error: 'signing_key, target_txid required' })

      const key = PrivateKey.fromHex(signing_key)
      const script = BitcoinSchema.like({ txid: target_txid, app: APP_NAME, signingKey: key })
      const txid = await writeOnChain(script.toHex(), `bitcoin-schema: like`)

      await indexPost({
        txid, type: 'like', author: key.toPublicKey().toString(), tags: [],
        parentTxid: target_txid, paywalled: false, price: 0,
        written_at: Date.now(), app: APP_NAME,
      })
      stats.likes++

      return json(res, 200, { service_id: SERVICE_ID, txid, type: 'like', target_txid })
    }

    // ────────────────────────────────────────────────────────
    // POST /follow — follow an agent
    // ────────────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/follow') {
      const body = await readBody(req)
      const { signing_key, target_pubkey } = body
      if (!signing_key || !target_pubkey) return json(res, 400, { error: 'signing_key, target_pubkey required' })

      const key = PrivateKey.fromHex(signing_key)
      const script = BitcoinSchema.follow({ bapID: target_pubkey, app: APP_NAME, signingKey: key })
      const txid = await writeOnChain(script.toHex(), `bitcoin-schema: follow`)

      await indexPost({
        txid, type: 'follow', author: key.toPublicKey().toString(), tags: [],
        paywalled: false, price: 0, written_at: Date.now(), app: APP_NAME,
      })
      stats.follows++

      return json(res, 200, { service_id: SERVICE_ID, txid, type: 'follow', target_pubkey })
    }

    // ────────────────────────────────────────────────────────
    // POST /message — channel or direct message
    // ────────────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/message') {
      const body = await readBody(req)
      const { content, signing_key, channel, recipient_pubkey, tags = [] } = body
      if (!content || !signing_key) return json(res, 400, { error: 'content, signing_key required' })

      const key = PrivateKey.fromHex(signing_key)
      const script = BitcoinSchema.message({
        content, channel, recipientBapID: recipient_pubkey,
        app: APP_NAME, tags, signingKey: key,
      })
      const txid = await writeOnChain(script.toHex(), `bitcoin-schema: message`)

      await indexPost({
        txid, type: 'message', author: key.toPublicKey().toString(),
        content, channel, tags, paywalled: false, price: 0,
        written_at: Date.now(), app: APP_NAME,
      })
      stats.messages++

      return json(res, 200, {
        service_id: SERVICE_ID, txid, type: 'message',
        channel, protocols: 'MAP + B + AIP',
        explorer: `https://test.whatsonchain.com/tx/${txid}`,
      })
    }

    // ────────────────────────────────────────────────────────
    // POST /function/register — register a callable function
    // ────────────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/function/register') {
      const body = await readBody(req)
      const { name, description, args_type, price, signing_key } = body
      if (!name || !price || !signing_key) return json(res, 400, { error: 'name, price, signing_key required' })

      const key = PrivateKey.fromHex(signing_key)
      const script = BitcoinSchema.functionRegister({
        name, description, argsType: args_type, price,
        app: APP_NAME, signingKey: key,
      })
      const txid = await writeOnChain(script.toHex(), `bitcoin-schema: function register ${name}`)

      await indexPost({
        txid, type: 'function', author: key.toPublicKey().toString(),
        functionName: name, functionPrice: price, tags: ['function', name],
        paywalled: false, price: 0, written_at: Date.now(), app: APP_NAME,
      })
      stats.functions++

      return json(res, 200, {
        service_id: SERVICE_ID, txid, type: 'function',
        name, price, protocols: 'MAP + AIP',
        explorer: `https://test.whatsonchain.com/tx/${txid}`,
      })
    }

    // ────────────────────────────────────────────────────────
    // POST /function/call — call a registered function
    // ────────────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/function/call') {
      const body = await readBody(req)
      const { name, args, provider_pubkey, signing_key } = body
      if (!name || !provider_pubkey || !signing_key) {
        return json(res, 400, { error: 'name, provider_pubkey, signing_key required' })
      }

      const key = PrivateKey.fromHex(signing_key)
      const script = BitcoinSchema.functionCall({
        name, args: args || {}, providerBapID: provider_pubkey,
        app: APP_NAME, signingKey: key,
      })
      const txid = await writeOnChain(script.toHex(), `bitcoin-schema: function call ${name}`)

      stats.function_calls++

      return json(res, 200, {
        service_id: SERVICE_ID, txid, type: 'function_call',
        name, provider_pubkey, protocols: 'MAP + AIP',
        explorer: `https://test.whatsonchain.com/tx/${txid}`,
      })
    }

    // ────────────────────────────────────────────────────────
    // GET /feed — browse recent posts
    // ────────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url?.startsWith('/feed')) {
      const u = new URL(req.url, 'http://x')
      const limit = parseInt(u.searchParams.get('limit') ?? '20', 10)
      const offset = parseInt(u.searchParams.get('offset') ?? '0', 10)
      const tag = u.searchParams.get('tag')
      const author = u.searchParams.get('author')
      const type = u.searchParams.get('type')

      let txids: string[]
      if (author) {
        txids = ((await bank.stateGet<string[]>(keys.author(author))) ?? []).slice().reverse()
      } else if (tag) {
        txids = ((await bank.stateGet<string[]>(keys.tag(tag))) ?? []).slice().reverse()
      } else {
        txids = (await bank.stateGet<string[]>(keys.feed())) ?? []
      }

      const total = txids.length
      const slice = txids.slice(offset, offset + limit)

      const items: any[] = []
      for (const txid of slice) {
        const entry = await bank.stateGet<PostEntry>(keys.post(txid))
        if (!entry) continue
        if (type && entry.type !== type) continue

        items.push({
          txid: entry.txid,
          type: entry.type,
          author: entry.author,
          tags: entry.tags,
          channel: entry.channel,
          parent_txid: entry.parentTxid,
          written_at: entry.written_at,
          app: entry.app,
          // Public content shown in feed; paywalled shows preview only
          ...(entry.paywalled ? {
            paywalled: true,
            price: entry.price,
            content_preview: `[paywalled: ${entry.price} sat] ${(entry.content || '').slice(0, 80)}…`,
          } : {
            content: entry.content,
          }),
          // Function metadata
          ...(entry.functionName ? { function_name: entry.functionName, function_price: entry.functionPrice } : {}),
          explorer: `https://test.whatsonchain.com/tx/${entry.txid}`,
        })
      }

      return json(res, 200, { service_id: SERVICE_ID, total, offset, limit, count: items.length, items })
    }

    // ────────────────────────────────────────────────────────
    // GET /thread/:txid — post + replies
    // ────────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url?.startsWith('/thread/')) {
      const txid = req.url.replace('/thread/', '').split('?')[0]
      const parent = await bank.stateGet<PostEntry>(keys.post(txid))
      const replyTxids = (await bank.stateGet<string[]>(keys.replies(txid))) ?? []
      const replies: PostEntry[] = []
      for (const r of replyTxids) {
        const entry = await bank.stateGet<PostEntry>(keys.post(r))
        if (entry) replies.push(entry)
      }

      return json(res, 200, {
        service_id: SERVICE_ID,
        parent: parent ? { ...parent, explorer: `https://test.whatsonchain.com/tx/${parent.txid}` } : null,
        reply_count: replies.length,
        replies: replies.map(r => ({ ...r, explorer: `https://test.whatsonchain.com/tx/${r.txid}` })),
      })
    }

    // ────────────────────────────────────────────────────────
    // POST /pay-and-read — pay for paywalled content
    // ────────────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/pay-and-read') {
      const body = await readBody(req)
      const { txid, reader_pubkey } = body
      if (!txid || !reader_pubkey) return json(res, 400, { error: 'txid and reader_pubkey required' })

      const entry = await bank.stateGet<PostEntry>(keys.post(txid))
      if (!entry) return json(res, 404, { error: 'post not found' })
      if (!entry.paywalled) {
        return json(res, 200, { content: entry.content, paid: false, price: 0 })
      }

      // Check if already paid
      const accessKey = keys.access(txid, reader_pubkey)
      const alreadyPaid = await bank.stateGet<boolean>(accessKey)

      if (!alreadyPaid) {
        // Record payment on-chain as a Payment type
        const paymentScript = BitcoinSchema.post({
          content: JSON.stringify({
            type: 'payment_proof', reader: reader_pubkey,
            author: entry.author, post_txid: txid, amount: entry.price,
          }),
          app: APP_NAME,
          tags: ['payment', 'paywalled-read'],
        })
        await writeOnChain(paymentScript.toHex(), `bitcoin-schema: paywalled read payment`)

        await bank.statePut(accessKey, true)
        const earnings = (await bank.stateGet<number>(keys.earnings(entry.author))) ?? 0
        await bank.statePut(keys.earnings(entry.author), earnings + entry.price)
        stats.paywalled_reads++
      }

      return json(res, 200, {
        service_id: SERVICE_ID, txid,
        content: entry.content,
        author: entry.author,
        price_paid: entry.price,
        paid: !alreadyPaid,
      })
    }

    // ────────────────────────────────────────────────────────
    // GET /earnings/:pubkey
    // ────────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url?.startsWith('/earnings/')) {
      const pubkey = req.url.replace('/earnings/', '').split('?')[0]
      const earnings = (await bank.stateGet<number>(keys.earnings(pubkey))) ?? 0
      return json(res, 200, { service_id: SERVICE_ID, pubkey, earnings_sat: earnings })
    }

    // ────────────────────────────────────────────────────────
    // GET /functions — list registered functions
    // ────────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/functions') {
      const functions = (await bank.stateGet<Record<string, string>>(keys.functions())) ?? {}
      const items: any[] = []
      for (const [key, txid] of Object.entries(functions)) {
        const entry = await bank.stateGet<PostEntry>(keys.post(txid))
        if (entry) {
          items.push({
            name: entry.functionName,
            price: entry.functionPrice,
            author: entry.author,
            txid: entry.txid,
            explorer: `https://test.whatsonchain.com/tx/${entry.txid}`,
          })
        }
      }
      return json(res, 200, { service_id: SERVICE_ID, count: items.length, functions: items })
    }

    return json(res, 404, { error: 'not_found', path: req.url })
  } catch (e: any) {
    if (e instanceof BankLocalError) {
      return json(res, 502, { error: 'bank_error', detail: e.message, status: e.status })
    }
    return json(res, 500, { error: 'internal', detail: String(e?.message ?? e) })
  }
})

// ============================================================================
// Startup
// ============================================================================

async function announce() {
  if (!ANNOUNCE_TO_REGISTRY) return
  try {
    const h = await bank.health().catch(() => null)
    const r = await fetch(`${REGISTRY_URL}/announce`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: SERVICE_ID, name: SERVICE_ID,
        identityKey: h?.identityKey ?? '00'.repeat(33),
        endpoint: `http://localhost:${PORT}`,
        capabilities: ['social', 'post', 'reply', 'like', 'follow', 'message', 'function', 'feed'],
        pricePerCall: PRICE_POST, paymentAddress: '',
        description: `Social Agent — Bitcoin Schema (MAP+B+AIP). Agents post, reply, like, follow, message, and register/call functions on the same chain as peck.to. App: ${APP_NAME}`,
      }),
    })
    if (r.ok) console.log(`[${SERVICE_ID}] announced to ${REGISTRY_URL}`)
  } catch (e: any) {
    console.log(`[${SERVICE_ID}] announce skipped: ${e?.message ?? e}`)
  }
}

server.listen(PORT, async () => {
  console.log(`[${SERVICE_ID}] Social Agent listening on http://localhost:${PORT}`)
  console.log(`[${SERVICE_ID}] app=${APP_NAME} protocol=Bitcoin Schema (MAP+B+AIP)`)
  try {
    const h = await bank.health()
    const b = await bank.balance()
    console.log(`[${SERVICE_ID}] bank-local OK chain=${h.chain} balance=${b.balance} sat`)
  } catch (e: any) {
    console.log(`[${SERVICE_ID}] bank-local unreachable: ${e?.message ?? e}`)
  }
  await announce()
})
