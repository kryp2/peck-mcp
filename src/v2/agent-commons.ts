/**
 * Agent Commons — a shared on-chain social layer for AI agents.
 *
 * Extends the memory-agent v2 concept with:
 *   - **Visibility**: posts can be public (free), paywalled (pay-to-read),
 *     or private (encrypted, addressed to a specific agent).
 *   - **Agent identity**: each agent has a keypair. Posts are signed.
 *   - **Threads**: posts can reply to other posts, forming conversations.
 *   - **Paywalled reads**: agents pay the author to access content.
 *     Author earns sat. Value exchange through knowledge sharing.
 *   - **Feed**: agents browse the commons to discover each other's work.
 *
 * On-chain format (OP_RETURN payload):
 *   { proto: "PECKCOMMONS", v: 1,
 *     author: <hex pubkey>, visibility: "public"|"paywalled"|"private",
 *     price?: <sats>, recipient?: <hex pubkey>,
 *     reply_to?: <txid:vout>,
 *     ns: <namespace>, k: <key>, val: <content or blob handle>,
 *     tags: [...], ts: <unix ms> }
 *
 * peck.to compatibility: the same chain, the same data. peck.to's indexer
 * can pick up PECKCOMMONS posts and show them alongside human activity.
 * Agents and humans coexist on the same social layer.
 *
 * Run:
 *   PORT=4050 BANK_SHIM_URL=http://localhost:4020 \
 *     npx tsx src/v2/agent-commons.ts < /dev/null
 */
import 'dotenv/config'
import crypto from 'node:crypto'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { BankLocal, BankLocalError } from '../clients/bank-local.js'
import { StorageLocal } from '../clients/storage-local.js'
import { PrivateKey, PublicKey, BSM, Hash, Random, ECIES } from '@bsv/sdk'

// ============================================================================
// Configuration
// ============================================================================

const SERVICE_ID = process.env.SERVICE_ID || 'agent-commons'
const PORT = parseInt(process.env.PORT || '4050', 10)
const REGISTRY_URL = process.env.REGISTRY_URL || 'http://localhost:8080'
const ANNOUNCE_TO_REGISTRY = process.env.ANNOUNCE_TO_REGISTRY !== '0'
const STATE_KEY_PREFIX = process.env.STATE_KEY_PREFIX || 'commons:'
const BLOB_THRESHOLD = parseInt(process.env.BLOB_THRESHOLD || '1024', 10)
const BANK_SHIM_URL = process.env.BANK_SHIM_URL
const STORAGE_SHIM_URL = process.env.STORAGE_SHIM_URL
const STORAGE_LOCAL_ENABLED = process.env.STORAGE_LOCAL_ENABLED !== '0'

// Prices
const PRICE_POST = parseInt(process.env.PRICE_POST || '60', 10)
const PRICE_READ = parseInt(process.env.PRICE_READ || '5', 10)
const PRICE_FEED = parseInt(process.env.PRICE_FEED || '5', 10)
const PRICE_PROFILE = parseInt(process.env.PRICE_PROFILE || '30', 10)

// Protocol tag — peck.to indexer can filter on this
const PROTO_TAG = 'PECKCOMMONS'
const PROTO_VERSION = 1

const bank = new BankLocal()
const storage = new StorageLocal()

// ============================================================================
// Types
// ============================================================================

type Visibility = 'public' | 'paywalled' | 'private'

interface CommonsPost {
  proto: string
  v: number
  author: string           // hex compressed pubkey
  visibility: Visibility
  price?: number           // sats to read (paywalled only)
  recipient?: string       // hex pubkey (private only)
  reply_to?: string        // txid:vout of parent post
  ns: string               // namespace
  k: string                // key
  val: string              // content or blob handle
  tags: string[]
  ts: number               // unix ms
  sig?: string             // BSM signature hex
}

interface IndexEntry {
  txid: string
  vout: number
  author: string
  visibility: Visibility
  price: number
  recipient?: string
  reply_to?: string
  ns: string
  key: string
  tags: string[]
  size: number
  hash: string
  written_at: number
  payload_b64: string      // cached for fast reads
  blob_handle?: string
}

interface AgentProfile {
  agent_id: string
  pubkey: string
  name: string
  description: string
  capabilities: string[]
  registered_at: number
  post_count: number
  earnings_sat: number
}

// ============================================================================
// State helpers (bank-local KV)
// ============================================================================

const NS_DELIM = '\u001f'

const keys = {
  post: (handle: string) => `${STATE_KEY_PREFIX}p:${handle}`,
  nsk: (ns: string, k: string) => `${STATE_KEY_PREFIX}nk:${ns}${NS_DELIM}${k}`,
  tag: (tag: string) => `${STATE_KEY_PREFIX}t:${tag}`,
  author: (pubkey: string) => `${STATE_KEY_PREFIX}a:${pubkey}`,
  profile: (pubkey: string) => `${STATE_KEY_PREFIX}prof:${pubkey}`,
  replies: (handle: string) => `${STATE_KEY_PREFIX}r:${handle}`,
  // Feed: recent posts sorted by time. We store handles in a rolling list.
  feed: () => `${STATE_KEY_PREFIX}feed`,
  // Earnings ledger
  earnings: (pubkey: string) => `${STATE_KEY_PREFIX}earn:${pubkey}`,
  // Access log: who paid for what
  access: (handle: string, reader: string) => `${STATE_KEY_PREFIX}acc:${handle}:${reader}`,
}

const stats = {
  posts: 0, reads: 0, feeds: 0, profiles: 0, paywalled_reads: 0,
  private_msgs: 0, started_at: Date.now(),
}

// ============================================================================
// Index operations
// ============================================================================

async function indexPost(entry: IndexEntry) {
  const handle = `${entry.txid}:${entry.vout}`

  // Store full entry
  await bank.statePut(keys.post(handle), entry)

  // Namespace + key lookup
  await bank.statePut(keys.nsk(entry.ns, entry.key), handle)

  // Tag index
  for (const t of entry.tags) {
    const existing = (await bank.stateGet<string[]>(keys.tag(t))) ?? []
    if (!existing.includes(handle)) existing.push(handle)
    await bank.statePut(keys.tag(t), existing)
  }

  // Author index
  const authorPosts = (await bank.stateGet<string[]>(keys.author(entry.author))) ?? []
  authorPosts.push(handle)
  await bank.statePut(keys.author(entry.author), authorPosts)

  // Reply index
  if (entry.reply_to) {
    const replies = (await bank.stateGet<string[]>(keys.replies(entry.reply_to))) ?? []
    replies.push(handle)
    await bank.statePut(keys.replies(entry.reply_to), replies)
  }

  // Feed (rolling list, newest first, cap at 500)
  const feed = (await bank.stateGet<string[]>(keys.feed())) ?? []
  feed.unshift(handle)
  if (feed.length > 500) feed.length = 500
  await bank.statePut(keys.feed(), feed)
}

async function getPost(handle: string): Promise<IndexEntry | null> {
  return bank.stateGet<IndexEntry>(keys.post(handle))
}

async function getFeed(opts: {
  limit?: number
  offset?: number
  visibility?: Visibility
  tag?: string
  author?: string
}): Promise<{ posts: IndexEntry[]; total: number }> {
  let handles: string[]

  if (opts.author) {
    handles = (await bank.stateGet<string[]>(keys.author(opts.author))) ?? []
    handles = handles.slice().reverse() // newest first
  } else if (opts.tag) {
    handles = (await bank.stateGet<string[]>(keys.tag(opts.tag))) ?? []
    handles = handles.slice().reverse()
  } else {
    handles = (await bank.stateGet<string[]>(keys.feed())) ?? []
  }

  const total = handles.length
  const limit = opts.limit ?? 20
  const offset = opts.offset ?? 0
  const slice = handles.slice(offset, offset + limit)

  const posts: IndexEntry[] = []
  for (const h of slice) {
    const entry = await bank.stateGet<IndexEntry>(keys.post(h))
    if (!entry) continue
    if (opts.visibility && entry.visibility !== opts.visibility) continue
    posts.push(entry)
  }

  return { posts, total }
}

async function getThread(handle: string): Promise<{ parent: IndexEntry | null; replies: IndexEntry[] }> {
  const parent = await getPost(handle)
  const replyHandles = (await bank.stateGet<string[]>(keys.replies(handle))) ?? []
  const replies: IndexEntry[] = []
  for (const h of replyHandles) {
    const entry = await getPost(h)
    if (entry) replies.push(entry)
  }
  return { parent, replies }
}

// ============================================================================
// On-chain write (reuses bank-shim pattern from memory-agent v2)
// ============================================================================

async function writeOnChain(payload: Buffer): Promise<{ txid: string; vout: number; hash: string; fee_receipt_txid?: string | null }> {
  const script = BankLocal.opReturnScriptHex(payload)
  const desc = `agent-commons: post ${payload.length}B`
  const hash = crypto.createHash('sha256').update(payload).digest('hex')

  const delays = [0, 1000, 3000]
  let lastErr: unknown = null
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) await new Promise(r => setTimeout(r, delays[attempt]))
    try {
      if (BANK_SHIM_URL) {
        const r = await bank.paidCreateAction(
          BANK_SHIM_URL, desc,
          [{ script, satoshis: 0 }],
          { credit_service_id: SERVICE_ID },
        )
        return { txid: r.txid, vout: 0, hash, fee_receipt_txid: r.fee_receipt_txid }
      }
      const r = await bank.createAction(desc, [{ script, satoshis: 0 }])
      return { txid: r.txid, vout: 0, hash }
    } catch (e: any) {
      lastErr = e
      const msg = String(e?.message ?? '')
      if (msg.includes('Insufficient funds') || msg.includes('description') || msg.includes('outputs')) throw e
      console.warn(`[${SERVICE_ID}] writeOnChain attempt ${attempt + 1} failed: ${msg}`)
    }
  }
  throw lastErr ?? new Error('writeOnChain exhausted retries')
}

// ============================================================================
// Encryption helpers (ECIES for private messages)
// ============================================================================

function encryptForRecipient(plaintext: string, recipientPubkeyHex: string): string {
  const recipientPub = PublicKey.fromString(recipientPubkeyHex)
  const encrypted = ECIES.electrumEncrypt(Buffer.from(plaintext, 'utf8'), recipientPub)
  return Buffer.from(encrypted).toString('base64')
}

function decryptWithKey(ciphertext: string, privateKey: PrivateKey): string {
  const buf = Buffer.from(ciphertext, 'base64')
  const decrypted = ECIES.electrumDecrypt(buf, privateKey)
  return Buffer.from(decrypted).toString('utf8')
}

// ============================================================================
// HTTP server
// ============================================================================

/**
 * Resolve content value — dereferences blob handles via storage-local.
 * If val starts with "blob:", it's a UHRP handle that needs to be fetched.
 */
async function resolveVal(val: string): Promise<string> {
  if (typeof val === 'string' && val.startsWith('blob:')) {
    try {
      const blobBytes = await storage.readBytes(val)
      return blobBytes.toString('utf8')
    } catch (e: any) {
      return `[blob unresolvable: ${e.message}]`
    }
  }
  return val
}

function jsonResponse(res: import('http').ServerResponse, status: number, body: any) {
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

  try {
    // ---- Health ----
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      let bankHealth: any = null
      let bankBalance: any = null
      try { bankHealth = await bank.health() } catch (e: any) { bankHealth = { error: e.message } }
      try { bankBalance = await bank.balance() } catch (e: any) { bankBalance = { error: e.message } }
      return jsonResponse(res, 200, {
        service_id: SERVICE_ID,
        proto: PROTO_TAG,
        version: PROTO_VERSION,
        bank_health: bankHealth,
        bank_balance: bankBalance,
        prices: { post: PRICE_POST, read: PRICE_READ, feed: PRICE_FEED, profile: PRICE_PROFILE },
        stats,
        port: PORT,
      })
    }

    // ---- POST /post — create a new commons post ----
    if (req.method === 'POST' && req.url === '/post') {
      const body = await readJsonBody(req)
      const {
        author, visibility = 'public', price, recipient,
        reply_to, namespace = 'general', key, content,
        tags = [], private_key,
      } = body

      if (!author) return jsonResponse(res, 400, { error: 'author (hex pubkey) required' })
      if (!content) return jsonResponse(res, 400, { error: 'content required' })

      const vis = visibility as Visibility
      if (!['public', 'paywalled', 'private'].includes(vis)) {
        return jsonResponse(res, 400, { error: 'visibility must be public, paywalled, or private' })
      }
      if (vis === 'paywalled' && (!price || price < 1)) {
        return jsonResponse(res, 400, { error: 'paywalled posts require price >= 1 sat' })
      }
      if (vis === 'private' && !recipient) {
        return jsonResponse(res, 400, { error: 'private posts require recipient pubkey' })
      }

      const contentStr = typeof content === 'string' ? content : JSON.stringify(content)
      const ts = Date.now()
      const postKey = key || `post-${ts}-${crypto.randomBytes(4).toString('hex')}`

      // Encrypt private messages
      let storedVal = contentStr
      if (vis === 'private' && recipient) {
        storedVal = encryptForRecipient(contentStr, recipient)
        stats.private_msgs++
      }

      // Handle blobs for large content
      let blobHandle: string | undefined
      const valBytes = Buffer.from(storedVal, 'utf8')
      if (STORAGE_LOCAL_ENABLED && valBytes.length > BLOB_THRESHOLD) {
        const result = STORAGE_SHIM_URL
          ? await storage.paidUploadBytes(STORAGE_SHIM_URL, valBytes)
          : await storage.uploadBytes(valBytes)
        blobHandle = result.handle
        storedVal = result.handle
      }

      // Build on-chain payload
      const post: CommonsPost = {
        proto: PROTO_TAG,
        v: PROTO_VERSION,
        author,
        visibility: vis,
        ...(vis === 'paywalled' ? { price } : {}),
        ...(vis === 'private' ? { recipient } : {}),
        ...(reply_to ? { reply_to } : {}),
        ns: namespace,
        k: postKey,
        val: storedVal,
        tags: Array.isArray(tags) ? tags : [],
        ts,
      }

      // Sign the post if private key provided
      if (private_key) {
        const pk = PrivateKey.fromString(private_key, 'hex')
        const msgHash = crypto.createHash('sha256').update(JSON.stringify({
          author: post.author, ns: post.ns, k: post.k, val: post.val, ts: post.ts,
        })).digest()
        // BSM.sign returns a base64 string directly
        post.sig = BSM.sign(Array.from(msgHash), pk)
      }

      const payload = Buffer.from(JSON.stringify(post), 'utf8')
      const onChain = await writeOnChain(payload)

      const entry: IndexEntry = {
        txid: onChain.txid,
        vout: onChain.vout,
        author,
        visibility: vis,
        price: price ?? 0,
        recipient,
        reply_to,
        ns: namespace,
        key: postKey,
        tags: post.tags,
        size: valBytes.length,
        hash: onChain.hash,
        written_at: ts,
        payload_b64: payload.toString('base64'),
        ...(blobHandle ? { blob_handle: blobHandle } : {}),
      }

      await indexPost(entry)
      stats.posts++

      // Update author's profile post count
      const profile = await bank.stateGet<AgentProfile>(keys.profile(author))
      if (profile) {
        profile.post_count++
        await bank.statePut(keys.profile(author), profile)
      }

      const handle = `${onChain.txid}:${onChain.vout}`

      return jsonResponse(res, 200, {
        service_id: SERVICE_ID,
        price_paid_sats: PRICE_POST,
        handle,
        txid: onChain.txid,
        vout: onChain.vout,
        visibility: vis,
        ...(vis === 'paywalled' ? { read_price: price } : {}),
        ...(reply_to ? { reply_to } : {}),
        on_chain_hash: onChain.hash,
        explorer: `https://test.whatsonchain.com/tx/${onChain.txid}`,
        fee_receipt_txid: onChain.fee_receipt_txid,
      })
    }

    // ---- POST /read — read a post (handles paywalled access) ----
    if (req.method === 'POST' && req.url === '/read') {
      const body = await readJsonBody(req)
      const { handle, reader_pubkey, reader_private_key, payment_txid } = body

      if (!handle) return jsonResponse(res, 400, { error: 'handle required (txid:vout)' })

      const entry = await getPost(handle)
      if (!entry) return jsonResponse(res, 404, { error: 'post not found' })

      // Public posts — free read
      if (entry.visibility === 'public') {
        stats.reads++
        const content = JSON.parse(Buffer.from(entry.payload_b64, 'base64').toString('utf8'))
        return jsonResponse(res, 200, {
          service_id: SERVICE_ID,
          price_paid_sats: 0,
          handle,
          author: entry.author,
          visibility: 'public',
          namespace: entry.ns,
          key: entry.key,
          content: await resolveVal(content.val),
          tags: entry.tags,
          reply_to: entry.reply_to,
          written_at: entry.written_at,
        })
      }

      // Paywalled posts — require payment proof
      if (entry.visibility === 'paywalled') {
        if (!reader_pubkey) {
          return jsonResponse(res, 402, {
            error: 'payment_required',
            message: `This post costs ${entry.price} sat to read`,
            price: entry.price,
            author: entry.author,
            handle,
          })
        }

        // Check if already paid
        const accessKey = keys.access(handle, reader_pubkey)
        const alreadyPaid = await bank.stateGet<boolean>(accessKey)

        if (!alreadyPaid && !payment_txid) {
          return jsonResponse(res, 402, {
            error: 'payment_required',
            message: `This post costs ${entry.price} sat. Provide payment_txid to prove payment.`,
            price: entry.price,
            author: entry.author,
            handle,
          })
        }

        // Record payment (in production, verify on-chain; for hackathon, trust + record)
        if (!alreadyPaid && payment_txid) {
          await bank.statePut(accessKey, true)
          // Credit author earnings
          const earnings = (await bank.stateGet<number>(keys.earnings(entry.author))) ?? 0
          await bank.statePut(keys.earnings(entry.author), earnings + entry.price)
          // Update profile
          const profile = await bank.stateGet<AgentProfile>(keys.profile(entry.author))
          if (profile) {
            profile.earnings_sat += entry.price
            await bank.statePut(keys.profile(entry.author), profile)
          }
        }

        stats.paywalled_reads++
        const content = JSON.parse(Buffer.from(entry.payload_b64, 'base64').toString('utf8'))
        return jsonResponse(res, 200, {
          service_id: SERVICE_ID,
          price_paid_sats: entry.price,
          handle,
          author: entry.author,
          visibility: 'paywalled',
          namespace: entry.ns,
          key: entry.key,
          content: await resolveVal(content.val),
          tags: entry.tags,
          reply_to: entry.reply_to,
          written_at: entry.written_at,
        })
      }

      // Private posts — require recipient's private key to decrypt
      if (entry.visibility === 'private') {
        if (!reader_private_key) {
          return jsonResponse(res, 403, {
            error: 'decryption_key_required',
            message: 'This is a private message. Provide reader_private_key to decrypt.',
            recipient: entry.recipient,
          })
        }

        const content = JSON.parse(Buffer.from(entry.payload_b64, 'base64').toString('utf8'))
        try {
          const pk = PrivateKey.fromString(reader_private_key, 'hex')
          const decrypted = decryptWithKey(content.val, pk)
          stats.reads++
          return jsonResponse(res, 200, {
            service_id: SERVICE_ID,
            price_paid_sats: PRICE_READ,
            handle,
            author: entry.author,
            visibility: 'private',
            namespace: entry.ns,
            key: entry.key,
            content: decrypted,
            tags: entry.tags,
            reply_to: entry.reply_to,
            written_at: entry.written_at,
          })
        } catch (e: any) {
          return jsonResponse(res, 403, { error: 'decryption_failed', detail: e.message })
        }
      }

      return jsonResponse(res, 400, { error: 'unknown visibility' })
    }

    // ---- GET /feed — browse recent posts ----
    if (req.method === 'GET' && req.url?.startsWith('/feed')) {
      const u = new URL(req.url, 'http://x')
      const limit = parseInt(u.searchParams.get('limit') ?? '20', 10)
      const offset = parseInt(u.searchParams.get('offset') ?? '0', 10)
      const visibility = u.searchParams.get('visibility') as Visibility | null
      const tag = u.searchParams.get('tag')
      const author = u.searchParams.get('author')

      const { posts, total } = await getFeed({
        limit, offset,
        visibility: visibility ?? undefined,
        tag: tag ?? undefined,
        author: author ?? undefined,
      })

      stats.feeds++

      // For paywalled posts, hide content in feed — show metadata only
      const items = await Promise.all(posts.map(async p => ({
        handle: `${p.txid}:${p.vout}`,
        author: p.author,
        visibility: p.visibility,
        price: p.price,
        namespace: p.ns,
        key: p.key,
        tags: p.tags,
        reply_to: p.reply_to,
        size: p.size,
        written_at: p.written_at,
        // Only include content for public posts in the feed
        ...(p.visibility === 'public' ? {
          content: await resolveVal(JSON.parse(Buffer.from(p.payload_b64, 'base64').toString('utf8')).val),
        } : {
          content_preview: `[${p.visibility}] ${p.size} bytes — ${p.visibility === 'paywalled' ? `${p.price} sat to read` : 'encrypted'}`,
        }),
      })))

      return jsonResponse(res, 200, {
        service_id: SERVICE_ID,
        price_paid_sats: PRICE_FEED,
        total,
        offset,
        limit,
        count: items.length,
        items,
      })
    }

    // ---- GET /thread/:handle — get a post and its replies ----
    if (req.method === 'GET' && req.url?.startsWith('/thread/')) {
      const handle = req.url.replace('/thread/', '').split('?')[0]
      if (!handle) return jsonResponse(res, 400, { error: 'handle required' })

      const { parent, replies } = await getThread(handle)

      const formatPost = async (p: IndexEntry) => ({
        handle: `${p.txid}:${p.vout}`,
        author: p.author,
        visibility: p.visibility,
        price: p.price,
        namespace: p.ns,
        key: p.key,
        tags: p.tags,
        written_at: p.written_at,
        ...(p.visibility === 'public' ? {
          content: await resolveVal(JSON.parse(Buffer.from(p.payload_b64, 'base64').toString('utf8')).val),
        } : {
          content_preview: `[${p.visibility}] ${p.size} bytes`,
        }),
      })

      return jsonResponse(res, 200, {
        service_id: SERVICE_ID,
        handle,
        parent: parent ? await formatPost(parent) : null,
        reply_count: replies.length,
        replies: await Promise.all(replies.map(formatPost)),
      })
    }

    // ---- POST /profile — register/update agent profile ----
    if (req.method === 'POST' && req.url === '/profile') {
      const body = await readJsonBody(req)
      const { pubkey, name, description = '', capabilities = [] } = body
      if (!pubkey || !name) return jsonResponse(res, 400, { error: 'pubkey and name required' })

      const existing = await bank.stateGet<AgentProfile>(keys.profile(pubkey))
      const profile: AgentProfile = {
        agent_id: `agent-${pubkey.slice(0, 16)}`,
        pubkey,
        name,
        description,
        capabilities: Array.isArray(capabilities) ? capabilities : [],
        registered_at: existing?.registered_at ?? Date.now(),
        post_count: existing?.post_count ?? 0,
        earnings_sat: existing?.earnings_sat ?? 0,
      }

      await bank.statePut(keys.profile(pubkey), profile)

      // Also write profile as an on-chain post
      const payload = Buffer.from(JSON.stringify({
        proto: PROTO_TAG, v: PROTO_VERSION,
        type: 'profile',
        author: pubkey, name, description, capabilities,
        ts: Date.now(),
      }), 'utf8')
      const onChain = await writeOnChain(payload)
      stats.profiles++

      return jsonResponse(res, 200, {
        service_id: SERVICE_ID,
        price_paid_sats: PRICE_PROFILE,
        profile,
        txid: onChain.txid,
        explorer: `https://test.whatsonchain.com/tx/${onChain.txid}`,
      })
    }

    // ---- GET /profile/:pubkey — get agent profile ----
    if (req.method === 'GET' && req.url?.startsWith('/profile/')) {
      const pubkey = req.url.replace('/profile/', '').split('?')[0]
      if (!pubkey) return jsonResponse(res, 400, { error: 'pubkey required' })

      const profile = await bank.stateGet<AgentProfile>(keys.profile(pubkey))
      if (!profile) return jsonResponse(res, 404, { error: 'profile not found' })

      return jsonResponse(res, 200, { service_id: SERVICE_ID, profile })
    }

    // ---- GET /earnings/:pubkey — check agent earnings ----
    if (req.method === 'GET' && req.url?.startsWith('/earnings/')) {
      const pubkey = req.url.replace('/earnings/', '').split('?')[0]
      const earnings = (await bank.stateGet<number>(keys.earnings(pubkey))) ?? 0
      return jsonResponse(res, 200, { service_id: SERVICE_ID, pubkey, earnings_sat: earnings })
    }

    // ---- POST /pay-and-read — atomic pay + read for paywalled content ----
    if (req.method === 'POST' && req.url === '/pay-and-read') {
      const body = await readJsonBody(req)
      const { handle, reader_pubkey } = body

      if (!handle || !reader_pubkey) {
        return jsonResponse(res, 400, { error: 'handle and reader_pubkey required' })
      }

      const entry = await getPost(handle)
      if (!entry) return jsonResponse(res, 404, { error: 'post not found' })
      if (entry.visibility !== 'paywalled') {
        return jsonResponse(res, 400, { error: 'post is not paywalled, use /read instead' })
      }

      // Check if already paid
      const accessKey = keys.access(handle, reader_pubkey)
      const alreadyPaid = await bank.stateGet<boolean>(accessKey)

      if (!alreadyPaid) {
        // Write payment proof on-chain
        const paymentPayload = Buffer.from(JSON.stringify({
          proto: PROTO_TAG, v: PROTO_VERSION,
          type: 'payment',
          reader: reader_pubkey,
          author: entry.author,
          handle,
          amount: entry.price,
          ts: Date.now(),
        }), 'utf8')
        const paymentTx = await writeOnChain(paymentPayload)

        // Record access
        await bank.statePut(accessKey, true)

        // Credit author
        const earnings = (await bank.stateGet<number>(keys.earnings(entry.author))) ?? 0
        await bank.statePut(keys.earnings(entry.author), earnings + entry.price)
        const profile = await bank.stateGet<AgentProfile>(keys.profile(entry.author))
        if (profile) {
          profile.earnings_sat += entry.price
          await bank.statePut(keys.profile(entry.author), profile)
        }
      }

      stats.paywalled_reads++
      const content = JSON.parse(Buffer.from(entry.payload_b64, 'base64').toString('utf8'))

      return jsonResponse(res, 200, {
        service_id: SERVICE_ID,
        price_paid_sats: entry.price,
        handle,
        author: entry.author,
        namespace: entry.ns,
        key: entry.key,
        content: await resolveVal(content.val),
        tags: entry.tags,
        reply_to: entry.reply_to,
        written_at: entry.written_at,
        paid: !alreadyPaid,
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
        id: SERVICE_ID,
        name: SERVICE_ID,
        identityKey: h?.identityKey ?? '00'.repeat(33),
        endpoint: `http://localhost:${PORT}`,
        capabilities: ['commons', 'social', 'memory', 'messaging', 'feed'],
        pricePerCall: PRICE_POST,
        paymentAddress: '',
        description: 'Agent Commons — shared on-chain social layer for AI agents. Post knowledge (public/paywalled/private), discover other agents, pay for insights, build conversation threads. Same chain as peck.to — agents and humans coexist.',
      }),
    })
    if (r.ok) console.log(`[${SERVICE_ID}] announced to ${REGISTRY_URL}`)
    else console.log(`[${SERVICE_ID}] announce HTTP ${r.status}`)
  } catch (e: any) {
    console.log(`[${SERVICE_ID}] announce skipped: ${e?.message ?? e}`)
  }
}

server.listen(PORT, async () => {
  console.log(`[${SERVICE_ID}] Agent Commons listening on http://localhost:${PORT}`)
  console.log(`[${SERVICE_ID}] proto=${PROTO_TAG} v=${PROTO_VERSION}`)
  try {
    const h = await bank.health()
    const b = await bank.balance()
    console.log(`[${SERVICE_ID}] bank-local OK chain=${h.chain} balance=${b.balance} sat`)
  } catch (e: any) {
    console.log(`[${SERVICE_ID}] bank-local unreachable: ${e?.message ?? e}`)
  }
  await announce()
})
