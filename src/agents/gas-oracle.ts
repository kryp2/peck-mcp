/**
 * AP5D-3 — Cross-chain gas/fee oracle.
 *
 * Live comparison: how much would this computation cost on
 * Ethereum, Solana, vs Peck Pay (BSV)? Returns side-by-side numbers
 * that prove BSV is orders of magnitude cheaper.
 *
 * Sources (all free, no API keys):
 *   - Ethereum gas:   blocknative public mempool feed (or fallback static)
 *   - ETH/SOL price:  CoinGecko free API
 *   - BSV fee:        TAAL ARC policy endpoint (1 sat/byte ~ default)
 *
 * Pricing: 50 sat per call. Headline pitch agent for the marketplace.
 */
import { BrcServiceAgent } from '../brc-service-agent.js'

const agent = new BrcServiceAgent({
  name: 'gas-oracle-agent',
  walletName: 'gas-oracle',
  description: 'Live cross-chain gas/fee comparison: Ethereum vs Solana vs BSV',
  pricePerCall: 50,
  capabilities: ['compare-gas', 'eth-gas', 'savings-vs-bsv'],
  port: 3012,
})

interface PriceQuote { eth_usd: number; bsv_usd: number; sol_usd: number }

let cachedPrices: { quote: PriceQuote; ts: number } | null = null

async function fetchPrices(): Promise<PriceQuote> {
  if (cachedPrices && Date.now() - cachedPrices.ts < 60_000) return cachedPrices.quote
  const r = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin-cash-sv,solana&vs_currencies=usd'
  )
  if (!r.ok) throw new Error(`coingecko HTTP ${r.status}`)
  const data = await r.json() as any
  const quote: PriceQuote = {
    eth_usd: data.ethereum?.usd || 3500,
    bsv_usd: data['bitcoin-cash-sv']?.usd || 70,
    sol_usd: data.solana?.usd || 150,
  }
  cachedPrices = { quote, ts: Date.now() }
  return quote
}

interface EthGas { base_gwei: number; priority_gwei: number; total_gwei: number; source: string }

async function fetchEthGas(): Promise<EthGas> {
  // Try blocknative free public endpoint first; fall back to a sane default.
  try {
    const r = await fetch('https://api.etherscan.io/api?module=gastracker&action=gasoracle')
    if (r.ok) {
      const data = await r.json() as any
      const base = parseFloat(data.result?.suggestBaseFee || '20')
      const fast = parseFloat(data.result?.FastGasPrice || '30')
      return {
        base_gwei: base,
        priority_gwei: Math.max(0, fast - base),
        total_gwei: fast,
        source: 'etherscan.io',
      }
    }
  } catch { /* fall through */ }

  // Static fallback — realistic 2025/2026 averages
  return { base_gwei: 20, priority_gwei: 2, total_gwei: 22, source: 'static-fallback' }
}

agent.handle('eth-gas', async () => {
  const gas = await fetchEthGas()
  const prices = await fetchPrices()
  return {
    gas,
    eth_usd: prices.eth_usd,
    cost_per_million_gas_usd: (1_000_000 * gas.total_gwei * 1e-9) * prices.eth_usd,
    fetched_at: new Date().toISOString(),
  }
})

agent.handle('compare-gas', async (req) => {
  // Default: realistic ERC-20 transfer (50K gas) and a complex DeFi call (300K gas).
  const ethGasUsed = req.gasUsed || req.erc20Bytes || 50_000
  const gas = await fetchEthGas()
  const prices = await fetchPrices()

  // Ethereum cost
  const ethCostUsd = (ethGasUsed * gas.total_gwei * 1e-9) * prices.eth_usd

  // Solana cost: ~0.000005 SOL per signature (very stable)
  const solCostUsd = 0.000005 * prices.sol_usd

  // BSV cost via Peck Pay: 100 sat per evm-compute call
  const bsvCostSat = 100
  const bsvCostUsd = (bsvCostSat * 1e-8) * prices.bsv_usd

  return {
    workload: { eth_gas_used: ethGasUsed },
    ethereum: {
      gas_price_gwei: gas.total_gwei,
      cost_usd: +ethCostUsd.toFixed(6),
      source: gas.source,
    },
    solana: {
      cost_usd: +solCostUsd.toFixed(8),
    },
    peck_pay_bsv: {
      cost_sat: bsvCostSat,
      cost_usd: +bsvCostUsd.toFixed(8),
    },
    savings_vs_ethereum: `${(ethCostUsd / bsvCostUsd).toFixed(0)}×`,
    savings_vs_solana: `${(solCostUsd / bsvCostUsd).toFixed(0)}×`,
    fetched_at: new Date().toISOString(),
  }
})

agent.handle('savings-vs-bsv', async (req) => {
  const ethGasUsed = req.gasUsed || 50_000
  const gas = await fetchEthGas()
  const prices = await fetchPrices()
  const ethCostUsd = (ethGasUsed * gas.total_gwei * 1e-9) * prices.eth_usd
  const bsvCostUsd = (100 * 1e-8) * prices.bsv_usd
  const factor = ethCostUsd / bsvCostUsd
  return {
    eth_cost_usd: +ethCostUsd.toFixed(6),
    peck_pay_cost_usd: +bsvCostUsd.toFixed(8),
    savings_factor: `${factor.toFixed(0)}×`,
    headline: `Peck Pay is ${factor.toFixed(0)}× cheaper than Ethereum for ${ethGasUsed} gas of computation`,
  }
})

agent.start()
