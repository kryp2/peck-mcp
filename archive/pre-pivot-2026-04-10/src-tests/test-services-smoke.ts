/**
 * Smoke test for all 5 real services.
 * Boots each ServiceAgent in-process, fires 1+ real API calls per
 * capability, prints concise pass/fail.
 *
 * Run: npx tsx src/test-services-smoke.ts
 */
import './agents/weather.js'      // port 3002
import './agents/translate.js'    // port 3001
import './agents/summarize.js'    // port 3003
import './agents/price.js'        // port 3004
import './agents/geocode.js'      // port 3005

const HEADERS = {
  'Content-Type': 'application/json',
  'X-Payment-Tx': 'demo-bypass',  // ServiceAgent trusts any payment header
}

interface Test {
  name: string
  port: number
  capability: string
  body: any
  validate: (r: any) => string | null  // null = pass, string = error msg
}

const tests: Test[] = [
  {
    name: 'weather: get-weather Oslo',
    port: 3002,
    capability: 'get-weather',
    body: { location: 'Oslo' },
    validate: r => typeof r.temperature_c === 'number' ? null : `bad temperature_c: ${r.temperature_c}`,
  },
  {
    name: 'weather: forecast Bergen 3 days',
    port: 3002,
    capability: 'forecast',
    body: { location: 'Bergen', days: 3 },
    validate: r => r.forecast?.length === 3 ? null : `bad forecast length: ${r.forecast?.length}`,
  },
  {
    name: 'translate: en→no "hello world"',
    port: 3001,
    capability: 'translate',
    body: { text: 'hello world', sourceLang: 'en', targetLang: 'no' },
    validate: r => r.translated_text && !r.translated_text.startsWith('[Translated')
      ? null : `looks fake: ${r.translated_text}`,
  },
  {
    name: 'price: BSV/BTC/ETH in USD',
    port: 3004,
    capability: 'crypto-price',
    body: { coins: ['bitcoin-cash-sv', 'bitcoin', 'ethereum'], currencies: ['usd'] },
    validate: r => r.prices?.['bitcoin']?.usd ? null : `no btc price: ${JSON.stringify(r.prices)}`,
  },
  {
    name: 'price: USD→NOK fx rate',
    port: 3004,
    capability: 'fx-rate',
    body: { base: 'usd', targets: ['nok', 'eur'] },
    validate: r => r.rates?.nok && r.rates?.eur ? null : `no rates: ${JSON.stringify(r.rates)}`,
  },
  {
    name: 'geocode: forward "Oslo"',
    port: 3005,
    capability: 'geocode',
    body: { location: 'Oslo' },
    validate: r => r.results?.[0]?.latitude ? null : `no results: ${JSON.stringify(r)}`,
  },
  {
    name: 'summarize: text extractive',
    port: 3003,
    capability: 'summarize-text',
    body: {
      text: 'Bitcoin SV is a cryptocurrency. It restored the original Bitcoin protocol. ' +
            'It supports unbounded blocks and on-chain data. Many companies build apps on BSV. ' +
            'It uses proof of work for consensus. Transactions are very cheap. ' +
            'BSV stands for Bitcoin Satoshi Vision. It launched in November 2018.'
    },
    validate: r => r.summary && r.summarization_method ? null : `bad summary: ${JSON.stringify(r)}`,
  },
]

async function main() {
  // Wait for all servers to bind
  await new Promise(r => setTimeout(r, 800))

  let pass = 0, fail = 0
  for (const t of tests) {
    process.stdout.write(`  ${t.name.padEnd(45)} `)
    try {
      const res = await fetch(`http://localhost:${t.port}/${t.capability}`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(t.body),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const err = t.validate(data)
      if (err) { fail++; console.log(`❌ ${err}`); continue }
      pass++
      console.log(`✅`)
      // Show a snippet of real data
      const snippet = JSON.stringify(data).slice(0, 110)
      console.log(`     → ${snippet}${snippet.length >= 110 ? '…' : ''}`)
    } catch (e) {
      fail++
      console.log(`❌ ${String(e).slice(0, 100)}`)
    }
  }

  console.log(`\n=== ${pass}/${pass + fail} services real and working ===`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
