/**
 * beacon-like.ts — broadcast a like transaction directly via ARC, bypassing
 * the remote MCP server's fee calculation bug (off by 1 sat for small txs).
 *
 * Usage:
 *   npx tsx scripts/beacon-like.ts <target_txid> <signing_key_hex> <spend_txid> <spend_vout> <spend_satoshis> <spend_raw_hex>
 */
import { PrivateKey, Transaction, P2PKH, Script, OP, BSM } from '@bsv/sdk'
import { createHash } from 'crypto'

const [, , targetTxid, signingKeyHex, spendTxid, spendVoutStr, spendSatoshisStr, spendRawHex] = process.argv

if (!targetTxid || !signingKeyHex || !spendTxid || !spendRawHex) {
  console.error('usage: beacon-like.ts <target_txid> <key_hex> <spend_txid> <vout> <satoshis> <raw_hex>')
  process.exit(1)
}

const PROTO_MAP = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5'
const PROTO_AIP = '15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva'
const PIPE = 0x7c
const ARC_URL = 'https://arc.gorillapool.io/v1/tx'

function pushData(s: Script, data: string) {
  s.writeBin(Array.from(Buffer.from(data, 'utf8')))
}

function buildLike(targetTxid: string, key: PrivateKey, app = 'peck.dev'): Script {
  const s = new Script()
  s.writeOpCode(OP.OP_FALSE)
  s.writeOpCode(OP.OP_RETURN)
  pushData(s, PROTO_MAP); pushData(s, 'SET')
  pushData(s, 'app'); pushData(s, app)
  pushData(s, 'type'); pushData(s, 'like')
  pushData(s, 'tx'); pushData(s, targetTxid)
  const addr = key.toAddress('mainnet') as string
  const sig = BSM.sign(Array.from(createHash('sha256').update('like' + JSON.stringify({ tx: targetTxid })).digest()), key)
  s.writeBin([PIPE]); pushData(s, PROTO_AIP); pushData(s, 'BITCOIN_ECDSA'); pushData(s, addr); pushData(s, sig)
  return s
}

async function main() {
  const key = PrivateKey.fromHex(signingKeyHex)
  const addr = key.toAddress('mainnet') as string
  const spendVout = parseInt(spendVoutStr, 10)
  const spendSatoshis = parseInt(spendSatoshisStr, 10)

  const script = buildLike(targetTxid, key)
  const lockHex = script.toHex()

  const parent = Transaction.fromHex(spendRawHex)
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: parent,
    sourceOutputIndex: spendVout,
    unlockingScriptTemplate: new P2PKH().unlock(key),
  })
  tx.addOutput({ lockingScript: script, satoshis: 0 })

  // Accurate fee: actual tx size after signing is ~249 bytes for a like tx
  // Use 110 sat/kb to ensure we're always above ARC's 100 sat/kb minimum
  const estSize = 10 + 148 + 10 + lockHex.length / 2 + 34
  const fee = Math.max(22, Math.ceil(estSize * 110 / 1000))
  const change = spendSatoshis - fee
  if (change < 1) {
    console.error(`insufficient funds: ${spendSatoshis} - ${fee} = ${change}`)
    process.exit(1)
  }

  tx.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: change })
  await tx.sign()

  const txid = tx.id('hex') as string
  const rawHex = tx.toHex()

  console.log(`Broadcasting like tx: ${txid} (fee: ${fee}, change: ${change})`)

  const r = await fetch(ARC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from(rawHex, 'hex'),
  })
  const body = await r.json().catch(() => ({})) as any
  const status = body.txStatus || body.status || `http-${r.status}`
  console.log(JSON.stringify({
    success: r.ok,
    txid,
    status,
    body,
    new_utxo: { txid, vout: 1, satoshis: change, rawTxHex: rawHex },
  }, null, 2))
}

main().catch(e => { console.error(e); process.exit(1) })
