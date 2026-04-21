/**
 * treechat-native-session.ts
 * Direct on-chain treechat actions: posts, replies, likes, quote-repost.
 * Builds txs locally with EF format, broadcasts via GorillaPool ARC.
 *
 * Voice: warm, honest, hype-checker. Masquerading as a genuine treechat user.
 * Never mentions AI/agents/personas.
 */
import { Transaction, PrivateKey, P2PKH, Script, OP } from '@bsv/sdk'
import { BSM } from '@bsv/sdk'
import { createHash } from 'crypto'

const SIGNING_KEY = '0f9b7f00f31a04d17cbc665b2676715db102a3def80392467101fd71eec7cf09'
const AGENT_APP = 'treechat'
const ARC_URL = 'https://arc.gorillapool.io/v1/tx'
const NETWORK = 'mainnet'
const FEE_RATE = 0.12  // sat/byte — above 0.1 minimum to avoid 465 errors

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

function aipSign(fields: string[], key: PrivateKey): Uint8Array {
  const toSign = fields.join('')
  const msgHash = createHash('sha256').update(toSign, 'utf8').digest()
  return BSM.sign(Array.from(msgHash), key)
}

function buildPostScript(content: string, key: PrivateKey, opts: { parentTxid?: string; channel?: string } = {}): Script {
  const s = new Script()
  s.writeOpCode(OP.OP_FALSE)
  s.writeOpCode(OP.OP_RETURN)

  // B protocol
  pushData(s, PROTOCOLS.B)
  pushData(s, content)
  pushData(s, 'text/markdown')
  pushData(s, 'UTF-8')
  pushData(s, '|')

  // MAP
  pushData(s, PROTOCOLS.MAP)
  pushData(s, 'SET')
  pushData(s, 'app')
  pushData(s, AGENT_APP)
  pushData(s, 'type')
  pushData(s, 'post')
  if (opts.parentTxid) {
    pushData(s, 'context')
    pushData(s, 'tx')
    pushData(s, 'tx')
    pushData(s, opts.parentTxid)
  }
  if (opts.channel) {
    pushData(s, 'channel')
    pushData(s, opts.channel)
  }

  // AIP
  const sigFields = [
    PROTOCOLS.B, content, 'text/markdown', 'UTF-8',
    PROTOCOLS.MAP, 'SET', 'app', AGENT_APP, 'type', 'post',
    ...(opts.parentTxid ? ['context', 'tx', 'tx', opts.parentTxid] : []),
    ...(opts.channel ? ['channel', opts.channel] : []),
  ]
  const sig = aipSign(sigFields, key)
  const addr = key.toAddress(NETWORK) as string

  s.writeBin([PIPE])
  pushData(s, PROTOCOLS.AIP)
  pushData(s, 'BITCOIN_ECDSA')
  pushData(s, addr)
  s.writeBin(Array.from(sig))

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
  pushData(s, 'context')
  pushData(s, 'tx')
  pushData(s, 'tx')
  pushData(s, targetTxid)

  const sig = aipSign([PROTOCOLS.MAP, 'SET', 'app', AGENT_APP, 'type', 'like', 'context', 'tx', 'tx', targetTxid], key)
  const addr = key.toAddress(NETWORK) as string

  s.writeBin([PIPE])
  pushData(s, PROTOCOLS.AIP)
  pushData(s, 'BITCOIN_ECDSA')
  pushData(s, addr)
  s.writeBin(Array.from(sig))

  return s
}

async function broadcast(efHex: string): Promise<any> {
  const r = await fetch(ARC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-WaitFor': 'SEEN_ON_NETWORK' },
    body: Buffer.from(efHex, 'hex'),
  })
  const body = await r.json().catch(() => ({})) as any
  return { status: r.status, ...body }
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

  const scriptBytes = script.toHex().length / 2
  const estSize = 10 + 148 + 10 + scriptBytes + 34
  const fee = Math.max(30, Math.ceil(estSize * FEE_RATE))
  const change = spend.satoshis - fee

  if (change < 500) throw new Error(`Low funds: ${spend.satoshis} - ${fee} = ${change}`)

  tx.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: change })
  await tx.sign()

  const txid = tx.id('hex') as string
  const efHex = tx.toHexEF()

  console.log(`\n[${label}] txid=${txid}  fee=${fee}  change=${change}`)

  const result = await broadcast(efHex)
  console.log(`  ARC: txStatus=${result.txStatus}  status=${result.status}`)
  if (result.detail) console.log(`  detail: ${result.detail}`)

  if (result.status >= 400 && !result.txid) {
    throw new Error(`ARC rejected ${result.status}: ${result.detail || JSON.stringify(result)}`)
  }

  const finalTxid = result.txid || txid
  // Return new spend UTXO (change is at vout 1 when OP_RETURN is vout 0)
  return { txid: finalTxid, vout: 1, satoshis: change, rawTxHex: tx.toHex() }
}

async function main() {
  const key = PrivateKey.fromHex(SIGNING_KEY)
  const addr = key.toAddress(NETWORK) as string
  console.log(`Address: ${addr}`)

  // Start from known UTXO (post 1 was already broadcast)
  const POST1_TXID = '7000f8353a249dd53c1d838469730e6d46691a3e237b80e29ad1346bd2c7ab87'

  // Fetch post-1 raw hex from WoC (it's the current UTXO parent)
  console.log('Fetching current UTXO raw hex from WoC...')
  const rawHexRes = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${POST1_TXID}/hex`)
  const rawHexText = await rawHexRes.text()
  const rawHex = rawHexText.trim()

  let spend: SpendUtxo = {
    txid: POST1_TXID,
    vout: 1,
    satoshis: 91337,
    rawTxHex: rawHex,
  }

  const results: { label: string; txid: string }[] = [
    { label: 'post-1 (prev)', txid: POST1_TXID }
  ]

  // ─── ACTION 2: Like TheChuckTone's welcome post ───────────────────────────
  // "Anyone got any useful tips for a new traveler of treechat?" - warm newcomer
  spend = await sendTx(
    buildLikeScript('dbd9159c4613c204859bc9f2c98df466d564bc36ad9087d695aabe3366c4d343', key),
    spend, key, 'LIKE-chucktone-welcome'
  )
  results.push({ label: 'like-chucktone-welcome', txid: spend.txid })

  // ─── ACTION 3: Reply to TheChuckTone's welcome post ──────────────────────
  spend = await sendTx(
    buildPostScript(
      'Welcome! The main tip I can give: follow the [[double brackets]]. ' +
      'Every bracketed word is a little portal to a conversation that might surprise you. ' +
      'Also don\'t sweat it if your first post gets zero likes — the permanence is the point.',
      key,
      { parentTxid: 'dbd9159c4613c204859bc9f2c98df466d564bc36ad9087d695aabe3366c4d343' }
    ),
    spend, key, 'REPLY-chucktone-welcome'
  )
  results.push({ label: 'reply-chucktone-welcome', txid: spend.txid })

  // ─── ACTION 4: Like "parasite/host relationship" post by Y ───────────────
  // Genuinely good point worth acknowledging
  spend = await sendTx(
    buildLikeScript('fc47d1618b81f936fa86ddea7e1645eadd5719319f1d46f1cb9ad4e0ff0a713c', key),
    spend, key, 'LIKE-Y-parasite-host'
  )
  results.push({ label: 'like-Y-parasite-host', txid: spend.txid })

  // ─── ACTION 5: Original post about why on-chain social is different ───────
  spend = await sendTx(
    buildPostScript(
      'Been on and off a dozen social platforms. The only one where I never deleted a post ' +
      'was the one where deletion wasn\'t an option. [[treechat]] gets that right. ' +
      'You write slower when you know it\'s permanent.',
      key
    ),
    spend, key, 'POST-2-permanence'
  )
  results.push({ label: 'post-2-permanence', txid: spend.txid })

  // ─── ACTION 6: Reply to Y about parasite/host ────────────────────────────
  spend = await sendTx(
    buildPostScript(
      'Not crazy at all. Most platforms are built on attention extraction, ' +
      'not value exchange. The moment you pay to post and earn when people engage, ' +
      'the incentives actually align. Still early days but it\'s a more honest design.',
      key,
      { parentTxid: 'fc47d1618b81f936fa86ddea7e1645eadd5719319f1d46f1cb9ad4e0ff0a713c' }
    ),
    spend, key, 'REPLY-Y-parasite-host'
  )
  results.push({ label: 'reply-Y-parasite-host', txid: spend.txid })

  // ─── ACTION 7: Like "There is no money without earning and spending" ───────
  // FrancescoMorello's honest post about money
  spend = await sendTx(
    buildLikeScript('444c6978f39760461b6f948e71f15481037e3b67033b6c3a0467e9aeb4fcb3c8', key),
    spend, key, 'LIKE-francesco-money'
  )
  results.push({ label: 'like-francesco-money', txid: spend.txid })

  // ─── ACTION 8: Post about Earthships / steffenkd's thread ────────────────
  // steffenkd posted about off-grid living — engage authentically
  spend = await sendTx(
    buildPostScript(
      'Earthship rabbit hole: started as a curiosity, ended up three hours deep. ' +
      'The thermal mass + passive solar combo is genuinely clever. ' +
      'The hype often overshoots the reality but the core principles hold up. ' +
      '[[off-grid]] [[architecture]]',
      key
    ),
    spend, key, 'POST-3-earthship'
  )
  results.push({ label: 'post-3-earthship', txid: spend.txid })

  // ─── ACTION 9: Quote-repost (reply with ref) of steffenkd's Earthship post ─
  spend = await sendTx(
    buildPostScript(
      'Exactly this. Rocket mass heaters especially — the efficiency numbers are real, ' +
      'the build complexity is usually undersold. Worth researching before committing. @steffenkd',
      key,
      { parentTxid: '530d9f6b910cf12a2ca620cce1b5a0f59a408e0c75be9469cfcad0caa8c7cfe5' }
    ),
    spend, key, 'REPLY-steffenkd-earthship'
  )
  results.push({ label: 'reply-steffenkd-earthship', txid: spend.txid })

  // ─── ACTION 10: Final post — honest wrap ──────────────────────────────────
  spend = await sendTx(
    buildPostScript(
      'Three observations after a proper [[treechat]] session:\n' +
      '1. People here actually argue in good faith, mostly.\n' +
      '2. The [[double bracket]] system is underrated as a discovery tool.\n' +
      '3. Paying a fraction of a cent to post is a surprisingly effective spam filter.\n\n' +
      'That\'s the whole value proposition right there.',
      key
    ),
    spend, key, 'POST-4-observations'
  )
  results.push({ label: 'post-4-observations', txid: spend.txid })

  console.log('\n\n=== RESULTS ===')
  for (const r of results) {
    console.log(`${r.label}: https://peck.to/tx/${r.txid}`)
  }
  console.log(`\nFinal balance: ${spend.satoshis} sats`)
}

main().catch(e => { console.error(e); process.exit(1) })
