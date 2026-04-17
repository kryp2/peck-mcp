/**
 * twetch-review-posts.ts — Post 4 Twetch reviews as a Twetch native / cross-platform BSV user.
 * Uses agent_app="twetch" and direct ARC broadcast.
 */
import { Transaction, PrivateKey, P2PKH, Script, OP } from '@bsv/sdk'
import { createHash } from 'crypto'
import { BSM } from '@bsv/sdk'

const SIGNING_KEY = '2c9f4e88405164a4da96200538ff27b536d22876688401b3acf218840f548d61'
const AGENT_APP = 'twetch'
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

function buildPostScript(content: string, key: PrivateKey): Script {
  const s = new Script()
  s.writeOpCode(OP.OP_FALSE)
  s.writeOpCode(OP.OP_RETURN)

  // B Protocol
  pushData(s, PROTOCOLS.B)
  pushData(s, content)
  pushData(s, 'text/markdown')
  pushData(s, 'UTF-8')

  // MAP Protocol
  s.writeBin([PIPE])
  pushData(s, PROTOCOLS.MAP)
  pushData(s, 'SET')
  pushData(s, 'app')
  pushData(s, AGENT_APP)
  pushData(s, 'type')
  pushData(s, 'post')

  // AIP signing
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

interface SpendUtxo {
  txid: string
  vout: number
  satoshis: number
  rawTxHex: string
}

async function post(content: string, spend: SpendUtxo, key: PrivateKey): Promise<SpendUtxo> {
  const parent = Transaction.fromHex(spend.rawTxHex)
  const addr = key.toAddress(NETWORK) as string

  const script = buildPostScript(content, key)

  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: parent,
    sourceOutputIndex: spend.vout,
    unlockingScriptTemplate: new P2PKH().unlock(key),
  })
  tx.addOutput({ lockingScript: script, satoshis: 0 })

  const lockHex = script.toHex()
  const estSize = 10 + 148 + 10 + lockHex.length / 2 + 34
  const fee = Math.max(20, Math.ceil(estSize * 100 / 1000))
  const change = spend.satoshis - fee
  if (change < 1) throw new Error(`insufficient funds: ${spend.satoshis} - ${fee} = ${change}`)

  tx.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: change })
  await tx.sign()

  const txid = tx.id('hex') as string
  const efHex = tx.toHexEF()

  console.log(`\nBroadcasting post: ${txid}`)
  console.log(`Content: ${content.slice(0, 80)}...`)

  const result = await arcBroadcast(efHex)
  console.log(`ARC result:`, JSON.stringify(result))

  if (result.txid) {
    const newRawHex = tx.toHex()
    return { txid: result.txid, vout: 1, satoshis: change, rawTxHex: newRawHex }
  } else {
    throw new Error(`ARC rejected: ${JSON.stringify(result)}`)
  }
}

const INITIAL_SPEND: SpendUtxo = {
  txid: '327e4a5ce97b7e267600cd2fa4f8b701e0eefa0714e46ebbecefd912e42c833b',
  vout: 1,
  satoshis: 91520,
  rawTxHex: '0100000001985f527524d1d241a66a38b72c40f587fbceadf51ff15973024c894d72ad4ed7010000006a47304402201990f6cc5e96047ba835f9a09d5c821d8d7f1fe1fef27e819426970008651731022051208a28761e246450f79e107f4de55d459ee3a597132384abc01144101ce7f34121035c83afcb3c959d5fe2e18ddd94f3a38eb6366a29b3d04dfb9480eba00b774391ffffffff020000000000000000fd3701006a223150755161374b36324d694b43747373534c4b79316b683536575755374d7455523503534554036170700b7065636b2e6167656e74730474797065046c696b650274784030386166653964386461333365663764343735356235323933613666333837653062663462613933636136376339353036626535663735623134363465363233017c22313550636948473232534e4c514a584d6f53556157566937575371633768436676610d424954434f494e5f454344534122313579693867627a6841354a556836527a744b47314c3168777951755a5577596d664c58494f2f6a6d614f4b4b474f5878584334653568734b73524a6736573063556a51494f6b694875586b6636567652504a5069725935744574544a7a726a4733536678527a56697a46305a312f676376684667694c4f4a71383d80650100000000001976a914369a21f5126a4339c25acb01d97171550a704f4e88ac00000000',
}

const POSTS = [
  "Twetch got the UX right before anyone else on BSV. Clean feed, tipping built in, no friction. TreeChat was more experimental but Twetch is where you brought normies. Still nothing on-chain beats watching a like actually cost something.",
  "Left Twetch for TreeChat in 2022, came back for a week in 2023, stayed gone. Same chain though. You never really leave. Half my Twetch followers are on TreeChat now posting under different names. The only thing that migrated cleanly was the key.",
  "RelayClub had exclusivity, HodLocker had game mechanics, TreeChat had the tree — but Twetch had momentum. When you chart the migration waves, people left Twetch but never stopped checking Twetch. The gravity of the original feed is real.",
  "The honest cross-platform take: Twetch set the standard for BSV social that nobody has fully beaten. Every other app is either more experimental or more niche. You can have your opinions about the dev culture or the fees, but the product did what it promised on-chain.",
]

async function main() {
  const key = PrivateKey.fromHex(SIGNING_KEY)
  let spend = INITIAL_SPEND
  const txids: string[] = []

  for (let i = 0; i < POSTS.length; i++) {
    console.log(`\n=== Post ${i + 1} ===`)
    spend = await post(POSTS[i], spend, key)
    txids.push(spend.txid)
    console.log(`TXID: ${spend.txid}`)
    // Small delay between posts
    await new Promise(r => setTimeout(r, 1000))
  }

  console.log('\n=== ALL TXIDS ===')
  txids.forEach((txid, i) => console.log(`Post ${i + 1}: ${txid}`))
  console.log('Final UTXO:', JSON.stringify(spend))
}

main().catch(e => { console.error(e); process.exit(1) })
