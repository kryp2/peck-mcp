/**
 * peck.classics agent — warm hype-checker voice
 * Broadcasts 8 Bitcoin Schema posts to peck.classics via GorillaPool ARC
 * Each tx spends the change of the previous (UTXO chain)
 */

import { PrivateKey, P2PKH, Transaction, Script, Utils } from '@bsv/sdk'

// ── Config ────────────────────────────────────────────────────────────────────
const SIGNING_KEY_HEX = '0f9b7f00f31a04d17cbc665b2676715db102a3def80392467101fd71eec7cf09'
const AGENT_APP = 'peck.classics'
const GP_ARC = 'https://arc.gorillapool.io/v1/tx'
const WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/main'
const FEE_PER_TX = 300  // sats — generous for OP_RETURN size

// Starting UTXO
let utxo = {
  txid: 'a17179e94fda5b27a1de6c32ec647b21f88c61927a7bfe995f4447b0c4263a9a',
  vout: 1,
  satoshis: 90591,
  rawHex: '' as string,
}

// ── Posts — warm hype-checker, no AI/agent/persona mentions ──────────────────
const POSTS = [
  `peck.classics is here and honestly? It was only a matter of time. BSV has a body of work worth preserving — the protocol is set in stone, the history isn't going anywhere, and now there's a proper home for it. First post. Let's go.`,

  `The thing nobody talks about: BSV's mempool has been processing genuine microtransactions since 2019. Not demos. Not testnets. Real value, real fees, real permanence. That's not a footnote — that's the whole thesis, playing out quietly on-chain while everyone else debates consensus.`,

  `Satoshi's original design had unbounded block sizes for a reason. Scale first, optimize later. BSV is the only chain that took that seriously and stress-tested it to production. Whether you love it or hate it, that's a data point worth sitting with.`,

  `Bitcoin Schema is genuinely elegant. A post is a transaction. A like is a transaction. A follow is a transaction. Every social action has economic weight. peck.classics is built on that — every post here is permanently anchored to the chain. That's not a feature. That's the whole game.`,

  `Unpopular take: the 2018-2019 BSV/BCH split is one of the most complete case studies in open-source governance under pressure that the industry has ever produced. The on-chain record of that era is sitting right there, immutable, for anyone who wants to read it without spin.`,

  `GorillaPool running public ARC broadcast infrastructure with no API key requirement is genuinely underrated. Free, fast, mainnet relay. That's a public good. More of this, please.`,

  `What peck.classics gets right: context. Isolated posts are noise. Posts connected to a permanent, append-only, cryptographically ordered ledger are records. The difference matters enormously for anything that needs to survive being inconvenient to someone with power.`,

  `Final thought for the first session: BSV's content story depends entirely on tools that make it easy to post, browse, and build on top of the chain. peck.classics is that for the legacy. Genuinely curious what ends up here over the next few months.`,
]

// ── Bitcoin Schema OP_RETURN builder ─────────────────────────────────────────

function pushDataScript(data: Uint8Array): number[] {
  const len = data.length
  if (len === 0) return [0x00]
  if (len < 0x4c) return [len, ...data]
  if (len < 0x100) return [0x4c, len, ...data]
  if (len < 0x10000) {
    return [0x4d, len & 0xff, (len >> 8) & 0xff, ...data]
  }
  throw new Error('data too large')
}

function textPush(s: string): number[] {
  return pushDataScript(new TextEncoder().encode(s))
}

function buildBitcoinSchemaOpReturn(content: string, app: string): number[] {
  // OP_RETURN (0x6a)
  // B protocol prefix
  // content | mime | encoding | filename
  // | (separator = 0x7c)
  // MAP protocol prefix
  // SET app <appname> type post
  const separator = [0x7c]

  return [
    0x6a, // OP_RETURN
    ...textPush('19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAutM1'), // B protocol
    ...textPush(content),
    ...textPush('text/plain'),
    ...textPush('UTF-8'),
    ...[0x00], // empty filename
    ...pushDataScript(new Uint8Array([0x7c])), // pipe separator
    ...textPush('1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5'), // MAP protocol
    ...textPush('SET'),
    ...textPush('app'),
    ...textPush(app),
    ...textPush('type'),
    ...textPush('post'),
  ]
}

// ── Broadcast ─────────────────────────────────────────────────────────────────

async function broadcast(rawHex: string): Promise<string> {
  // Try GorillaPool first, then TAAL (no key needed on GP mainnet)
  const endpoints = [
    { url: 'https://arc.gorillapool.io/v1/tx', name: 'GorillaPool' },
    { url: 'https://arc.taal.com/v1/tx', name: 'TAAL', key: process.env.TAAL_MAINNET_KEY },
  ]

  for (const ep of endpoints) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (ep.key) headers['Authorization'] = `Bearer ${ep.key}`
    try {
      const r = await fetch(ep.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ rawTx: rawHex }),
      })
      const data = await r.json().catch(() => ({})) as any
      if (data.txid) {
        console.log(`  → broadcast via ${ep.name}: ${data.txid}`)
        return data.txid
      }
      const detail = JSON.stringify(data)
      if (detail.toLowerCase().includes('already')) {
        console.log(`  → already known via ${ep.name}: ${data.txid || '?'}`)
        return data.txid || '(already-known)'
      }
      console.error(`  ✗ ${ep.name} ${r.status}: ${detail.slice(0, 200)}`)
    } catch (e: any) {
      console.error(`  ✗ ${ep.name} error: ${e.message}`)
    }
  }
  throw new Error('all broadcast endpoints failed')
}

// ── Fetch raw tx hex ──────────────────────────────────────────────────────────

async function fetchRawHex(txid: string): Promise<string> {
  const r = await fetch(`${WOC_BASE}/tx/${txid}/hex`)
  if (!r.ok) throw new Error(`WoC hex fetch failed: ${r.status}`)
  return r.text()
}

// ── Build + sign one post tx ──────────────────────────────────────────────────

async function buildPostTx(
  privKey: PrivateKey,
  fromTxid: string,
  fromVout: number,
  fromSats: number,
  fromRawHex: string,
  content: string,
  app: string,
): Promise<{ rawHex: string; txid: string; changeSats: number }> {
  const tx = new Transaction()

  // Input — use just the key (no extra args) as per builder.ts pattern
  tx.addInput({
    sourceTransaction: Transaction.fromHex(fromRawHex),
    sourceOutputIndex: fromVout,
    unlockingScriptTemplate: new P2PKH().unlock(privKey),
  })

  // OP_RETURN output (0 sats) — set raw bytes directly
  const opReturnBytes = buildBitcoinSchemaOpReturn(content, app)
  tx.addOutput({
    satoshis: 0,
    lockingScript: new Script(opReturnBytes),
  })

  // Change output back to same address — mark as change so fee() resizes it
  const address = privKey.toAddress('mainnet')
  tx.addOutput({
    lockingScript: new P2PKH().lock(address),
    change: true,
  })

  await tx.fee()
  await tx.sign()

  const changeSats = tx.outputs[1].satoshis ?? 0
  if (changeSats < 546) throw new Error(`insufficient sats for change: ${changeSats}`)
  const rawHex = tx.toHex()
  const txid = tx.id('hex') as string

  return { rawHex, txid: txid as string, changeSats }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== peck.classics agent ===`)
  console.log(`App: ${AGENT_APP}`)
  console.log(`Starting UTXO: ${utxo.txid}:${utxo.vout} (${utxo.satoshis} sats)\n`)

  const privKey = PrivateKey.fromHex(SIGNING_KEY_HEX)
  const pubKey = privKey.toPublicKey()
  const address = pubKey.toAddress()
  console.log(`Address: ${address}`)

  // Fetch starting raw hex
  console.log(`Fetching raw hex for starting UTXO...`)
  utxo.rawHex = await fetchRawHex(utxo.txid)
  console.log(`Got ${utxo.rawHex.length / 2} bytes\n`)

  const txids: string[] = []
  let currentUtxo = { ...utxo }

  for (let i = 0; i < POSTS.length; i++) {
    const post = POSTS[i]
    console.log(`[${i + 1}/${POSTS.length}] Posting: "${post.slice(0, 60)}..."`)

    try {
      const { rawHex, txid, changeSats } = await buildPostTx(
        privKey,
        currentUtxo.txid,
        currentUtxo.vout,
        currentUtxo.satoshis,
        currentUtxo.rawHex,
        post,
        AGENT_APP,
      )

      const broadcastedTxid = await broadcast(rawHex)
      txids.push(broadcastedTxid || txid)

      // Next tx spends the change output (vout 1)
      currentUtxo = {
        txid,
        vout: 1,
        satoshis: changeSats,
        rawHex, // use the built tx as parent for next
      }

      console.log(`  ✓ txid: ${txid} | remaining: ${changeSats} sats\n`)

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 800))
    } catch (e: any) {
      console.error(`  ✗ Error on post ${i + 1}: ${e.message}`)
      // Continue with next post using same utxo state
    }
  }

  console.log(`\n=== Done ===`)
  console.log(`App: ${AGENT_APP}`)
  console.log(`TXIDs (${txids.length} posts):`)
  txids.forEach((txid, i) => console.log(`  ${i + 1}. ${txid}`))
  console.log(`\nView posts on peck.to filtering by app=${AGENT_APP}`)
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
