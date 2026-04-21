/**
 * wallet-recovery-fast.ts — parallel wallet recovery from WoC confirmed UTXOs.
 *
 * 10 wallets at a time, shared hex cache. ~5 min for 1000 wallets.
 *
 * Usage:
 *   npx tsx scripts/wallet-recovery-fast.ts [prefix=all]
 */
import { readFileSync, writeFileSync, readdirSync } from 'fs'

const WOC = 'https://api.whatsonchain.com/v1/bsv/main'
const PREFIX = process.argv[2] || 'all'
const WALLET_DIR = '.agent-wallets'
const PARALLEL = 10

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const hexCache: Record<string, string> = {}

async function fetchRetry(url: string, retries = 3): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) })
      if (r.status === 429) { await sleep(2000 * (i + 1)); continue }
      return r
    } catch {
      if (i === retries - 1) throw new Error(`fetch failed: ${url}`)
      await sleep(1000)
    }
  }
  throw new Error('exhausted')
}

async function getHex(txid: string): Promise<string> {
  if (hexCache[txid]) return hexCache[txid]
  const r = await fetchRetry(`${WOC}/tx/${txid}/hex`)
  if (!r.ok) return ''
  const hex = (await r.text()).trim()
  hexCache[txid] = hex
  return hex
}

async function recoverOne(name: string): Promise<string> {
  const path = `${WALLET_DIR}/${name}.json`
  const wallet = JSON.parse(readFileSync(path, 'utf-8'))
  if (!wallet.address) return `${name}: no address`

  const r = await fetchRetry(`${WOC}/address/${wallet.address}/unspent`)
  if (!r.ok) return `${name}: WoC ${r.status}`
  const all = (await r.json()) as Array<{ tx_hash: string; tx_pos: number; value: number; height: number }>

  // Use confirmed + unconfirmed (height=0 might be valid mempool)
  const usable = all.filter(u => u.value > 100)
  if (usable.length === 0) return `${name}: empty (0 UTXOs)`

  // Group by parent txid
  const parents = [...new Set(usable.map(u => u.tx_hash))]

  // Fetch hex per unique parent
  const hexMap: Record<string, string> = {}
  for (const txid of parents) {
    const hex = await getHex(txid)
    if (hex) hexMap[txid] = hex
  }

  const utxos = usable
    .filter(u => hexMap[u.tx_hash])
    .map(u => ({ txid: u.tx_hash, vout: u.tx_pos, satoshis: u.value, rawTxHex: hexMap[u.tx_hash] }))

  if (utxos.length === 0) return `${name}: no fetchable hex`

  const totalSats = utxos.reduce((s, u) => s + u.satoshis, 0)
  const recovered = {
    agent: wallet.agent || name,
    address: wallet.address,
    privKeyHex: wallet.privKeyHex,
    utxos,
    index: 0,
    stats: { ...wallet.stats, recoveredAt: new Date().toISOString() },
  }
  writeFileSync(path, JSON.stringify(recovered, null, 2))
  return `${name}: ✓ ${utxos.length} UTXOs ${totalSats.toLocaleString()} sat`
}

async function main() {
  const prefixes = PREFIX === 'all'
    ? ['ranger-', 'agent-', 'scribe-', 'psalm-', 'cls-', 'wis-']
    : [PREFIX.endsWith('-') ? PREFIX : PREFIX + '-']

  const files = readdirSync(WALLET_DIR)
    .filter(f => f.endsWith('.json') && prefixes.some(p => f.startsWith(p)))
    .map(f => f.replace('.json', ''))
    .sort()

  console.log(`[recovery] ${files.length} wallets, parallel=${PARALLEL}`)
  const start = Date.now()
  let done = 0, ok = 0

  // Process in batches of PARALLEL
  for (let i = 0; i < files.length; i += PARALLEL) {
    const batch = files.slice(i, i + PARALLEL)
    const results = await Promise.all(batch.map(f => recoverOne(f).catch(e => `${f}: ERROR ${e.message}`)))

    for (const r of results) {
      done++
      if (r.includes('✓')) ok++
      // Only log errors and every 50th success
      if (!r.includes('✓') || ok % 50 === 0) console.log(`  ${r}`)
    }

    if (done % 100 === 0 || i + PARALLEL >= files.length) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(0)
      console.log(`  --- ${done}/${files.length} done, ${ok} recovered, ${elapsed}s ---`)
    }

    await sleep(200) // small delay between batches
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(0)
  console.log(`\n[recovery] DONE: ${ok}/${files.length} recovered in ${elapsed}s`)
  console.log(`[recovery] hex cache: ${Object.keys(hexCache).length} unique parent TXs`)
}

main().catch(e => { console.error('[recovery] FATAL:', e.message); process.exit(1) })
