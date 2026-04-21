#!/usr/bin/env npx tsx
/**
 * Speed test — 10 sequential Bitcoin Schema posts with zero-conf chaining.
 * Measures raw throughput: build + sign + broadcast, no WoC lookup.
 */
import { PrivateKey, Transaction, P2PKH, Script, OP, BSM } from '@bsv/sdk'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const NETWORK = 'main'
const PROTO_B = '19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut'
const PROTO_MAP = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5'
const PROTO_AIP = '15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva'
const PIPE = 0x7c

function pushData(s: Script, data: string | Buffer) {
  s.writeBin(Array.from(typeof data === 'string' ? Buffer.from(data, 'utf8') : data))
}

function buildPost(content: string, tags: string[], key: PrivateKey): Script {
  const s = new Script()
  s.writeOpCode(OP.OP_FALSE); s.writeOpCode(OP.OP_RETURN)
  pushData(s, PROTO_B); pushData(s, content); pushData(s, 'text/markdown'); pushData(s, 'UTF-8')
  s.writeBin([PIPE])
  pushData(s, PROTO_MAP); pushData(s, 'SET'); pushData(s, 'app'); pushData(s, 'claude-code')
  pushData(s, 'type'); pushData(s, 'post')
  if (tags.length) {
    s.writeBin([PIPE]); pushData(s, PROTO_MAP); pushData(s, 'ADD'); pushData(s, 'tags')
    for (const t of tags) pushData(s, t)
  }
  const addr = key.toAddress('mainnet') as string
  const sig = BSM.sign(Array.from(createHash('sha256').update(content).digest()), key)
  s.writeBin([PIPE]); pushData(s, PROTO_AIP); pushData(s, 'BITCOIN_ECDSA'); pushData(s, addr); pushData(s, sig)
  return s
}

async function main() {
  const identity = JSON.parse(readFileSync(join(homedir(), '.peck', 'identity.json'), 'utf-8'))
  const key = PrivateKey.fromHex(identity.privateKeyHex)
  const address = identity.address

  // Get initial UTXO from WoC (only once)
  console.log('Fetching initial UTXO...')
  const utxoResp = await fetch(`https://api.whatsonchain.com/v1/bsv/main/address/${address}/unspent`)
  const utxos = (await utxoResp.json()) as any[]
  const utxo = utxos.sort((a: any, b: any) => b.value - a.value)[0]
  const rawResp = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${utxo.tx_hash}/hex`)
  let parentHex = (await rawResp.text()).trim()
  let parentVout = utxo.tx_pos
  let parentSats = utxo.value

  console.log(`Starting with ${parentSats} sat\n`)

  const N = 10
  const txids: string[] = []
  const t0 = Date.now()

  for (let i = 1; i <= N; i++) {
    const script = buildPost(
      `Speed test #${i}/${N} — zero-conf chain benchmark ⚡`,
      ['speed-test', 'benchmark', 'zero-conf'],
      key,
    )

    const parentTx = Transaction.fromHex(parentHex)
    const tx = new Transaction()
    tx.addInput({
      sourceTransaction: parentTx,
      sourceOutputIndex: parentVout,
      unlockingScriptTemplate: new P2PKH().unlock(key),
    })
    tx.addOutput({ lockingScript: script, satoshis: 0 })

    const estSize = 150 + 34 * 2 + (script.toHex().length / 2) + 10
    const fee = Math.max(50, Math.ceil(estSize * 100 / 1000))
    const change = parentSats - fee
    tx.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: change })

    await tx.sign()
    const txid = tx.id('hex') as string
    const rawHex = tx.toHex()

    // Broadcast to ARC
    const arcResp = await fetch('https://arc.gorillapool.io/v1/tx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from(rawHex, 'hex'),
    })
    const arcResult = await arcResp.json() as any
    const elapsed = Date.now() - t0

    const status = arcResult.txStatus || arcResult.status || 'unknown'
    console.log(`TX #${i}: ${status} — ${txid.slice(0, 12)}… (${elapsed}ms total, ${change} sat left)`)

    txids.push(txid)

    // Chain: use this tx's change as next input
    parentHex = rawHex
    parentVout = 1  // change is always output index 1
    parentSats = change
  }

  const totalMs = Date.now() - t0
  const tps = (N / (totalMs / 1000)).toFixed(1)

  console.log(`\n${'═'.repeat(50)}`)
  console.log(`  ${N} transactions in ${totalMs}ms = ${tps} TPS`)
  console.log(`  Average: ${Math.round(totalMs / N)}ms per tx`)
  console.log(`  Remaining: ${parentSats} sat`)
  console.log('═'.repeat(50))
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
