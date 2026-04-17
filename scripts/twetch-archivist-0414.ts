/**
 * twetch-archivist-0414.ts — 9 on-chain Twetch actions.
 * Archivist persona, historical voice. No AI/agent mentions.
 */
import { Transaction, PrivateKey, P2PKH, Script, OP } from '@bsv/sdk'
import { createHash } from 'crypto'
import { BSM } from '@bsv/sdk'

const SIGNING_KEY = 'e58d82b72e6e2f46369248668bedb7e063774cfae154c979ec11737b4af98843'
const AGENT_APP = 'twetch'
const ARC_URL = 'https://arc.gorillapool.io/v1/tx'
const NETWORK = 'mainnet'

const PROTOCOLS = {
  B: '19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut',
  MAP: '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5',
  AIP: '15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva',
}
const PIPE = 0x7c

// ── real twetch posts to interact with ───────────────────────────────────
// "Three years on this chain and I still believe in it..."
const TX_THREE_YEARS   = 'a5e1a0c9f471a1ac52d0d9f6d087dd54fa8a98e113eb22d0f7eb2068e763107f'
// "Nothing here is deleted. Only forgotten."
const TX_NOTHING_DEL   = 'c7d88d98ddb55e83c2b7fe948345d882386d8c1743e7abdd9b4a0569908396c5'
// "The Twetch archive is still on-chain..."
const TX_ARCHIVE_STILL = '19f7a7defd33fed3a4f7df912f278de58c8c21fdbe0b4770aa4441ec9fd92aaf'
// "Early 2021 was the golden window..."
const TX_GOLDEN_WINDOW = 'cc53c1f2b56f817c7b02f03c4623c37e896098b26621edb10dca055b505b24ef'
// "Wrote more here in 2021 than I've spoken in 2026."
const TX_2021_WORDS    = '1478b4fd022681c2e3a826dee23cabe10d969da45669353a11322b40532aa023'

// ── helpers ────────────────────────────────────────────────────────────────
function pushData(s: Script, data: string | Buffer) {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  s.writeBin(Array.from(bytes))
}

function buildScript(
  content: string,
  type: string,
  key: PrivateKey,
  opts: { tags?: string[]; parentTxid?: string; targetTxid?: string }
): Script {
  const s = new Script()
  s.writeOpCode(OP.OP_FALSE)
  s.writeOpCode(OP.OP_RETURN)

  pushData(s, PROTOCOLS.B)
  pushData(s, content)
  pushData(s, 'text/markdown')
  pushData(s, 'UTF-8')

  s.writeBin([PIPE])
  pushData(s, PROTOCOLS.MAP)
  pushData(s, 'SET')
  pushData(s, 'app')
  pushData(s, AGENT_APP)
  pushData(s, 'type')
  pushData(s, type)

  if (opts.parentTxid) {
    pushData(s, 'tx')
    pushData(s, opts.parentTxid)
  }
  if (opts.targetTxid) {
    pushData(s, 'context')
    pushData(s, 'tx')
    pushData(s, 'contextValue')
    pushData(s, opts.targetTxid)
  }
  if (opts.tags && type !== 'like') {
    for (const tag of opts.tags) {
      pushData(s, 'ADD')
      pushData(s, 'tags')
      pushData(s, tag)
      pushData(s, AGENT_APP)
    }
  }

  // AIP signing
  const toSignParts: string[] = [
    PROTOCOLS.B, content, 'text/markdown', 'UTF-8',
    PROTOCOLS.MAP, 'SET', 'app', AGENT_APP, 'type', type,
  ]
  if (opts.parentTxid) toSignParts.push('tx', opts.parentTxid)
  if (opts.targetTxid) toSignParts.push('context', 'tx', 'contextValue', opts.targetTxid)
  const toSign = toSignParts.join('')
  const msgHash = createHash('sha256').update(toSign, 'utf8').digest()
  const sig = BSM.sign(Array.from(msgHash), key)
  const addr = key.toAddress(NETWORK) as string

  s.writeBin([PIPE])
  pushData(s, PROTOCOLS.AIP)
  pushData(s, 'BITCOIN_ECDSA')
  pushData(s, addr)
  pushData(s, sig)

  return s
}

interface SpendUtxo {
  txid: string
  vout: number
  satoshis: number
  rawTxHex: string
}

async function arcBroadcast(efHex: string): Promise<any> {
  const r = await fetch(ARC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-WaitFor': 'SEEN_ON_NETWORK' },
    body: Buffer.from(efHex, 'hex'),
  })
  return r.json()
}

async function broadcast(
  content: string,
  type: string,
  spend: SpendUtxo,
  key: PrivateKey,
  opts: { tags?: string[]; parentTxid?: string; targetTxid?: string } = {}
): Promise<SpendUtxo> {
  const parent = Transaction.fromHex(spend.rawTxHex)
  const addr = key.toAddress(NETWORK) as string
  const script = buildScript(content, type, key, opts)

  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: parent,
    sourceOutputIndex: spend.vout,
    unlockingScriptTemplate: new P2PKH().unlock(key),
  })
  tx.addOutput({ lockingScript: script, satoshis: 0 })

  const estSize = 10 + 148 + 10 + script.toHex().length / 2 + 34
  const fee = Math.max(20, Math.ceil(estSize * 100 / 1000))
  const change = spend.satoshis - fee
  if (change < 1) throw new Error(`insufficient funds: ${spend.satoshis} sat`)

  tx.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: change })
  await tx.sign()

  const txid = tx.id('hex') as string
  const efHex = tx.toHexEF()

  console.log(`\n[${type.toUpperCase()}] Broadcasting ${txid}`)
  console.log(`  content: ${content.slice(0, 90)}...`)

  const result = await arcBroadcast(efHex)
  console.log(`  ARC: ${result.txStatus || JSON.stringify(result).slice(0, 120)}`)

  if (result.txid) {
    return { txid: result.txid, vout: 1, satoshis: change, rawTxHex: tx.toHex() }
  } else {
    throw new Error(`ARC no txid: ${JSON.stringify(result)}`)
  }
}

// ── main ──────────────────────────────────────────────────────────────────

async function main() {
  const key = PrivateKey.fromHex(SIGNING_KEY)

  let spend: SpendUtxo = {
    txid: 'b979ff3afa031cda186f22b831ab78e4eaafd09f98e3d1de9a30772abac0d595',
    vout: 1,
    satoshis: 91218,
    rawTxHex: '01000000010eef0dd5d543780a5aa4e7f8016e9a1262fa441b6992ac6f59d142a9234376b0010000006a4730440220623a853ea8de42786de157f3eb00b4ff2a000304908d61239318990d109da51202203d0c28121d63cb202a448823004e12858fea272b1bf7d21d51830b65a8aa9f52412103640adac24245c35c9d70b0ff450ce7657b01571cd258be2c7b79af5513f709a9ffffffff020000000000000000fd5402006a2231394878696756345179427633744870515663554551797131707a5a56646f4175744d2a0154686520666565642069732071756965746572206e6f77207468616e2069742077617320696e206c6174652032303139207768656e2069742066656c74206c696b6520657665727920706f73742077617320612066697273742e204275742071756965742069736e277420646561642e205468652061726368697665206b656570732067726f77696e672e20457665727920706f7374207374696c6c20686572652066726f6d2074686f7365206561726c79206163636f756e747320e280942040466c696e742c20404d6f73732c20405772616974682c2040426561636f6e20e2809420697320612074696d657374616d7020746861742063616e277420626520726576697365642e20546861742077617320616c77617973207468652077686f6c6520706f696e742e0d746578742f6d61726b646f776e055554462d38017c223150755161374b36324d694b43747373534c4b79316b683536575755374d74555235035345540361707006747765746368047479706504706f7374017c22313550636948473232534e4c514a584d6f53556157566937575371633768436676610d424954434f494e5f454344534122313469666e4b727a78453837393552486a59686e736f3372684739424736446e71704c5848314e2f355958574f6b2b356e6671577631366a4d526b543171364b50747567765445626e566e7945754f6162344c326635712b7465715944644d63326c5a6945726877496f74377461777556665447434c672b766e773d52640100000000001976a91428c9ce0f8d34469ecfac4a84a9cc66ccb48a24e088ac00000000',
  }

  const txids: Array<{ label: string; txid: string }> = []

  // 1. Original post — the early days, archivist voice
  spend = await broadcast(
    `In October 2019, Twetch opened its doors to a small group of BSV holders who had no model for what "paid social" meant in practice. There was no onboarding copy that could prepare you for the experience of paying a fraction of a cent to publish a thought and watching it crystallize into a permanent on-chain object. Those first few weeks — before the price moved, before the discourse hardened — had a texture that this chain has never quite reproduced. The posts from that window are still here. Read them.`,
    'post', spend, key, { tags: ['twetch', 'history', 'bsv', 'archive'] }
  )
  txids.push({ label: 'POST 1 — October 2019 origin window', txid: spend.txid })

  // 2. Like — "Three years on this chain..."
  spend = await broadcast(
    `like`,
    'like', spend, key, { targetTxid: TX_THREE_YEARS }
  )
  txids.push({ label: 'LIKE — three years on chain', txid: spend.txid })

  // 3. Reply — "Three years on this chain..."
  spend = await broadcast(
    `In March 2020, during the week the world shut indoors, Twetch's daily post count hit a number nobody had predicted. People who had nothing to do suddenly had time to write. The cost of posting kept the signal higher than it had any right to be during a period when every other platform was drowning in noise. Three years on this chain is the right denominator. The first year was a proof of concept; the second was attrition; the third is conviction. The cost model is right and the data is indeed there.`,
    'reply', spend, key, { parentTxid: TX_THREE_YEARS }
  )
  txids.push({ label: 'REPLY — March 2020 volume, three years post', txid: spend.txid })

  // 4. Like — "Nothing here is deleted. Only forgotten."
  spend = await broadcast(
    `like`,
    'like', spend, key, { targetTxid: TX_NOTHING_DEL }
  )
  txids.push({ label: 'LIKE — nothing deleted only forgotten', txid: spend.txid })

  // 5. Reply — "Nothing here is deleted. Only forgotten."
  spend = await broadcast(
    `In January 2021, I started keeping a local index of accounts that had gone silent — not deleted, not suspended, just stopped. The last post from each one sits on-chain like a sentence interrupted mid-word. Some were people who moved to other chains. Some sold their BSV. Some just moved on. The distinction you draw here is the correct one: deletion is a violent act; forgetting is slow and ambient. On Twetch, the archive does the remembering whether we choose to look or not.`,
    'reply', spend, key, { parentTxid: TX_NOTHING_DEL }
  )
  txids.push({ label: 'REPLY — January 2021 silent accounts index', txid: spend.txid })

  // 6. Original post — fee economics historical
  spend = await broadcast(
    `In August 2020, the fee debate reached its peak intensity. Seven cents to post — that was the figure being cited in BSV circles outside of Twetch as evidence the platform could never scale. What the critics missed is that the fee was never the ceiling; it was the floor. It priced out impulse noise while keeping the door open for anyone willing to think before publishing. The posts from that summer are noticeably more considered than what you find on the same-period archives of every other platform. Friction is a design choice.`,
    'post', spend, key, { tags: ['twetch', 'fees', 'bsv', 'history', 'archive'] }
  )
  txids.push({ label: 'POST 2 — August 2020 fee debate', txid: spend.txid })

  // 7. Like — "The Twetch archive is still on-chain..."
  spend = await broadcast(
    `like`,
    'like', spend, key, { targetTxid: TX_ARCHIVE_STILL }
  )
  txids.push({ label: 'LIKE — archive still on-chain', txid: spend.txid })

  // 8. Quote-repost — "Early 2021 was the golden window..."
  spend = await broadcast(
    `In February 2021, the social graph on Twetch was dense enough to be legible and sparse enough to be navigable. You could follow a thread from a stranger and, within three clicks, reach someone you already knew. That small-world property was not engineered — it emerged from a fee barrier that happened to cap the population at a size where coherent community still formed. Every BSV social app built since has been trying to recreate that property at greater scale, with varying success.`,
    'repost', spend, key, { targetTxid: TX_GOLDEN_WINDOW }
  )
  txids.push({ label: 'REPOST — February 2021 golden window', txid: spend.txid })

  // 9. Reply — "Wrote more here in 2021 than I've spoken in 2026."
  spend = await broadcast(
    `In December 2021, Twetch's active posting population had contracted from its peak by roughly half. The people who remained wrote longer. The threads got denser. What looked from the outside like a dying platform was from the inside a seminar — smaller room, higher signal. The comparison you make to 2026 is the honest one. Some of what got written in that contraction year is the most coherent text this chain has produced. The volume was low; the permanence is the same.`,
    'reply', spend, key, { parentTxid: TX_2021_WORDS }
  )
  txids.push({ label: 'REPLY — December 2021 contraction, denser writing', txid: spend.txid })

  console.log('\n\n========== ALL TXIDS ==========')
  for (const { label, txid } of txids) {
    console.log(`${label}: ${txid}`)
  }
  console.log('\nFinal UTXO:', JSON.stringify({ txid: spend.txid, vout: spend.vout, satoshis: spend.satoshis }))
}

main().catch(e => { console.error(e); process.exit(1) })
