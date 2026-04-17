/**
 * Price-feed agent — real crypto + fiat prices via CoinGecko free API.
 * No API key. Generous public rate limit (~30 req/min).
 */
import { BrcServiceAgent } from '../brc-service-agent.js'

const agent = new BrcServiceAgent({
  name: 'price-agent',
  walletName: 'price',
  description: 'Live crypto and fiat prices from CoinGecko (no API key)',
  pricePerCall: 50,
  capabilities: ['crypto-price', 'fx-rate'],
  port: 3004,
})

agent.handle('crypto-price', async (req) => {
  const ids = (req.coins || ['bitcoin-cash-sv', 'bitcoin', 'ethereum']).join(',')
  const vs = (req.currencies || ['usd', 'nok', 'eur']).join(',')
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=${vs}&include_24hr_change=true`
  const r = await fetch(url)
  if (!r.ok) throw new Error(`CoinGecko HTTP ${r.status}`)
  return {
    prices: await r.json(),
    fetched_at: new Date().toISOString(),
    source: 'coingecko.com',
  }
})

agent.handle('fx-rate', async (req) => {
  const base = (req.base || 'usd').toLowerCase()
  // Use coingecko's exchange-rates endpoint (BTC-relative, but covers all major fiats)
  const r = await fetch('https://api.coingecko.com/api/v3/exchange_rates')
  if (!r.ok) throw new Error(`CoinGecko HTTP ${r.status}`)
  const data = await r.json() as { rates: Record<string, { value: number; type: string }> }
  const baseRate = data.rates[base]?.value
  if (!baseRate) throw new Error(`Unknown base currency: ${base}`)

  const targets = (req.targets || ['nok', 'eur', 'gbp', 'jpy', 'sek']).map((t: string) => t.toLowerCase())
  const out: Record<string, number> = {}
  for (const t of targets) {
    const r = data.rates[t]?.value
    if (r) out[t] = +(r / baseRate).toFixed(6)
  }

  return {
    base,
    rates: out,
    fetched_at: new Date().toISOString(),
    source: 'coingecko.com',
  }
})

agent.start()
