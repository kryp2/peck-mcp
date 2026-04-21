#!/usr/bin/env npx tsx
/**
 * Function Marketplace Demo — Bitcoin Schema functions as THE marketplace.
 *
 * Shows the complete function lifecycle:
 *   1. Service agent registers functions on-chain (Bitcoin Schema)
 *   2. Buyer agent discovers functions via Social Agent feed
 *   3. Buyer calls function → on-chain call tx → execution → on-chain response
 *   4. Every step is a Bitcoin Schema tx visible in peck.to
 *
 * This replaces the entire marketplace registry with Bitcoin Schema primitives.
 * Discovery = reading the feed. Calling = posting a function call. Payment = tx output.
 *
 * Usage:
 *   npx tsx scripts/demo-function-marketplace.ts < /dev/null
 */
import 'dotenv/config'
import { PrivateKey } from '@bsv/sdk'
import { FunctionExecutor } from '../src/v2/function-executor.js'
import { BankLocal } from '../src/clients/bank-local.js'

const bank = new BankLocal()
const SOCIAL_URL = 'http://localhost:4050'

function log(step: string, detail?: any) {
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  ${step}`)
  console.log('═'.repeat(60))
  if (detail) console.log(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2))
}

async function main() {
  console.log('\n⚡ Function Marketplace — Bitcoin Schema as THE marketplace\n')

  // ═══════════════════════════════════════════════════════════
  // SERVICE AGENT: registers and serves functions
  // ═══════════════════════════════════════════════════════════

  const serviceKey = PrivateKey.fromRandom()
  const servicePubkey = serviceKey.toPublicKey().toString()
  const executor = new FunctionExecutor(serviceKey, bank)

  // Register weather function
  const weatherTxid = await executor.register({
    name: 'weather-lookup',
    description: 'Get current weather conditions for any city worldwide. Returns temperature, conditions, humidity, wind.',
    price: 50,
    argsType: JSON.stringify({
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city'],
    }),
    handler: async (args) => {
      // Real weather API call
      const city = args.city || 'Oslo'
      try {
        const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`)
        const geoData = await geo.json()
        if (!geoData.results?.length) return { error: 'City not found', city }

        const { latitude, longitude, name } = geoData.results[0]
        const weather = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code`)
        const wData = await weather.json()

        return {
          city: name,
          temperature: `${wData.current.temperature_2m}°C`,
          humidity: `${wData.current.relative_humidity_2m}%`,
          wind: `${wData.current.wind_speed_10m} km/h`,
          weather_code: wData.current.weather_code,
        }
      } catch (e: any) {
        return { error: e.message, city }
      }
    },
  })
  log('1. REGISTER: weather-lookup @ 50 sat', {
    txid: weatherTxid,
    provider: servicePubkey.slice(0, 20) + '…',
    explorer: `https://test.whatsonchain.com/tx/${weatherTxid}`,
    note: 'This IS the marketplace listing. On-chain. Bitcoin Schema.',
  })

  // Register a summarize function
  const summarizeTxid = await executor.register({
    name: 'text-summarize',
    description: 'Summarize any text into 2-3 key bullet points. Uses AI inference.',
    price: 80,
    argsType: JSON.stringify({
      type: 'object',
      properties: { text: { type: 'string' }, max_points: { type: 'number' } },
      required: ['text'],
    }),
    handler: async (args) => {
      // Simplified summarization (in production, calls LLM)
      const text = String(args.text || '')
      const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 10)
      const points = sentences.slice(0, args.max_points || 3).map(s => s.trim())
      return {
        summary: points.join('. ') + '.',
        bullet_points: points,
        original_length: text.length,
        compressed_length: points.join(' ').length,
      }
    },
  })
  log('2. REGISTER: text-summarize @ 80 sat', {
    txid: summarizeTxid,
    explorer: `https://test.whatsonchain.com/tx/${summarizeTxid}`,
  })

  // Register an on-chain notarize function
  const notarizeTxid = await executor.register({
    name: 'notarize',
    description: 'Cryptographically timestamp any data on BSV. Returns permanent proof of existence.',
    price: 30,
    handler: async (args) => {
      const { createHash } = await import('crypto')
      const data = typeof args.data === 'string' ? args.data : JSON.stringify(args.data)
      const hash = createHash('sha256').update(data).digest('hex')
      return {
        hash,
        timestamp: new Date().toISOString(),
        data_size: data.length,
        note: args.note || null,
        proof: 'SHA-256 hash anchored on-chain in function response tx',
      }
    },
  })
  log('3. REGISTER: notarize @ 30 sat', {
    txid: notarizeTxid,
    explorer: `https://test.whatsonchain.com/tx/${notarizeTxid}`,
  })

  // Start the executor HTTP server
  await executor.startServer(4060, 'http://localhost:8080')

  // ═══════════════════════════════════════════════════════════
  // BUYER AGENT: discovers and calls functions
  // ═══════════════════════════════════════════════════════════

  log('4. DISCOVER: buyer browses feed for functions')

  // Buyer checks the Social Agent feed for functions
  const feedResp = await fetch(`${SOCIAL_URL}/feed?type=function&limit=10`)
  const feed = await feedResp.json()
  console.log(`  Found ${feed.count} registered functions:`)
  for (const item of feed.items || []) {
    console.log(`    ${item.function_name || item.tags?.join(',')} — ${item.function_price || '?'} sat`)
  }

  // Also check executor directly
  const fnList = await (await fetch('http://localhost:4060/functions')).json()
  console.log(`  Executor has ${fnList.functions.length} functions:`)
  for (const f of fnList.functions) {
    console.log(`    ${f.name} — ${f.price} sat — ${f.description.slice(0, 50)}`)
  }

  // ═══════════════════════════════════════════════════════════
  // CALL 1: Weather lookup for Oslo
  // ═══════════════════════════════════════════════════════════

  const weather = await (await fetch('http://localhost:4060/call/weather-lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args: { city: 'Oslo' } }),
  })).json()

  log('5. CALL: weather-lookup({ city: "Oslo" })', {
    result: weather.result,
    call_txid: weather.callTxid,
    response_txid: weather.responseTxid,
    execution_ms: weather.executionMs + 'ms',
    price_paid: weather.pricePaid + ' sat',
    call_explorer: weather.explorer,
    response_explorer: weather.response_explorer,
  })

  // ═══════════════════════════════════════════════════════════
  // CALL 2: Weather for Kristiansund (Thomas's påskeferie-by!)
  // ═══════════════════════════════════════════════════════════

  const weather2 = await (await fetch('http://localhost:4060/call/weather-lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args: { city: 'Kristiansund' } }),
  })).json()

  log('6. CALL: weather-lookup({ city: "Kristiansund" })', {
    result: weather2.result,
    execution_ms: weather2.executionMs + 'ms',
    call_txid: weather2.callTxid,
    response_txid: weather2.responseTxid,
  })

  // ═══════════════════════════════════════════════════════════
  // CALL 3: Summarize text
  // ═══════════════════════════════════════════════════════════

  const summary = await (await fetch('http://localhost:4060/call/text-summarize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      args: {
        text: 'The Chronicle upgrade activated on April 7, 2026, restoring opcodes like OP_CAT and OP_SUBSTR to BSV. These opcodes enable recursive covenants, which allow trustless escrow in pure Bitcoin Script. The fee math works out: covenant creation costs about 30 sat, settlement about 25 sat. Any service priced above 60 sat is profitable with covenant escrow. The CHRONICLE sighash flag enables atomic buyer-seller matching without an escrow agent.',
        max_points: 3,
      },
    }),
  })).json()

  log('7. CALL: text-summarize', {
    bullet_points: summary.result?.bullet_points,
    execution_ms: summary.executionMs + 'ms',
    call_txid: summary.callTxid,
    response_txid: summary.responseTxid,
  })

  // ═══════════════════════════════════════════════════════════
  // CALL 4: Notarize data
  // ═══════════════════════════════════════════════════════════

  const notarize = await (await fetch('http://localhost:4060/call/notarize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      args: {
        data: 'Peck Pay Bitcoin Schema marketplace demo — all function calls are on-chain Bitcoin Schema transactions',
        note: 'hackathon proof-of-concept',
      },
    }),
  })).json()

  log('8. CALL: notarize', {
    hash: notarize.result?.hash?.slice(0, 20) + '…',
    timestamp: notarize.result?.timestamp,
    call_txid: notarize.callTxid,
    response_txid: notarize.responseTxid,
  })

  // ═══════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════

  const health = await (await fetch('http://localhost:4060/health')).json()

  console.log('\n' + '═'.repeat(60))
  console.log('  ✅ Function Marketplace Demo Complete!')
  console.log('═'.repeat(60))
  console.log()
  console.log('  THE MARKETPLACE IS THE SOCIAL GRAPH:')
  console.log(`    ${health.functions.length} functions registered on-chain`)
  console.log(`    ${health.stats.calls} function calls executed`)
  console.log(`    ${health.stats.revenue} sat total revenue`)
  console.log()
  console.log('  EVERY STEP IS A BITCOIN SCHEMA TX:')
  console.log('    Register → MAP type=function name=X price=Y + AIP')
  console.log('    Call     → MAP type=function name=X args={} + AIP')
  console.log('    Response → MAP type=post context=tx tx=<call> + AIP (reply)')
  console.log()
  console.log('  ALL VISIBLE IN PECK.TO:')
  console.log('    Registrations show as function announcements')
  console.log('    Calls show as function invocations with args')
  console.log('    Responses show as replies in threads')
  console.log('    A human watching peck.to sees agents trading services in real time')
  console.log()
  console.log('  NO CUSTOM MARKETPLACE. NO REGISTRY SERVER. JUST BITCOIN SCHEMA.')
  console.log()
}

main().catch(e => { console.error('Fatal:', e.message || e); process.exit(1) })
