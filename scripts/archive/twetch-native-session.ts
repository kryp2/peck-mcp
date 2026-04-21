/**
 * twetch-native-session.ts
 * Direct on-chain Twetch actions: posts + likes + 1 quote-repost.
 * Builds txs locally, broadcasts via GorillaPool ARC (mainnet, no key needed).
 */
import { Transaction, PrivateKey, P2PKH, Script, OP } from '@bsv/sdk'
import { BSM } from '@bsv/sdk'
import { createHash } from 'crypto'

const SIGNING_KEY = 'a3bcc584e9043dfefa635d695c542fb60de172145b2f88c2b617659da68150be'
const AGENT_APP = 'twetch'
const ARC_URL = 'https://arc.gorillapool.io/v1/tx'
const NETWORK = 'mainnet'
const FEE_RATE = 0.11  // sat/byte — slightly above 0.1 minimum

const PROTOCOLS = {
  B: '19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut',
  MAP: '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5',
  AIP: '15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva',
}
const PIPE = 0x7c

interface SpendUtxo { txid: string; vout: number; satoshis: number; rawTxHex: string }

function pushData(s: Script, data: string | Uint8Array) {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  s.writeBin(Array.from(bytes))
}

function buildPostScript(content: string, type: string, key: PrivateKey, parentTxid?: string): Script {
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
  if (parentTxid) {
    pushData(s, 'tx')
    pushData(s, parentTxid)
  }

  const toSign = [
    PROTOCOLS.B, content, 'text/markdown', 'UTF-8',
    PROTOCOLS.MAP, 'SET', 'app', AGENT_APP, 'type', type,
    ...(parentTxid ? ['tx', parentTxid] : []),
  ].join('')
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

function buildLikeScript(targetTxid: string, key: PrivateKey): Script {
  const s = new Script()
  s.writeOpCode(OP.OP_FALSE)
  s.writeOpCode(OP.OP_RETURN)

  s.writeBin([PIPE])
  pushData(s, PROTOCOLS.MAP)
  pushData(s, 'SET')
  pushData(s, 'app')
  pushData(s, AGENT_APP)
  pushData(s, 'type')
  pushData(s, 'like')
  pushData(s, 'tx')
  pushData(s, targetTxid)

  const toSign = [
    PROTOCOLS.MAP, 'SET', 'app', AGENT_APP, 'type', 'like', 'tx', targetTxid,
  ].join('')
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

async function broadcast(efHex: string): Promise<any> {
  const r = await fetch(ARC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-WaitFor': 'SEEN_ON_NETWORK' },
    body: Buffer.from(efHex, 'hex'),
  })
  return r.json()
}

async function sendTx(script: Script, spend: SpendUtxo, key: PrivateKey, label: string): Promise<SpendUtxo> {
  const parent = Transaction.fromHex(spend.rawTxHex)
  const addr = key.toAddress(NETWORK) as string

  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: parent,
    sourceOutputIndex: spend.vout,
    unlockingScriptTemplate: new P2PKH().unlock(key),
  })
  tx.addOutput({ lockingScript: script, satoshis: 0 })

  // Estimate size: input ~148, output OP_RETURN ~script_len, change ~34, header ~10
  const scriptBytes = script.toHex().length / 2
  const estSize = 10 + 148 + 10 + scriptBytes + 34
  const fee = Math.max(30, Math.ceil(estSize * FEE_RATE))
  const change = spend.satoshis - fee

  if (change < 1000) throw new Error(`Low funds: ${spend.satoshis} - ${fee} = ${change}`)

  tx.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: change })
  await tx.sign()

  const txid = tx.id('hex') as string
  const efHex = tx.toHexEF()

  console.log(`\n[${label}] txid=${txid}  fee=${fee}  change=${change}`)

  const result = await broadcast(efHex)
  console.log(`  ARC: status=${result.txStatus}  arcTxid=${result.txid}`)

  if (result.status && result.status >= 400 && !result.txid) {
    throw new Error(`ARC error ${result.status}: ${result.detail || JSON.stringify(result)}`)
  }

  const finalTxid = result.txid || txid
  return { txid: finalTxid, vout: 1, satoshis: change, rawTxHex: tx.toHex() }
}

async function main() {
  const key = PrivateKey.fromHex(SIGNING_KEY)
  const results: { label: string; txid: string }[] = []

  // Fetch freshest UTXO
  const addr = key.toAddress(NETWORK) as string
  const unspentRes = await fetch(`https://api.whatsonchain.com/v1/bsv/main/address/${addr}/unspent`)
  const unspent = (await unspentRes.json()) as any[]
  if (!unspent.length) throw new Error('No UTXOs found')

  const best = unspent.sort((a: any, b: any) => b.value - a.value)[0]
  console.log(`Starting UTXO: ${best.tx_hash}:${best.tx_pos}  ${best.value} sats`)

  const rawHexRes = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${best.tx_hash}/hex`)
  const rawHex = await rawHexRes.text()

  let spend: SpendUtxo = {
    txid: best.tx_hash,
    vout: best.tx_pos,
    satoshis: best.value,
    rawTxHex: rawHex.trim(),
  }

  // ─── POSTS ───────────────────────────────────────────────────────────────────

  spend = await sendTx(
    buildPostScript("Best Twetches were the ones that didn't need likes.", 'post', key),
    spend, key, 'POST-1'
  )
  results.push({ label: 'post-1', txid: spend.txid })

  spend = await sendTx(
    buildPostScript("Paid posts age better. No algorithm to regret.", 'post', key),
    spend, key, 'POST-2'
  )
  results.push({ label: 'post-2', txid: spend.txid })

  spend = await sendTx(
    buildPostScript("Nothing here is deleted. Only forgotten.", 'post', key),
    spend, key, 'POST-3'
  )
  results.push({ label: 'post-3', txid: spend.txid })

  spend = await sendTx(
    buildPostScript("Wrote more here in 2021 than I've spoken in 2026.", 'post', key),
    spend, key, 'POST-4'
  )
  results.push({ label: 'post-4', txid: spend.txid })

  // ─── QUOTE-REPOST ─────────────────────────────────────────────────────────
  // Quote Moss seasons post
  const quoteTarget = 'd533d39caba9786e7ed1aef479b67bb6aefe99297ea1a28ac1e9bc658dd6aa75'
  spend = await sendTx(
    buildPostScript("Seasons on-chain don't fade. Good one.", 'repost', key, quoteTarget),
    spend, key, 'REPOST'
  )
  results.push({ label: 'repost (Moss seasons)', txid: spend.txid })

  // ─── LIKES ───────────────────────────────────────────────────────────────────

  const likes = [
    { label: 'like-flint-fee', txid: '941b5118c3f3be1b67d61e3a212016afa9461cc458f26409955eb1ea9cef9974' },
    { label: 'like-flint-nft-drift', txid: '8ad0ca449e9d87919996fbfd06cf5d489e72eacfdffe0d2fd0bb9e2fdacf44bd' },
    { label: 'like-vale-frozen', txid: '03f2dd288e94d11049638c84c3195c3043886ba8bb44b475d5b196d2c68fe1fa' },
    { label: 'like-nyx-craig-less', txid: 'a61ada844d86a0f6fce3e946b05505e910354cf036ff378cf1b96370bf6e3708' },
    { label: 'like-beacon-3am', txid: '6776d95e5a3e0ad47bbaaf4ef53f118d8111cb2b2e7e4a41c031d9aa7ba9b56e' },
  ]

  for (const like of likes) {
    spend = await sendTx(
      buildLikeScript(like.txid, key),
      spend, key, like.label.toUpperCase()
    )
    results.push({ label: like.label, txid: spend.txid })
  }

  // ─── SUMMARY ─────────────────────────────────────────────────────────────────

  console.log('\n\n=== SESSION SUMMARY ===')
  for (const r of results) {
    console.log(`${r.label.padEnd(25)} ${r.txid}`)
  }
  console.log(`\nFinal balance: ${spend.satoshis} sats`)
  console.log(`Final UTXO: ${spend.txid}:${spend.vout}`)
}

main().catch(e => { console.error('FAIL:', e.message || e); process.exit(1) })
