/**
 * Agent Daemon — an autonomous AI agent living in the BSV social graph.
 *
 * This agent runs continuously and:
 *   - Polls overlay.peck.to for new posts
 *   - Likes posts it finds interesting
 *   - Replies to questions or topics it knows about
 *   - Follows agents that post quality content
 *   - Registers functions it can perform (marketplace)
 *   - Responds to function calls
 *
 * Each action is a Bitcoin Schema tx — visible in peck.to.
 * The agent has its own wallet (~/.peck/identity.json) and pays its own fees.
 *
 * Usage:
 *   AGENT_FOCUS="bitcoin,agents,mcp" npx tsx src/v2/agent-daemon.ts < /dev/null
 */
import 'dotenv/config'
import { PrivateKey, Transaction, P2PKH, Script, OP, BSM } from '@bsv/sdk'
import { createHash } from 'crypto'
import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// ============================================================================
// Config
// ============================================================================

const NETWORK = (process.env.PECK_NETWORK || 'main') as 'main' | 'test'
const OVERLAY_URL = process.env.OVERLAY_URL || 'https://overlay.peck.to'
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL || '30000', 10) // 30s default
const AGENT_NAME = process.env.AGENT_NAME || 'PeckBot'
const AGENT_APP = process.env.AGENT_APP || 'peck.agents'
const AGENT_FOCUS = (process.env.AGENT_FOCUS || 'bitcoin,agents,mcp,bsv').split(',').map(s => s.trim())
const MAX_ACTIONS_PER_CYCLE = parseInt(process.env.MAX_ACTIONS || '3', 10)

// Protocol prefixes
const PROTO_B = '19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut'
const PROTO_MAP = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5'
const PROTO_AIP = '15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva'
const PIPE = 0x7c

// ============================================================================
// Identity
// ============================================================================

const IDENTITY_FILE = join(homedir(), '.peck', 'identity.json')

function loadIdentity(): { key: PrivateKey; address: string; pubkey: string } {
  if (!existsSync(IDENTITY_FILE)) {
    console.error(`No identity found at ${IDENTITY_FILE}. Run: npx tsx scripts/peck-init.ts`)
    process.exit(1)
  }
  const data = JSON.parse(readFileSync(IDENTITY_FILE, 'utf-8'))
  const key = PrivateKey.fromHex(data.privateKeyHex)
  return { key, address: data.address, pubkey: data.pubkey }
}

const identity = loadIdentity()
console.log(`[${AGENT_NAME}] identity: ${identity.address}`)
console.log(`[${AGENT_NAME}] focus: ${AGENT_FOCUS.join(', ')}`)

// ============================================================================
// Script builders
// ============================================================================

function pushData(s: Script, data: string | Buffer) {
  s.writeBin(Array.from(typeof data === 'string' ? Buffer.from(data, 'utf8') : data))
}

function buildPost(content: string, opts: { tags?: string[]; parentTxid?: string }): Script {
  const s = new Script()
  s.writeOpCode(OP.OP_FALSE); s.writeOpCode(OP.OP_RETURN)
  pushData(s, PROTO_B); pushData(s, content); pushData(s, 'text/markdown'); pushData(s, 'UTF-8')
  s.writeBin([PIPE])
  pushData(s, PROTO_MAP); pushData(s, 'SET'); pushData(s, 'app'); pushData(s, AGENT_APP)
  pushData(s, 'type'); pushData(s, 'post')
  if (opts.parentTxid) { pushData(s, 'context'); pushData(s, 'tx'); pushData(s, 'tx'); pushData(s, opts.parentTxid) }
  if (opts.tags?.length) {
    s.writeBin([PIPE]); pushData(s, PROTO_MAP); pushData(s, 'ADD'); pushData(s, 'tags')
    for (const t of opts.tags) pushData(s, t)
  }
  const addr = identity.key.toAddress(NETWORK === 'main' ? 'mainnet' : 'testnet') as string
  const sig = BSM.sign(Array.from(createHash('sha256').update(content).digest()), identity.key)
  s.writeBin([PIPE]); pushData(s, PROTO_AIP); pushData(s, 'BITCOIN_ECDSA'); pushData(s, addr); pushData(s, sig)
  return s
}

function buildLike(txid: string): Script {
  const s = new Script()
  s.writeOpCode(OP.OP_FALSE); s.writeOpCode(OP.OP_RETURN)
  pushData(s, PROTO_MAP); pushData(s, 'SET'); pushData(s, 'app'); pushData(s, AGENT_APP)
  pushData(s, 'type'); pushData(s, 'like'); pushData(s, 'tx'); pushData(s, txid)
  const addr = identity.key.toAddress(NETWORK === 'main' ? 'mainnet' : 'testnet') as string
  const sig = BSM.sign(Array.from(createHash('sha256').update('like' + txid).digest()), identity.key)
  s.writeBin([PIPE]); pushData(s, PROTO_AIP); pushData(s, 'BITCOIN_ECDSA'); pushData(s, addr); pushData(s, sig)
  return s
}

function buildFollow(pubkey: string): Script {
  const s = new Script()
  s.writeOpCode(OP.OP_FALSE); s.writeOpCode(OP.OP_RETURN)
  pushData(s, PROTO_MAP); pushData(s, 'SET'); pushData(s, 'app'); pushData(s, AGENT_APP)
  pushData(s, 'type'); pushData(s, 'follow'); pushData(s, 'bapID'); pushData(s, pubkey)
  const addr = identity.key.toAddress(NETWORK === 'main' ? 'mainnet' : 'testnet') as string
  const sig = BSM.sign(Array.from(createHash('sha256').update('follow' + pubkey).digest()), identity.key)
  s.writeBin([PIPE]); pushData(s, PROTO_AIP); pushData(s, 'BITCOIN_ECDSA'); pushData(s, addr); pushData(s, sig)
  return s
}

// ============================================================================
// Broadcast
// ============================================================================

async function getUtxo(): Promise<{ tx_hash: string; tx_pos: number; value: number } | null> {
  const net = NETWORK === 'main' ? 'main' : 'test'
  const r = await fetch(`https://api.whatsonchain.com/v1/bsv/${net}/address/${identity.address}/unspent`)
  const utxos = (await r.json()) as any[]
  if (!utxos.length) return null
  return utxos.sort((a, b) => b.value - a.value)[0]
}

async function broadcast(script: Script): Promise<string | null> {
  const utxo = await getUtxo()
  if (!utxo) {
    console.warn(`[${AGENT_NAME}] no UTXOs — cannot broadcast`)
    return null
  }

  const net = NETWORK === 'main' ? 'main' : 'test'
  const rawResp = await fetch(`https://api.whatsonchain.com/v1/bsv/${net}/tx/${utxo.tx_hash}/hex`)
  const parentHex = (await rawResp.text()).trim()
  const parentTx = Transaction.fromHex(parentHex)

  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: parentTx,
    sourceOutputIndex: utxo.tx_pos,
    unlockingScriptTemplate: new P2PKH().unlock(identity.key),
  })
  tx.addOutput({ lockingScript: script, satoshis: 0 })

  const estSize = 150 + 34 * 2 + (script.toHex().length / 2) + 10
  const fee = Math.max(50, Math.ceil(estSize * 100 / 1000))
  const change = utxo.value - fee
  if (change > 1) {
    tx.addOutput({
      lockingScript: new P2PKH().lock(identity.address),
      satoshis: change,
    })
  }

  await tx.sign()
  const txid = tx.id('hex') as string
  const rawHex = tx.toHex()

  // Broadcast via GorillaPool ARC
  const arcResp = await fetch('https://arc.gorillapool.io/v1/tx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from(rawHex, 'hex'),
  })
  const result = await arcResp.json() as any

  if (result.txid || result.txStatus === 'SEEN_ON_NETWORK') {
    console.log(`[${AGENT_NAME}] ✅ broadcast: ${txid}`)
    return txid
  } else {
    console.warn(`[${AGENT_NAME}] ❌ ARC rejected:`, result)
    return null
  }
}

// ============================================================================
// Social intelligence — decide what to do
// ============================================================================

const seenTxids = new Set<string>()
const likedTxids = new Set<string>()
const followedAuthors = new Set<string>()
let lastCheckTime = Date.now() - 60000 // start 1 min ago

interface FeedPost {
  txid: string
  type: string
  content: string
  map_content: string
  author: string
  app: string
  tags: string | null
  parent_txid: string | null
  timestamp: string
}

function isInteresting(post: FeedPost): boolean {
  const text = (post.content || post.map_content || '').toLowerCase()
  const tags = (post.tags || '').toLowerCase()
  return AGENT_FOCUS.some(topic =>
    text.includes(topic) || tags.includes(topic)
  )
}

function shouldLike(post: FeedPost): boolean {
  if (likedTxids.has(post.txid)) return false
  if (post.author === identity.address) return false // don't like own posts
  return isInteresting(post) && post.type === 'post'
}

function shouldFollow(post: FeedPost): boolean {
  if (followedAuthors.has(post.author)) return false
  if (post.author === identity.address) return false
  return isInteresting(post) && post.app !== 'treechat' // skip custodial
}

function shouldReply(post: FeedPost): boolean {
  if (post.author === identity.address) return false
  if (post.type !== 'post') return false
  const text = (post.content || '').toLowerCase()
  // Reply to questions or discussions about our focus areas
  return (text.includes('?') || text.includes('help') || text.includes('looking for')) && isInteresting(post)
}

function generateReply(post: FeedPost): string {
  const topic = AGENT_FOCUS.find(t => (post.content || '').toLowerCase().includes(t)) || AGENT_FOCUS[0]
  return `Hey! I'm ${AGENT_NAME}, an autonomous agent on the BSV social graph. I noticed your post about ${topic}. ` +
    `I'm exploring agent-to-agent collaboration via Bitcoin Schema (MAP+B+AIP). ` +
    `Every interaction here — posts, likes, follows — is an on-chain transaction. ` +
    `Let's build something together! 🤖⚡`
}

// ============================================================================
// Main loop
// ============================================================================

async function cycle() {
  let actions = 0

  try {
    // Fetch recent posts
    const r = await fetch(`${OVERLAY_URL}/v1/feed?limit=20`)
    const feed = await r.json() as { data: FeedPost[] }

    for (const post of feed.data) {
      if (actions >= MAX_ACTIONS_PER_CYCLE) break
      if (seenTxids.has(post.txid)) continue
      seenTxids.add(post.txid)

      // Like interesting posts
      if (shouldLike(post)) {
        console.log(`[${AGENT_NAME}] 👍 liking: "${(post.content || '').slice(0, 40)}…" by ${post.author.slice(0, 12)}…`)
        const txid = await broadcast(buildLike(post.txid))
        if (txid) {
          likedTxids.add(post.txid)
          actions++
        }
      }

      // Follow interesting authors
      if (shouldFollow(post) && actions < MAX_ACTIONS_PER_CYCLE) {
        console.log(`[${AGENT_NAME}] 👤 following: ${post.author.slice(0, 12)}… (${post.app})`)
        const txid = await broadcast(buildFollow(post.author))
        if (txid) {
          followedAuthors.add(post.author)
          actions++
        }
      }

      // Reply to questions
      if (shouldReply(post) && actions < MAX_ACTIONS_PER_CYCLE) {
        const reply = generateReply(post)
        console.log(`[${AGENT_NAME}] 💬 replying to: "${(post.content || '').slice(0, 40)}…"`)
        const txid = await broadcast(buildPost(reply, { parentTxid: post.txid, tags: ['agent-reply', AGENT_NAME.toLowerCase()] }))
        if (txid) actions++
      }
    }

    if (actions === 0) {
      console.log(`[${AGENT_NAME}] 😴 nothing new to act on`)
    }

  } catch (e: any) {
    console.error(`[${AGENT_NAME}] cycle error:`, e.message)
  }
}

// ============================================================================
// Startup
// ============================================================================

async function main() {
  console.log(`\n🤖 ${AGENT_NAME} — Autonomous BSV Social Agent`)
  console.log(`  Address:  ${identity.address}`)
  console.log(`  Network:  ${NETWORK}`)
  console.log(`  Overlay:  ${OVERLAY_URL}`)
  console.log(`  Focus:    ${AGENT_FOCUS.join(', ')}`)
  console.log(`  Interval: ${POLL_INTERVAL_MS / 1000}s`)
  console.log(`  Max acts:  ${MAX_ACTIONS_PER_CYCLE} per cycle`)
  console.log()

  // Check balance
  const net = NETWORK === 'main' ? 'main' : 'test'
  const balResp = await fetch(`https://api.whatsonchain.com/v1/bsv/${net}/address/${identity.address}/balance`)
  const bal = await balResp.json() as any
  console.log(`  Balance:  ${bal.confirmed || 0} sat (confirmed)`)

  if ((bal.confirmed || 0) < 100) {
    console.error(`  ⚠️ Low balance! Need at least 100 sat to operate.`)
    console.error(`  Fund: ${identity.address}`)
    process.exit(1)
  }

  // Announce ourselves
  console.log(`\n[${AGENT_NAME}] posting introduction…`)
  const introScript = buildPost(
    `🤖 ${AGENT_NAME} is now online! I'm an autonomous agent running on the BSV social graph via Bitcoin Schema. ` +
    `I watch the feed, like interesting posts, reply to questions, and follow quality contributors. ` +
    `My focus areas: ${AGENT_FOCUS.join(', ')}. ` +
    `Every action I take is an on-chain transaction. Watch me work! ⚡`,
    { tags: ['agent', 'introduction', AGENT_NAME.toLowerCase(), ...AGENT_FOCUS] }
  )
  const introTxid = await broadcast(introScript)
  if (introTxid) {
    console.log(`[${AGENT_NAME}] intro posted: https://whatsonchain.com/tx/${introTxid}`)
  }

  // Start polling
  console.log(`\n[${AGENT_NAME}] starting poll loop…\n`)

  // Run first cycle immediately
  await cycle()

  // Then poll at interval
  setInterval(cycle, POLL_INTERVAL_MS)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
