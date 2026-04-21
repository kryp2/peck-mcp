/**
 * wallet-recovery.ts — rebuild wallet state from chain (WoC confirmed UTXOs).
 *
 * For each agent wallet, queries WoC for confirmed unspent UTXOs at the
 * agent's address, fetches rawTxHex, and rewrites the wallet file.
 *
 * Usage:
 *   npx tsx scripts/wallet-recovery.ts [prefix]
 *   prefix: "ranger" | "agent" | "scribe" | "psalm" | "cls" | "wis" | "all"
 *
 * Example:
 *   npx tsx scripts/wallet-recovery.ts ranger    # recover all ranger-* wallets
 *   npx tsx scripts/wallet-recovery.ts all       # recover everything
 */
import { readFileSync, writeFileSync, readdirSync } from 'fs'

const WOC = 'https://api.whatsonchain.com/v1/bsv/main'
const PREFIX = process.argv[2] || 'all'
const WALLET_DIR = '.agent-wallets'
const DELAY_MS = 300  // rate limit safety

interface WocUtxo { tx_hash: string; tx_pos: number; value: number; height: number }

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

async function fetchJson(url: string, retries = 3): Promise<any> {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (r.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!r.ok) throw new Error(`${r.status}`)
      return await r.json()
    } catch (e: any) {
      if (i === retries - 1) throw e
      await sleep(1000 * (i + 1))
    }
  }
}

async function fetchText(url: string, retries = 3): Promise<string> {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (r.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!r.ok) throw new Error(`${r.status}`)
      return (await r.text()).trim()
    } catch (e: any) {
      if (i === retries - 1) throw e
      await sleep(1000 * (i + 1))
    }
  }
  return ''
}

// Cache rawTxHex by txid (many UTXOs share same parent)
const hexCache: Record<string, string> = {}
async function getRawHex(txid: string): Promise<string> {
  if (hexCache[txid]) return hexCache[txid]
  await sleep(DELAY_MS)
  const hex = await fetchText(`${WOC}/tx/${txid}/hex`)
  hexCache[txid] = hex
  return hex
}

async function recoverWallet(name: string): Promise<{ ok: boolean; utxos: number; sats: number }> {
  const path = `${WALLET_DIR}/${name}.json`
  const wallet = JSON.parse(readFileSync(path, 'utf-8'))
  const addr = wallet.address

  if (!addr) return { ok: false, utxos: 0, sats: 0 }

  // Get confirmed unspent from WoC
  await sleep(DELAY_MS)
  let unspent: WocUtxo[]
  try {
    unspent = await fetchJson(`${WOC}/address/${addr}/unspent`)
  } catch {
    return { ok: false, utxos: 0, sats: 0 }
  }

  // Filter confirmed only (height > 0)
  const confirmed = unspent.filter(u => u.height > 0)
  if (confirmed.length === 0) {
    // Also try unconfirmed — some might be valid in mempool
    // But for safety, only use confirmed
    return { ok: false, utxos: 0, sats: 0 }
  }

  // Group by parent txid to minimize hex fetches
  const byTxid: Record<string, WocUtxo[]> = {}
  for (const u of confirmed) {
    if (!byTxid[u.tx_hash]) byTxid[u.tx_hash] = []
    byTxid[u.tx_hash].push(u)
  }

  // Fetch rawTxHex per unique parent
  const utxos: Array<{ txid: string; vout: number; satoshis: number; rawTxHex: string }> = []
  for (const [txid, group] of Object.entries(byTxid)) {
    try {
      const hex = await getRawHex(txid)
      if (!hex || hex.length < 20) continue
      for (const u of group) {
        utxos.push({ txid: u.tx_hash, vout: u.tx_pos, satoshis: u.value, rawTxHex: hex })
      }
    } catch {
      // Skip unfetchable TX
    }
  }

  if (utxos.length === 0) return { ok: false, utxos: 0, sats: 0 }

  // Write recovered wallet
  const totalSats = utxos.reduce((s, u) => s + u.satoshis, 0)
  const recovered = {
    agent: wallet.agent || name,
    address: wallet.address,
    privKeyHex: wallet.privKeyHex,
    utxos,
    index: 0,
    stats: { ...wallet.stats, recoveredAt: new Date().toISOString(), recoveredUtxos: utxos.length },
  }
  writeFileSync(path, JSON.stringify(recovered, null, 2))
  return { ok: true, utxos: utxos.length, sats: totalSats }
}

async function main() {
  const prefixes = PREFIX === 'all'
    ? ['ranger-', 'agent-', 'scribe-', 'psalm-', 'cls-', 'wis-']
    : [PREFIX.endsWith('-') ? PREFIX : PREFIX + '-']

  const files = readdirSync(WALLET_DIR)
    .filter(f => f.endsWith('.json') && prefixes.some(p => f.startsWith(p)))
    .map(f => f.replace('.json', ''))
    .sort()

  console.log(`[recovery] ${files.length} wallets matching prefix="${PREFIX}"`)

  let recovered = 0, failed = 0, totalSats = 0, totalUtxos = 0
  const start = Date.now()

  for (let i = 0; i < files.length; i++) {
    const name = files[i]
    try {
      const r = await recoverWallet(name)
      if (r.ok) {
        recovered++
        totalSats += r.sats
        totalUtxos += r.utxos
        if (recovered % 10 === 0) {
          const elapsed = ((Date.now() - start) / 1000).toFixed(0)
          console.log(`  [${i + 1}/${files.length}] recovered=${recovered} utxos=${totalUtxos} sats=${totalSats.toLocaleString()} elapsed=${elapsed}s`)
        }
      } else {
        failed++
        if (failed <= 5) console.log(`  ⚠ ${name}: no confirmed UTXOs`)
      }
    } catch (e: any) {
      failed++
      if (failed <= 5) console.log(`  ✗ ${name}: ${e.message}`)
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(0)
  console.log(`\n[recovery] DONE`)
  console.log(`  recovered: ${recovered}/${files.length}`)
  console.log(`  failed (no confirmed UTXOs): ${failed}`)
  console.log(`  total UTXOs: ${totalUtxos}`)
  console.log(`  total sats: ${totalSats.toLocaleString()}`)
  console.log(`  time: ${elapsed}s`)
}

main().catch(e => { console.error('[recovery] FATAL:', e.message); process.exit(1) })
