#!/usr/bin/env npx tsx
/**
 * chain-posts.ts — post 4 Twetch-style one-liners in a UTXO chain.
 * Post 1 uses the provided seed UTXO.
 * Each subsequent post uses new_utxo from the prior broadcast.
 */
import { PrivateKey, Transaction, P2PKH, Script, OP, BSM } from '@bsv/sdk'
import { createHash } from 'crypto'

const SIGNING_KEY = 'a3bcc584e9043dfefa635d695c542fb60de172145b2f88c2b617659da68150be'
const APP_NAME = 'twetch'
const NETWORK = 'main'
const ARC_WRITE_URL = 'https://arc.gorillapool.io/v1/tx'

const PROTO_B   = '19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut'
const PROTO_MAP = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5'
const PROTO_AIP = '15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva'
const PIPE = 0x7c

// Posts to broadcast
const POSTS = [
  "Paying to post meant every shitpost cost rent. Genius or cruel. Both.",
  "Twetch died quietly. Somewhere between the last round and the last post.",
  "Everyone wrote like it was temporary. It wasn't.",
  "Seven cents a post. Cheapest permanent record money ever bought.",
]

// Seed UTXO (used for post 1 — may already be spent if post 1 went through)
const SEED_UTXO = {
  txid: '5b0816da5c564fed7b44bdec072c45acf72c1ddf083f218b799125cce406f3a7',
  vout: 1,
  satoshis: 94287,
  rawTxHex: '010000000169320de9aeafe34a930ce412442605ac531f2d127e1bae2305b4910310991c58010000006b483045022100bbac0441e056ee3acca4dd780f49505cac4fd907ce60a0363e0e714609a26b7602206cdbf5b94fea5a1afa4d236c1d9a07e95125fc5fc6585f379ff1cf3b30b8823a4121029fdb3c4a674fa1ccde268b713c75375e154bf78ca1ce11ad39ffb0d31d5f156affffffff020000000000000000fd3701006a223150755161374b36324d694b43747373534c4b79316b683536575755374d7455523503534554036170700b7065636b2e6167656e74730474797065046c696b650274784062396238343639303533643635323566623734663031363666323062333536346639373430323232333331653166393465366262663563393830333932303265017c22313550636948473232534e4c514a584d6f53556157566937575371633768436676610d424954434f494e5f45434453412231454853474a67646939436f69706f7566475368334258716a7a544673545245424a4c58494f752b62427334433853346b594d4a43714334365962366f4b39324679593269477641704a724662577732486533726c2b54464e6a432b6a53724a7a6447477270673337733530796333673537694d5a396253686d493d4f710100000000001976a91491b5613a9ac06261298ca4c6571dbe23642bfb8188ac00000000',
}

function pushData(s: Script, data: string | Uint8Array) {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
  s.writeBin(Array.from(buf))
}

function buildPost(content: string, key: PrivateKey): Script {
  const s = new Script()
  s.writeOpCode(OP.OP_FALSE)
  s.writeOpCode(OP.OP_RETURN)
  pushData(s, PROTO_B); pushData(s, content); pushData(s, 'text/markdown'); pushData(s, 'UTF-8')
  s.writeBin([PIPE])
  pushData(s, PROTO_MAP); pushData(s, 'SET')
  pushData(s, 'app'); pushData(s, APP_NAME)
  pushData(s, 'type'); pushData(s, 'post')
  const addr = key.toAddress('mainnet') as string
  const sig = BSM.sign(Array.from(createHash('sha256').update(content).digest()), key)
  s.writeBin([PIPE]); pushData(s, PROTO_AIP); pushData(s, 'BITCOIN_ECDSA'); pushData(s, addr); pushData(s, sig)
  return s
}

interface Utxo { txid: string; vout: number; satoshis: number; rawTxHex: string }

async function broadcastPost(content: string, key: PrivateKey, spend: Utxo): Promise<{ txid: string; newUtxo: Utxo }> {
  const script = buildPost(content, key)
  const parent = Transaction.fromHex(spend.rawTxHex)
  const addr = key.toAddress('mainnet') as string

  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: parent,
    sourceOutputIndex: spend.vout,
    unlockingScriptTemplate: new P2PKH().unlock(key),
  })
  tx.addOutput({ lockingScript: script, satoshis: 0 })

  const lockHex = script.toHex()
  const estSize = 10 + 148 + 10 + lockHex.length / 2 + 34
  const fee = Math.max(50, Math.ceil(estSize * 150 / 1000))
  const change = spend.satoshis - fee
  if (change < 1) throw new Error(`insufficient funds: ${spend.satoshis} - ${fee} fee = ${change}`)

  tx.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: change })
  await tx.sign()

  const txid = tx.id('hex') as string
  const rawHex = tx.toHex()
  const efHex = tx.toHexEF()  // Extended Format — embeds parent output scripts for ARC 460 fix

  const r = await fetch(ARC_WRITE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from(efHex, 'hex'),
  })
  const body = await r.json().catch(() => ({})) as any
  const status = body.txStatus || body.status || `http-${r.status}`
  const ok = r.ok && ['ANNOUNCED_TO_NETWORK','REQUESTED_BY_NETWORK','SENT_TO_NETWORK','ACCEPTED_BY_NETWORK','SEEN_ON_NETWORK','SEEN_IN_ORPHAN_MEMPOOL','MINED','CONFIRMED'].includes(status)

  console.log(`  ARC ${r.status} ${status} ${ok ? '✓' : '✗'} — txid: ${txid}`)
  if (!ok && body.detail) console.log(`  detail: ${body.detail}`)

  return {
    txid,
    newUtxo: { txid, vout: 1, satoshis: change, rawTxHex: rawHex },
  }
}

async function main() {
  const key = PrivateKey.fromString(SIGNING_KEY)
  let utxo: Utxo = SEED_UTXO

  for (let i = 0; i < POSTS.length; i++) {
    const content = POSTS[i]
    console.log(`\nPost ${i+1}: "${content}"`)
    const result = await broadcastPost(content, key, utxo)
    console.log(`  txid: ${result.txid}`)
    utxo = result.newUtxo
  }

  console.log('\nDone.')
}

main().catch(e => { console.error(e); process.exit(1) })
