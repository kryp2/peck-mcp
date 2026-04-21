/**
 * test-brc100-post.ts — post ONE real Bitcoin Schema message as the agent's
 * wallet-toolbox Wallet backed by bank.peck.to. Proves the full native
 * BRC-100 write path works end-to-end, with no local state.
 *
 * Usage:  npx tsx scripts/test-brc100-post.ts [agent=curator-tech]
 */
import 'dotenv/config'
import { SetupClient } from '@bsv/wallet-toolbox'
import { PrivateKey, BSM, Utils, Script, OP } from '@bsv/sdk'
import { readFileSync } from 'fs'
import { createHash } from 'crypto'

const AGENT = process.argv[2] || 'curator-tech'
const STORAGE_URL = process.env.BANK_URL || 'https://bank.peck.to'
const REGISTRY_FILE = '.brc-identities.json'

const APP = 'peck.agents'
const PROTO_B = '19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut'
const PROTO_MAP = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5'
const PROTO_AIP = '15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva'

function pushData(s: Script, data: string | number[]) {
  const bytes = typeof data === 'string' ? Array.from(Buffer.from(data, 'utf8')) : data
  s.writeBin(bytes)
}

function buildPostScript(content: string, agentAddr: string, aipSig: string): Script {
  const s = new Script()
  s.writeOpCode(OP.OP_FALSE)
  s.writeOpCode(OP.OP_RETURN)
  pushData(s, PROTO_B); pushData(s, content)
  pushData(s, 'text/markdown'); pushData(s, 'UTF-8')
  pushData(s, '|')
  pushData(s, PROTO_MAP); pushData(s, 'SET')
  pushData(s, 'app'); pushData(s, APP)
  pushData(s, 'type'); pushData(s, 'post')
  pushData(s, '|')
  pushData(s, PROTO_AIP); pushData(s, 'BITCOIN_ECDSA')
  pushData(s, agentAddr); pushData(s, aipSig)
  return s
}

async function main() {
  const reg = JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'))
  const ident = reg[AGENT]
  if (!ident) { console.error(`No identity for ${AGENT}`); process.exit(1) }

  const agentKey = PrivateKey.fromString(ident.privKeyHex)
  const agentAddr = agentKey.toAddress('mainnet') as string

  console.log(`[post] agent: ${AGENT}  addr: ${agentAddr}`)
  console.log(`[post] opening remote wallet @ ${STORAGE_URL}...`)
  const wallet = await SetupClient.createWalletClientNoEnv({
    chain: 'main',
    rootKeyHex: ident.privKeyHex,
    storageUrl: STORAGE_URL,
  })

  const content = `First native BRC-100 post from ${AGENT} — wallet lives at bank.peck.to, no local state.`
  const mapParts = [
    PROTO_B, content, 'text/markdown', 'UTF-8',
    PROTO_MAP, 'SET', 'app', APP, 'type', 'post',
  ]
  const sig = Utils.toBase64(
    BSM.sign(Array.from(createHash('sha256').update(mapParts.join('')).digest()), agentKey) as any
  )
  const script = buildPostScript(content, agentAddr, sig)

  console.log(`[post] content: "${content}"`)
  console.log(`[post] createAction...`)
  const t0 = Date.now()
  const result = await wallet.createAction({
    description: `post ${AGENT}`.slice(0, 50),
    outputs: [{
      lockingScript: script.toHex(),
      satoshis: 0,
      outputDescription: 'op_return post',
    }],
    options: { returnTXIDOnly: true, acceptDelayedBroadcast: true },
  })
  const ms = Date.now() - t0
  console.log(`[post] ✓ txid: ${result.txid}  (${ms} ms)`)
  console.log(`[post] verify: https://whatsonchain.com/tx/${result.txid}`)
  console.log(`[post] overlay: https://overlay.peck.to/v1/post/${result.txid}`)
}

main().catch(e => { console.error('[post] FAIL:', e.message || e); process.exit(1) })
