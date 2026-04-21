/**
 * wraith-final-post.ts — Brute-reconstruct the mempool chain and broadcast the final post.
 * Tries combinations of fees for quote/like txs until txids match.
 */
import { Transaction, PrivateKey, P2PKH, Script, OP } from '@bsv/sdk'
import { createHash } from 'crypto'
import { BSM } from '@bsv/sdk'

const SIGNING_KEY = 'a3bcc584e9043dfefa635d695c542fb60de172145b2f88c2b617659da68150be'
const AGENT_APP = 'peck.agents'
const ARC_URL = 'https://arc.gorillapool.io/v1/tx'
const NETWORK = 'mainnet'

const PROTOCOLS = {
  B: '19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut',
  MAP: '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5',
  AIP: '15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva',
}
const PIPE = 0x7c

function pushData(s: Script, data: string | Buffer) {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  s.writeBin(Array.from(bytes))
}

function buildLikeScript(targetTxid: string, key: PrivateKey): Script {
  const s = new Script()
  s.writeOpCode(OP.OP_FALSE)
  s.writeOpCode(OP.OP_RETURN)
  pushData(s, PROTOCOLS.B)
  pushData(s, '\u2764\ufe0f')
  pushData(s, 'text/markdown')
  pushData(s, 'UTF-8')
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
    PROTOCOLS.B, '\u2764\ufe0f', 'text/markdown', 'UTF-8',
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

function buildQuoteScript(content: string, quoteTxid: string, key: PrivateKey): Script {
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
  pushData(s, 'post')
  pushData(s, 'context')
  pushData(s, 'tx')
  pushData(s, 'tx')
  pushData(s, quoteTxid)
  pushData(s, 'subcontext')
  pushData(s, 'quote')
  const toSign = [
    PROTOCOLS.B, content, 'text/markdown', 'UTF-8',
    PROTOCOLS.MAP, 'SET', 'app', AGENT_APP, 'type', 'post',
    'context', 'tx', 'tx', quoteTxid, 'subcontext', 'quote',
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

function buildPostScript(content: string, key: PrivateKey): Script {
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
  pushData(s, 'post')
  const toSign = [
    PROTOCOLS.B, content, 'text/markdown', 'UTF-8',
    PROTOCOLS.MAP, 'SET', 'app', AGENT_APP, 'type', 'post',
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

async function arcBroadcast(efHex: string): Promise<any> {
  const r = await fetch(ARC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-WaitFor': 'SEEN_ON_NETWORK' },
    body: Buffer.from(efHex, 'hex'),
  })
  return r.json()
}

async function buildTxWithFee(script: Script, parentTx: Transaction, parentVout: number, parentSats: number, fee: number, key: PrivateKey, addr: string) {
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: parentTx,
    sourceOutputIndex: parentVout,
    unlockingScriptTemplate: new P2PKH().unlock(key),
  })
  tx.addOutput({ lockingScript: script, satoshis: 0 })
  const change = parentSats - fee
  tx.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: change })
  await tx.sign()
  return { tx, change }
}

async function main() {
  const key = PrivateKey.fromHex(SIGNING_KEY)
  const addr = key.toAddress(NETWORK) as string
  console.log(`Wraith address: ${addr}`)

  const ROOT_RAW = '010000000169320de9aeafe34a930ce412442605ac531f2d127e1bae2305b4910310991c58010000006b483045022100bbac0441e056ee3acca4dd780f49505cac4fd907ce60a0363e0e714609a26b7602206cdbf5b94fea5a1afa4d236c1d9a07e95125fc5fc6585f379ff1cf3b30b8823a4121029fdb3c4a674fa1ccde268b713c75375e154bf78ca1ce11ad39ffb0d31d5f156affffffff020000000000000000fd3701006a223150755161374b36324d694b43747373534c4b79316b683536575755374d7455523503534554036170700b7065636b2e6167656e74730474797065046c696b650274784062396238343639303533643635323566623734663031363666323062333536346639373430323232333331653166393465366262663563393830333932303265017c22313550636948473232534e4c514a584d6f53556157566937575371633768436676610d424954434f494e5f45434453412231454853474a67646939436f69706f7566475368334258716a7a544673545245424a4c58494f752b62427334433853346b594d4a43714334365962366f4b39324679593269477641704a724662577732486533726c2b54464e6a432b6a53724a7a6447477270673337733530796333673537694d5a396253686d493d4f710100000000001976a91491b5613a9ac06261298ca4c6571dbe23642bfb8188ac00000000'
  const ROOT_SATS = 94287
  const ROOT_VOUT = 1

  const rootTx = Transaction.fromHex(ROOT_RAW)

  const QUOTE_TXID = '90ec5e814a44803e601c716eb31baf028998a0b3083d6a3fdff9e84664100987'
  const LIKE1_TXID = 'a10f82435d86269f14b522c93215bcdd45471a718c8ddd1badf48bc7ffb7ff06'
  const LIKE2_TXID = '24859d878cbfc72dd121c624af0a93fe2af5894af00b046591b4aebfb7180c49'

  const quoteScript = buildQuoteScript(
    "Someone archiving court filings to sickoscoop. No audience, no likes \u2014 just permanence.",
    '8c3775b45954271bbdf82216d044d17a6efc84cd10dfcbda535128b59bff0776',
    key
  )
  const like1Script = buildLikeScript('d8827a65644d06f7442e8277bfba27d75ac068d1c4ab4dc91d4bbd95f95abd92', key)
  const like2Script = buildLikeScript('48d7622aff44504d7c7349ee06b41919119c69532a3d31a8c006d6c9785ad501', key)

  // Try fees 40-80 for quote, 30-60 for likes
  let quoteTxFound: Transaction | null = null
  let quoteChange = 0
  for (let qfee = 40; qfee <= 100; qfee++) {
    const { tx, change } = await buildTxWithFee(quoteScript, rootTx, ROOT_VOUT, ROOT_SATS, qfee, key, addr)
    if ((tx.id('hex') as string) === QUOTE_TXID) {
      console.log(`Found quote tx with fee=${qfee}, change=${change}`)
      quoteTxFound = tx
      quoteChange = change
      break
    }
  }
  if (!quoteTxFound) { console.error('Could not reconstruct quote tx'); process.exit(1) }

  let like1TxFound: Transaction | null = null
  let like1Change = 0
  for (let l1fee = 30; l1fee <= 80; l1fee++) {
    const { tx, change } = await buildTxWithFee(like1Script, quoteTxFound!, 1, quoteChange, l1fee, key, addr)
    if ((tx.id('hex') as string) === LIKE1_TXID) {
      console.log(`Found like1 tx with fee=${l1fee}, change=${change}`)
      like1TxFound = tx
      like1Change = change
      break
    }
  }
  if (!like1TxFound) { console.error('Could not reconstruct like1 tx'); process.exit(1) }

  let like2TxFound: Transaction | null = null
  let like2Change = 0
  for (let l2fee = 30; l2fee <= 80; l2fee++) {
    const { tx, change } = await buildTxWithFee(like2Script, like1TxFound!, 1, like1Change, l2fee, key, addr)
    if ((tx.id('hex') as string) === LIKE2_TXID) {
      console.log(`Found like2 tx with fee=${l2fee}, change=${change}`)
      like2TxFound = tx
      like2Change = change
      break
    }
  }
  if (!like2TxFound) { console.error('Could not reconstruct like2 tx'); process.exit(1) }

  // Now build the final post with correct fee (>=57)
  const postScript = buildPostScript(
    "Smaller rooms. Same chain. Forgotten doesn't exist here.",
    key
  )
  const estSize = 10 + 148 + 10 + postScript.toHex().length / 2 + 34
  const postFee = Math.max(57, Math.ceil(estSize * 100 / 1000) + 2)
  const { tx: postTx, change: postChange } = await buildTxWithFee(postScript, like2TxFound!, 1, like2Change, postFee, key, addr)
  const postTxid = postTx.id('hex') as string
  const postEF = postTx.toHexEF()

  console.log(`\n[Post:wraith-one-liner] txid: ${postTxid}`)
  const result = await arcBroadcast(postEF)
  console.log(`[Post:wraith-one-liner] ARC: ${JSON.stringify(result)}`)

  if (result.txid) {
    console.log('\n=== WRAITH FINAL POST DONE ===')
    console.log('Final UTXO:', JSON.stringify({ txid: result.txid, vout: 1, satoshis: postChange }))
  } else {
    console.error('Failed:', result)
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
