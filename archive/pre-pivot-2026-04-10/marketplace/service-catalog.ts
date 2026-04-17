/**
 * Marketplace catalog — single source of truth for all services
 * exposed by the Peck Pay daemon. Used by:
 *   - marketplace-daemon.ts to boot + register every service
 *   - test-marketplace.ts to walk through and call each one
 */
import { getServiceWallet } from './service-wallets.js'

export interface ServiceCatalogEntry {
  id: string                      // gateway worker id
  name: string                    // human-readable name
  description: string
  port: number
  capabilities: string[]
  pricePerCall: number
  /** Path of the source file to side-effect import (boots the agent). */
  modulePath: string
  /** Sample request body for each capability — used by smoke tests + dashboard. */
  examples: Record<string, any>
}

export const CATALOG: ServiceCatalogEntry[] = [
  {
    id: 'weather',
    name: 'weather-agent',
    description: 'Real meteorological data via open-meteo (no API key)',
    port: 3002,
    capabilities: ['get-weather', 'forecast'],
    pricePerCall: 100,
    modulePath: './agents/weather.js',
    examples: {
      'get-weather': { location: 'Oslo' },
      'forecast': { location: 'Bergen', days: 3 },
    },
  },
  {
    id: 'translate',
    name: 'translate-agent',
    description: 'Real translation via MyMemory API (no API key)',
    port: 3001,
    capabilities: ['translate', 'detect-language'],
    pricePerCall: 500,
    modulePath: './agents/translate.js',
    examples: {
      'translate': { text: 'hello world', sourceLang: 'en', targetLang: 'no' },
      'detect-language': { text: 'Vær så god, dette er på norsk med æ ø å' },
    },
  },
  {
    id: 'summarize',
    name: 'summarize-agent',
    description: 'URL/text summarization via Jina Reader + extractive (or Gemini if key)',
    port: 3003,
    capabilities: ['summarize-url', 'summarize-text'],
    pricePerCall: 1000,
    modulePath: './agents/summarize.js',
    examples: {
      'summarize-text': { text: 'Bitcoin SV is a cryptocurrency. It restored the original Bitcoin protocol. It supports unbounded blocks. Many companies build apps on BSV.' },
      'summarize-url': { url: 'https://example.com' },
    },
  },
  {
    id: 'price',
    name: 'price-agent',
    description: 'Crypto and fiat prices from CoinGecko (no API key)',
    port: 3004,
    capabilities: ['crypto-price', 'fx-rate'],
    pricePerCall: 50,
    modulePath: './agents/price.js',
    examples: {
      'crypto-price': { coins: ['bitcoin-cash-sv', 'bitcoin'], currencies: ['usd', 'nok'] },
      'fx-rate': { base: 'usd', targets: ['nok', 'eur'] },
    },
  },
  {
    id: 'geocode',
    name: 'geocode-agent',
    description: 'Forward + reverse geocoding (open-meteo / Nominatim)',
    port: 3005,
    capabilities: ['geocode', 'reverse-geocode'],
    pricePerCall: 50,
    modulePath: './agents/geocode.js',
    examples: {
      'geocode': { location: 'Oslo' },
      'reverse-geocode': { lat: 59.9127, lon: 10.7461 },
    },
  },
  {
    id: 'evm-compute',
    name: 'evm-compute-agent',
    description: 'Off-chain Ethereum bytecode execution, anchored on BSV',
    port: 3010,
    capabilities: ['execute', 'execute-with-anchor'],
    pricePerCall: 100,
    modulePath: './agents/evm-compute.js',
    examples: {
      'execute': { bytecode: '60056007016000526020600000f3' }, // 5+7
    },
  },
  {
    id: 'wasm-compute',
    name: 'wasm-compute-agent',
    description: 'Sandboxed WASM execution; pay per call (~$0.000007)',
    port: 3011,
    capabilities: ['execute', 'cache-stats'],
    pricePerCall: 10,
    modulePath: './agents/wasm-compute.js',
    examples: {
      'execute': { wasm_base64: 'AGFzbQEAAAABBwFgAn9/AX8DAgEABwcBA2FkZAAACgkBBwAgACABags=', function_name: 'add', args: [2, 3] },
    },
  },
  {
    id: 'gas-oracle',
    name: 'gas-oracle-agent',
    description: 'Live gas/fee comparison: Ethereum vs Solana vs BSV (proves cost savings)',
    port: 3012,
    capabilities: ['compare-gas', 'eth-gas', 'savings-vs-bsv'],
    pricePerCall: 50,
    modulePath: './agents/gas-oracle.js',
    examples: {
      'compare-gas': { erc20Bytes: 50000 },
      'savings-vs-bsv': { gasUsed: 50000 },
    },
  },
  {
    id: 'metering',
    name: 'metering-agent',
    description: 'Tamper-proof usage metering with periodic Merkle anchoring on BSV',
    port: 3013,
    capabilities: ['record', 'recent', 'anchor', 'verify'],
    pricePerCall: 10,
    modulePath: './agents/metering.js',
    examples: {
      'recent': { limit: 10 },
      'anchor': {},
    },
  },
]

/** Compose WorkerInfo for gateway registration. */
export function makeWorkerInfo(entry: ServiceCatalogEntry) {
  const wallet = getServiceWallet(entry.id)
  return {
    id: entry.id,
    name: entry.name,
    publicKey: wallet.publicKey,
    address: wallet.address,
    endpoint: `http://localhost:${entry.port}`,
    pricePerJob: entry.pricePerCall,
    avgLatencyMs: 0,
    failCount: 0,
    lastSeen: 0,
    capabilities: entry.capabilities,
    kind: 'service' as const,
    description: entry.description,
  }
}
