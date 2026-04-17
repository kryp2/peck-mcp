/**
 * BRC-100 wallet factory.
 *
 * Creates a fully self-contained programmatic wallet for any agent in the
 * marketplace via @bsv/wallet-toolbox + local SQLite storage. Every agent
 * has its own identity, its own UTXO database, and its own wallet instance.
 *
 * Pattern is the canonical Setup.createWalletSQLite — same as
 * peck-to/metanet-agent-wallet's WalletSigner setup, but local-storage.
 */
import 'dotenv/config'
import { Setup, StorageKnex } from '@bsv/wallet-toolbox'
import type { SetupWalletKnex } from '@bsv/wallet-toolbox'
import { Random } from '@bsv/sdk'
import { readFileSync, existsSync, mkdirSync } from 'fs'

/** Bytes-per-1000 fee charged to ensure miner inclusion (BSV minimum policy is ~50). */
const FEE_SAT_PER_KB = parseInt(process.env.PECKPAY_FEE_SAT_PER_KB || '100', 10)

function randomBytesHex(n: number): string {
  return Random(n).map(b => b.toString(16).padStart(2, '0')).join('')
}

const REGISTRY_FILE = '.brc-identities.json'

interface AgentIdentity {
  privKeyHex: string
  identityKey: string
  filePath: string
}

let cachedRegistry: Record<string, AgentIdentity> | null = null

function loadRegistry(): Record<string, AgentIdentity> {
  if (cachedRegistry) return cachedRegistry
  if (!existsSync(REGISTRY_FILE)) {
    throw new Error(`${REGISTRY_FILE} missing — run: npx tsx scripts/setup-brc-wallets.ts`)
  }
  cachedRegistry = JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'))
  return cachedRegistry!
}

export function getAgentIdentity(name: string): AgentIdentity {
  const reg = loadRegistry()
  const ident = reg[name]
  if (!ident) throw new Error(`No BRC identity registered for "${name}"`)
  return ident
}

export function listAgents(): string[] {
  return Object.keys(loadRegistry())
}

const walletCache: Map<string, Promise<SetupWalletKnex>> = new Map()

/**
 * Get (or create) the BRC-100 Wallet for a given agent.
 * Cached per process so repeated calls return the same instance.
 */
export function getWallet(agentName: string, chain: 'test' | 'main' = 'test'): Promise<SetupWalletKnex> {
  const key = `${chain}:${agentName}`
  if (walletCache.has(key)) return walletCache.get(key)!

  const promise = (async () => {
    const ident = getAgentIdentity(agentName)
    if (!existsSync('.wallet-storage')) mkdirSync('.wallet-storage')

    const env = Setup.getEnv(chain)

    // Bypass Setup.createWalletSQLite so we can override feeModel.
    // The default helper hardcodes 1 sat/kb which is below mainnet relay
    // policy — we use 100 sat/kb to guarantee miner inclusion.
    const wo = await Setup.createWallet({
      env,
      rootKeyHex: ident.privKeyHex,
    })
    const knex = Setup.createSQLiteKnex(ident.filePath)
    const storage = new StorageKnex({
      chain: wo.chain,
      knex,
      commissionSatoshis: 0,
      commissionPubKeyHex: undefined,
      feeModel: { model: 'sat/kb', value: FEE_SAT_PER_KB },
    })
    await storage.migrate(agentName, randomBytesHex(33))
    await storage.makeAvailable()
    await wo.storage.addWalletStorageProvider(storage)
    const { user } = await storage.findOrInsertUser(wo.identityKey)

    const setup: SetupWalletKnex = {
      ...wo,
      activeStorage: storage,
      userId: user.userId,
    }
    return setup
  })()

  walletCache.set(key, promise)
  return promise
}

/**
 * Convenience: just the Wallet instance (without storage etc).
 */
export async function getWalletInstance(agentName: string, chain: 'test' | 'main' = 'test') {
  const setup = await getWallet(agentName, chain)
  return setup.wallet
}

/**
 * Returns the public BRC-100 identity (pubkey hex) of an agent.
 * This is what other agents use to identify and pay this agent.
 */
export function getIdentityKey(agentName: string): string {
  return getAgentIdentity(agentName).identityKey
}
