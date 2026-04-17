/**
 * M7 — TAAL ARC integration (testnet + mainnet readiness).
 *
 * Steps:
 *   1. Verify TAAL_TESTNET_KEY is set
 *   2. Sanity broadcast on testnet via TAAL ARC (single tx, OP_RETURN)
 *   3. Generate mainnet wallet if missing → save .wallets-mainnet.json
 *   4. Print mainnet address(es) for user funding
 *   5. If mainnet already funded, sync + (optionally) broadcast 1 mainnet tx
 *
 * Run:  node --env-file=.env --import tsx src/test-m7-arc.ts
 *   or  npx tsx --env-file=.env src/test-m7-arc.ts
 */
import { PrivateKey, Transaction } from '@bsv/sdk'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { UTXOManager } from './utxo-manager.js'

const MAINNET_FILE = '.wallets-mainnet.json'

interface MainnetWallets {
  gateway: { hex: string; address: string; publicKey: string }
  worker: { hex: string; address: string; publicKey: string }
  network: 'mainnet'
  created: string
}

function makeMainnetWallets(): MainnetWallets {
  const make = (label: string) => {
    const k = PrivateKey.fromRandom()
    return {
      hex: k.toHex(),
      address: k.toAddress('mainnet'),
      publicKey: k.toPublicKey().toString(),
    }
  }
  return {
    gateway: make('gateway'),
    worker: make('worker'),
    network: 'mainnet',
    created: new Date().toISOString(),
  }
}

async function loadOutpoint(mgr: UTXOManager, txid: string, vout: number): Promise<number> {
  const r = await fetch(`https://api.whatsonchain.com/v1/bsv/test/tx/${txid}/hex`)
  if (!r.ok) throw new Error(`fetch hex failed: ${r.status}`)
  const tx = Transaction.fromHex(await r.text())
  const sats = tx.outputs[vout].satoshis ?? 0
  mgr.addFromTx(tx, txid, vout, sats)
  return sats
}

async function main() {
  // === 1) Check ARC keys ===
  console.log('=== TAAL ARC env ===')
  const tKey = process.env.TAAL_TESTNET_KEY
  const mKey = process.env.TAAL_MAINNET_KEY
  console.log(`testnet key: ${tKey ? '✅ ' + tKey.slice(0, 18) + '…' : '❌ missing'}`)
  console.log(`mainnet key: ${mKey ? '✅ ' + mKey.slice(0, 18) + '…' : '❌ missing'}`)
  if (!tKey) { console.error('Set TAAL_TESTNET_KEY in .env'); process.exit(1) }

  // === 2) Testnet sanity broadcast via TAAL ARC ===
  console.log('\n=== testnet ARC sanity broadcast ===')
  const wallets = JSON.parse(readFileSync('.wallets.json', 'utf-8'))
  const gwKey = PrivateKey.fromHex(wallets.gateway.hex)
  const mgr = new UTXOManager(gwKey, 'test')

  // Use the freshest possible UTXO from /unspent (largest)
  const unspentRes = await fetch(`https://api.whatsonchain.com/v1/bsv/test/address/${wallets.gateway.address}/unspent`)
  const unspent = await unspentRes.json() as Array<{ tx_hash: string; tx_pos: number; value: number; height: number }>
  unspent.sort((a, b) => b.value - a.value)
  const seed = unspent.find(u => u.value > 5000) || unspent[0]
  console.log(`seed: ${seed.tx_hash}:${seed.tx_pos} = ${seed.value} sat (h=${seed.height})`)
  await loadOutpoint(mgr, seed.tx_hash, seed.tx_pos)

  try {
    const t0 = Date.now()
    const { tx, txid } = await mgr.buildTx(wallets.worker1.address, 100, { kind: 'm7-arc-test' })
    const ms = Date.now() - t0
    console.log(`built in ${ms}ms, broadcasting via TAAL ARC…`)

    const t1 = Date.now()
    const broadcastTxid = await mgr.broadcastNow(tx)
    console.log(`✅ ARC accepted in ${Date.now() - t1}ms`)
    console.log(`   txid: ${broadcastTxid}`)
    console.log(`   https://test.whatsonchain.com/tx/${broadcastTxid}`)
  } catch (e) {
    console.error(`❌ testnet ARC broadcast failed: ${String(e).slice(0, 300)}`)
    // Don't bail — still want to do mainnet setup
  }

  // === 3) Mainnet wallet ===
  console.log('\n=== mainnet wallet ===')
  let mwallets: MainnetWallets
  if (existsSync(MAINNET_FILE)) {
    mwallets = JSON.parse(readFileSync(MAINNET_FILE, 'utf-8'))
    console.log('Loaded existing mainnet wallets')
  } else {
    mwallets = makeMainnetWallets()
    writeFileSync(MAINNET_FILE, JSON.stringify(mwallets, null, 2))
    console.log(`✨ Created new mainnet wallets → ${MAINNET_FILE}`)
  }
  console.log(`  gateway: ${mwallets.gateway.address}`)
  console.log(`  worker:  ${mwallets.worker.address}`)

  // === 4) Mainnet balance check ===
  console.log('\n=== mainnet balance ===')
  const r = await fetch(`https://api.whatsonchain.com/v1/bsv/main/address/${mwallets.gateway.address}/balance`)
  const bal = await r.json() as { confirmed: number; unconfirmed: number }
  const total = bal.confirmed + bal.unconfirmed
  console.log(`gateway balance: ${total} sat (${bal.confirmed} conf, ${bal.unconfirmed} unconf)`)

  if (total === 0) {
    console.log('\n👉 FUND THIS MAINNET ADDRESS to enable M7 mainnet broadcast:')
    console.log(`     ${mwallets.gateway.address}`)
    console.log('   (≥2000 sat is enough — about $0.001)')
    console.log('   Then re-run: npx tsx --env-file=.env src/test-m7-arc.ts')
  } else if (mKey) {
    console.log('\n=== mainnet ARC sanity broadcast ===')
    const mainKey = PrivateKey.fromHex(mwallets.gateway.hex)
    const mainMgr = new UTXOManager(mainKey, 'main')
    await mainMgr.initialSync()
    console.log(`mainnet balance loaded: ${mainMgr.balance} sat`)
    if (mainMgr.balance < 500) {
      console.log('balance too low, skipping mainnet broadcast')
    } else {
      try {
        const { tx, txid } = await mainMgr.buildTx(mwallets.worker.address, 100, { kind: 'm7-mainnet-first' })
        await mainMgr.broadcastNow(tx)
        console.log(`✅ MAINNET broadcast: ${txid}`)
        console.log(`   https://whatsonchain.com/tx/${txid}`)
      } catch (e) {
        console.error(`❌ mainnet broadcast failed: ${String(e).slice(0, 300)}`)
      }
    }
  } else {
    console.log('TAAL_MAINNET_KEY missing — skipping mainnet broadcast')
  }

  process.exit(0)
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })
