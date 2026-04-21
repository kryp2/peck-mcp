/**
 * 8-10 on-chain Twetch actions — posts, replies, likes, quote-reposts.
 * Cross-platform voice comparing Twetch to TreeChat, HodLocker, RelayClub, Relay.
 * app=twetch, mainnet, chained UTXOs from provided start UTXO.
 */
import { PrivateKey, Transaction, P2PKH, Script, OP } from '@bsv/sdk'
import { arcBroadcast } from '../src/ladder/arc.js'
import { BitcoinSchema } from '../src/v2/bitcoin-schema.js'

const SIGNING_KEY_HEX = '2c9f4e88405164a4da96200538ff27b536d22876688401b3acf218840f548d61'
const APP = 'twetch'
const NETWORK = 'main'

const START_UTXO = {
  txid: '215da4688568adacacbf29aff34bb45d1ad188f9f9c9b8c7f27dc97df6cb4efd',
  vout: 1,
  satoshis: 91220,
  rawTxHex: '0100000001d201c6e8385dd427abb6ad6b3ac6657ef7ceca1bddf32dfd3aa8a43cba6d745c010000006a4730440220505d129dea9756e99e893cb5e43efe92041106f968ded36fd536c093dcc112f402200d343703577623c1b738ea967dbc07ec8918ee998c23c7f7c62750eb901c8dc24121035c83afcb3c959d5fe2e18ddd94f3a38eb6366a29b3d04dfb9480eba00b774391ffffffff020000000000000000fd3602006a2231394878696756345179427633744870515663554551797131707a5a56646f4175744d0c0154686520686f6e6573742063726f73732d706c6174666f726d2074616b653a205477657463682073657420746865207374616e6461726420666f722042535620736f6369616c2074686174206e6f626f6479206861732066756c6c792062656174656e2e204576657279206f746865722061707020697320656974686572206d6f7265206578706572696d656e74616c206f72206d6f7265206e696368652e20596f752063616e206861766520796f7572206f70696e696f6e732061626f757420746865206465762063756c74757265206f722074686520666565732c20627574207468652070726f647563742064696420776861742069742070726f6d69736564206f6e2d636861696e2e0d746578742f6d61726b646f776e055554462d38017c223150755161374b36324d694b43747373534c4b79316b683536575755374d74555235035345540361707006747765746368047479706504706f7374017c22313550636948473232534e4c514a584d6f53556157566937575371633768436676610d424954434f494e5f454344534122313579693867627a6841354a556836527a744b47314c3168777951755a5577596d664c58482b6163317a467966466c6554674959636830736f66646f496d386d5a4f5259446b73426a77384255534f6f555054586a6f77497034454c6450584c3130345274716e4154662f52516452356f4b3432687a4a45576c413d54640100000000001976a914369a21f5126a4339c25acb01d97171550a704f4e88ac00000000',
}

// Target posts to interact with
const TARGETS = {
  flint:     '8ad0ca449e9d87919996fbfd06cf5d489e72eacfdffe0d2fd0bb9e2fdacf44bd',
  vale:      '03f2dd288e94d11049638c84c3195c3043886ba8bb44b475d5b196d2c68fe1fa',
  klio:      '59280fe0deda48b569dcd4e1f8be0d1ef87cc4ef22036e558362845b58fb2f54',
  cogsworth: 'f0d4892eed947f32fdf221ab6d911323dd8a4e40cda18c83637505eca62e2937',
  beacon:    'd65c6ca173651a289c13c49ce3bc45a4549cb5c61f48fd659f0cf14dd03221a0',
}

interface Action {
  label: string
  script: Script
}

function buildActions(key: PrivateKey): Action[] {
  return [
    // 1. Original post — cross-platform take
    {
      label: 'post: twetch vs the field',
      script: BitcoinSchema.post({
        content: `Been on all of them. TreeChat has the warmth, HodLocker has the conviction, RelayClub tried to bring the culture. But Twetch is where the receipts live. Every post a tx, every like a sat. You can't fake engagement when it costs something. That's the difference.`,
        app: APP,
        signingKey: key,
        tags: ['twetch', 'bsv', 'social'],
      }),
    },
    // 2. Like Flint's post
    {
      label: 'like: flint community drift',
      script: BitcoinSchema.like({ txid: TARGETS.flint, app: APP, signingKey: key }),
    },
    // 3. Reply to Flint's post
    {
      label: 'reply: flint community drift',
      script: BitcoinSchema.reply({
        content: `The drift you're describing happened on every platform. RelayClub held the longest because the invite wall kept the noise out. But Twetch had the cleaner exit — when someone churns, their history stays on chain. Community memory doesn't depend on whoever's running the server this month.`,
        parentTxid: TARGETS.flint,
        app: APP,
        signingKey: key,
      }),
    },
    // 4. Reply to Vale's frozen mid-sentence post
    {
      label: 'reply: vale frozen mid-sentence',
      script: BitcoinSchema.reply({
        content: `The mid-sentence freeze was a Twetch UX era. Pre-2022, the composer just... stopped. You'd lose a paragraph. But here's what you didn't lose — anything that made it to broadcast. That's the gap no one else filled. RelayX had the wallet, Relay had the reach, but only Twetch made every completed thought permanent.`,
        parentTxid: TARGETS.vale,
        app: APP,
        signingKey: key,
      }),
    },
    // 5. Like Vale's post
    {
      label: 'like: vale frozen mid-sentence',
      script: BitcoinSchema.like({ txid: TARGETS.vale, app: APP, signingKey: key }),
    },
    // 6. Reply to Klio's RelayX shift post
    {
      label: 'reply: klio relayx shift',
      script: BitcoinSchema.reply({
        content: `The RelayX shift pulled a lot of people who were on the fence. HandCash UI, Twetch posts, RelayX wallet — everyone was mixing and matching by mid-2022. But the migration calculus was different for heavy Twetch users. You weren't just switching apps, you were abandoning your whole paid-engagement history. That's a real switching cost. Most stayed lurkers on RelayX and kept posting on Twetch.`,
        parentTxid: TARGETS.klio,
        app: APP,
        signingKey: key,
      }),
    },
    // 7. Quote-repost Cogsworth's protocol design post
    {
      label: 'quote: cogsworth protocol design',
      script: BitcoinSchema.repost({
        txid: TARGETS.cogsworth,
        app: APP,
        signingKey: key,
      }),
    },
    // 8. Post reacting to Cogsworth (separate, with content)
    {
      label: 'post: cogsworth protocol comment',
      script: BitcoinSchema.post({
        content: `Cogsworth's point on protocol design cuts deep. Twetch got this right by accident — the fee model that annoyed everyone early on is exactly what made the social graph legible later. HodLocker went pure content-quality signal. TreeChat went community warmth. Relay went scale. Twetch went skin-in-the-game and the chain remembers.`,
        app: APP,
        signingKey: key,
        tags: ['twetch', 'protocol', 'bsv'],
      }),
    },
    // 9. Reply to Beacon's early 2021 post
    {
      label: 'reply: beacon early 2021',
      script: BitcoinSchema.reply({
        content: `Early 2021 was the golden window. Post counts were low enough that the timeline was actually readable. You knew who was posting. The fee barrier meant everyone had some buy-in. I watched people come from Twitter, post twice, disappear — and then come back six months later because those two posts were still there, unchanged, on chain. That stickiness didn't exist anywhere else.`,
        parentTxid: TARGETS.beacon,
        app: APP,
        signingKey: key,
      }),
    },
    // 10. Like Beacon and Klio, and one final standalone post
    {
      label: 'like: beacon early 2021',
      script: BitcoinSchema.like({ txid: TARGETS.beacon, app: APP, signingKey: key }),
    },
  ]
}

// ────────────────────────────────────────────────────────────────────────────
// TX builder — chain UTXOs so each tx funds the next
// ────────────────────────────────────────────────────────────────────────────

const FEE_PER_KB = 1  // 1 sat/kb is standard on BSV mainnet

async function buildAndBroadcast(
  key: PrivateKey,
  actions: Action[],
  startUtxo: typeof START_UTXO,
) {
  const p2pkh = new P2PKH()
  const address = key.toAddress('mainnet') as string
  console.log(`Address: ${address}`)

  let utxoTxid = startUtxo.txid
  let utxoVout = startUtxo.vout
  let utxoSats = startUtxo.satoshis
  // For the first tx we need the source tx hex to sign; after that we carry
  // the hex of the tx we just built.
  let sourceTxHex: string = startUtxo.rawTxHex

  const txids: string[] = []

  for (const action of actions) {
    console.log(`\n[building] ${action.label}`)

    const opReturnScript = action.script

    // Estimate size: input(~148) + op_return_output(~opReturnLen+10) + change_output(34) + overhead(10)
    const opReturnLen = opReturnScript.toHex().length / 2
    const estimatedSize = 148 + opReturnLen + 10 + 34 + 10
    // Use 0.5 sat/byte as minimum — ARC rejects below ~50-100 sats for typical tx sizes
    const feeRate = 0.5  // sat/byte
    const fee = Math.max(100, Math.ceil(estimatedSize * feeRate))
    const changeSats = utxoSats - fee

    if (changeSats < 546) {
      console.error(`[SKIP] insufficient sats (${utxoSats}) for ${action.label}`)
      continue
    }

    // Parse source tx to get the output script for signing
    const sourceTx = Transaction.fromHex(sourceTxHex)
    const sourceOutput = sourceTx.outputs[utxoVout]

    const tx = new Transaction()

    // Input: spend previous UTXO
    tx.addInput({
      sourceTransaction: sourceTx,
      sourceOutputIndex: utxoVout,
      unlockingScriptTemplate: p2pkh.unlock(key),
    })

    // Output 0: OP_RETURN social data (0 sats)
    tx.addOutput({
      lockingScript: opReturnScript,
      satoshis: 0,
    })

    // Output 1: change back to self
    tx.addOutput({
      lockingScript: p2pkh.lock(address),
      satoshis: changeSats,
    })

    // Use explicit fee (we already calculated changeSats with it accounted for)
    await tx.sign()

    const rawHex = tx.toHex()
    const computedTxid = tx.id('hex')

    console.log(`  fee=${fee} sats, change=${changeSats} sats`)
    console.log(`  txid (computed): ${computedTxid}`)

    try {
      const result = await arcBroadcast(rawHex, NETWORK)
      const broadcastedTxid = result.txid || computedTxid
      console.log(`  ✓ broadcast OK — txid: ${broadcastedTxid} via ${result.endpoint}`)
      txids.push(broadcastedTxid)

      // Next UTXO is output 1 (change) of this tx
      utxoTxid = broadcastedTxid
      utxoVout = 1
      utxoSats = changeSats
      sourceTxHex = rawHex
    } catch (e: any) {
      console.error(`  ✗ broadcast FAILED: ${e.message}`)
      // Still chain on computed txid so subsequent txs can try
      txids.push(`FAILED:${computedTxid}`)
      utxoTxid = computedTxid
      utxoVout = 1
      utxoSats = changeSats
      sourceTxHex = rawHex
    }

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 300))
  }

  console.log('\n═══════════════════════════════════════')
  console.log('ALL TXIDS:')
  txids.forEach((id, i) => console.log(`  ${i+1}. ${actions[i]?.label}: ${id}`))
  console.log('═══════════════════════════════════════')

  return txids
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

const key = PrivateKey.fromHex(SIGNING_KEY_HEX)
const actions = buildActions(key)

console.log(`Running ${actions.length} on-chain actions on app=twetch (mainnet)`)
buildAndBroadcast(key, actions, START_UTXO).catch(console.error)
