/**
 * Demo shopper — uses one BRC wallet to walk the marketplace and pay for
 * a random capability every INTERVAL_MS ms. Watch the events live in
 * the registry dashboard at http://localhost:8080.
 *
 * Run alongside brc-marketplace-daemon.
 */
import 'dotenv/config'
import { BrcClient } from './brc-client.js'

const REGISTRY_URL = process.env.REGISTRY_URL || 'http://localhost:8080'
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS || '4000', 10)
const BUYER = process.env.BUYER || 'gateway'

interface Catalog {
  id: string
  endpoint: string
  capabilities: string[]
  pricePerCall: number
  identityKey: string
}

const SAMPLE_BODIES: Record<string, any> = {
  'get-weather': () => ({ location: pick(['Oslo','Bergen','Trondheim','Tromsø','Stavanger','Drammen']) }),
  'forecast':    () => ({ location: pick(['Oslo','Bergen','Trondheim']), days: 3 }),
  'translate':   () => ({ text: pick(['hello agent','good morning','what time is it','BSV is fast']), sourceLang:'en', targetLang:'no' }),
  'detect-language': () => ({ text: pick(['Vær så god','God morgen','Bonjour le monde','Guten Tag']) }),
  'summarize-text':  () => ({ text: 'Bitcoin SV restored the original protocol. It scales by removing arbitrary block size limits. Many companies now build apps on top of BSV. Transaction fees are sub-cent. The chain supports massive on-chain data.' }),
  'crypto-price':    () => ({ coins: ['bitcoin-cash-sv','bitcoin','ethereum'], currencies: ['usd','nok'] }),
  'fx-rate':         () => ({ base: 'usd', targets: ['nok','eur','gbp'] }),
  'geocode':         () => ({ location: pick(['Oslo','Bergen','Trondheim','Stockholm','Helsinki']) }),
  'reverse-geocode': () => ({ lat: 59.9127, lon: 10.7461 }),
  'execute': (svcId: string) => svcId === 'evm-compute'
    ? { bytecode: '60056007016000526020600000f3' }
    : { wasm_base64: 'AGFzbQEAAAABBwFgAn9/AX8DAgEABwcBA2FkZAAACgkBBwAgACABags=', function_name: 'add', args: [Math.floor(Math.random()*100), Math.floor(Math.random()*100)] },
  'compare-gas':    () => ({ gasUsed: pick([21000, 50000, 150000, 300000]) }),
  'savings-vs-bsv': () => ({ gasUsed: pick([50000, 100000, 200000]) }),
  'recent':         () => ({ limit: 5 }),
  'stats':          () => ({}),
}

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)] }

async function main() {
  const buyer = new BrcClient(BUYER)
  await buyer.ready()
  console.log(`shopper: ${BUYER} (${buyer.identityKey.slice(0,18)}…)`)

  // Fetch catalog
  const r = await fetch(`${REGISTRY_URL}/marketplace`)
  const catalog = await r.json() as Catalog[]
  console.log(`catalog: ${catalog.length} services`)

  // Build flat list of (svc, cap) pairs we know how to call
  const calls: Array<{ svc: Catalog; capability: string }> = []
  for (const svc of catalog) {
    for (const cap of svc.capabilities) {
      if (SAMPLE_BODIES[cap]) calls.push({ svc, capability: cap })
    }
  }
  console.log(`callable: ${calls.length} (svc, capability) pairs`)
  console.log(`firing one call every ${INTERVAL_MS}ms — Ctrl+C to stop\n`)

  let n = 0
  setInterval(async () => {
    n++
    const choice = pick(calls)
    const bodyFn = SAMPLE_BODIES[choice.capability]
    const body = typeof bodyFn === 'function' ? bodyFn(choice.svc.id) : bodyFn
    const t0 = Date.now()
    try {
      const result = await buyer.call(choice.svc.endpoint, choice.capability, body)
      const snippet = JSON.stringify(result.result).slice(0, 70)
      console.log(`#${n.toString().padStart(3)} ✅ ${choice.svc.id}/${choice.capability.padEnd(15)} ${result.price}sat ${result.durationMs}ms tx=${result.paymentTxid.slice(0,12)}…  ${snippet}`)
    } catch (e: any) {
      console.log(`#${n.toString().padStart(3)} ❌ ${choice.svc.id}/${choice.capability.padEnd(15)} ${String(e).slice(0,100)}`)
    }
  }, INTERVAL_MS)
}

main().catch(e => { console.error(e); process.exit(1) })
