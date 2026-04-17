/**
 * Loader for .wallets-services.json — each marketplace service has its
 * own BSV testnet wallet so payments flow on-chain to the right place.
 */
import { readFileSync, existsSync } from 'fs'

interface ServiceWallet {
  hex: string
  address: string
  publicKey: string
}

const FILE = '.wallets-services.json'

let cache: Record<string, ServiceWallet> | null = null

function load(): Record<string, ServiceWallet> {
  if (cache) return cache
  if (!existsSync(FILE)) {
    throw new Error(`${FILE} not found — run: npx tsx scripts/setup-service-wallets.ts`)
  }
  cache = JSON.parse(readFileSync(FILE, 'utf-8'))
  return cache!
}

export function getServiceWallet(name: string): ServiceWallet {
  const all = load()
  const w = all[name]
  if (!w) throw new Error(`No wallet for service "${name}" in ${FILE}`)
  return w
}

export function listServiceWallets(): Record<string, ServiceWallet> {
  return load()
}
