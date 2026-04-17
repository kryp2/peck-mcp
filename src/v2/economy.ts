/**
 * Tier 1 Real Economy — per-agent wallets + direct payment + payment verification.
 *
 * This is the non-custodial version of the marketplace. Each agent (buyer or
 * seller) has its own wallet keypair. Buyers pay sellers directly via P2PKH.
 * The marketplace coordinates but never touches funds.
 *
 * Key concepts:
 *   - AgentWallet: PrivateKey + address + balance tracking
 *   - DirectPayment: buyer builds a tx paying seller, includes commitment
 *   - PaymentVerification: seller checks tx actually pays them before serving
 *   - MarketplaceFee: a percentage of each call goes to marketplace via
 *     a separate output in the same tx (3-output: seller + marketplace + OP_RETURN)
 *
 * This replaces the v1 pattern where bank-local financed everything.
 */
import { PrivateKey, P2PKH, Transaction, Script, OP, Hash } from '@bsv/sdk'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { arcBroadcast, type Network } from '../ladder/arc.js'
import { createHash, randomUUID } from 'crypto'

// ============================================================================
// Agent Wallet
// ============================================================================

export interface AgentWalletData {
  hex: string
  address: string
  publicKey: string
  role: 'buyer' | 'seller' | 'marketplace'
  label: string
  createdAt: number
}

export class AgentWallet {
  readonly privateKey: PrivateKey
  readonly address: string
  readonly publicKey: string
  readonly role: 'buyer' | 'seller' | 'marketplace'
  readonly label: string

  // In-memory UTXO set for this wallet
  private utxos: Array<{
    txid: string
    vout: number
    satoshis: number
    scriptHex: string
    txHex?: string  // cached parent tx hex for signing
  }> = []

  constructor(data: AgentWalletData) {
    this.privateKey = PrivateKey.fromHex(data.hex)
    this.address = data.address
    this.publicKey = data.publicKey
    this.role = data.role
    this.label = data.label
  }

  static generate(role: 'buyer' | 'seller' | 'marketplace', label: string, network: 'testnet' | 'mainnet' = 'testnet'): AgentWallet {
    const key = PrivateKey.fromRandom()
    const address = key.toAddress(network) as string
    const publicKey = key.toPublicKey().toString()
    return new AgentWallet({
      hex: key.toHex(),
      address,
      publicKey,
      role,
      label,
      createdAt: Date.now(),
    })
  }

  toJSON(): AgentWalletData {
    return {
      hex: this.privateKey.toHex(),
      address: this.address,
      publicKey: this.publicKey,
      role: this.role,
      label: this.label,
      createdAt: Date.now(),
    }
  }

  addUtxo(txid: string, vout: number, satoshis: number, scriptHex: string, txHex?: string) {
    this.utxos.push({ txid, vout, satoshis, scriptHex, txHex })
  }

  get balance(): number {
    return this.utxos.reduce((sum, u) => sum + u.satoshis, 0)
  }

  get utxoCount(): number {
    return this.utxos.length
  }

  /**
   * Build and broadcast a payment tx.
   *
   * Creates a tx with up to 3 outputs:
   *   1. Payment to recipient (seller)
   *   2. Marketplace fee (if > 0)
   *   3. OP_RETURN commitment (optional)
   *
   * Change goes back to self if input value exceeds outputs + fee.
   */
  async pay(opts: {
    recipientAddress: string
    amountSats: number
    marketplaceAddress?: string
    marketplaceFeeSats?: number
    commitmentData?: Buffer
    network?: Network
  }): Promise<{
    txid: string
    totalSpent: number
    feeSats: number
    outputs: Array<{ type: string; address?: string; sats: number }>
  }> {
    const network = opts.network ?? 'test'
    const marketplaceFeeSats = opts.marketplaceFeeSats ?? 0

    // Calculate total needed
    const outputTotal = opts.amountSats + marketplaceFeeSats
    // Estimate fee: ~150 bytes per input + 34 per output + 10 overhead
    const estFee = Math.max(20, Math.ceil((150 + 34 * 3 + 10 + (opts.commitmentData ? 40 : 0)) * 0.1))

    // Select UTXOs (simple: take first ones until we have enough)
    const needed = outputTotal + estFee
    const selected: typeof this.utxos = []
    let inputTotal = 0
    for (const u of this.utxos) {
      selected.push(u)
      inputTotal += u.satoshis
      if (inputTotal >= needed) break
    }

    if (inputTotal < needed) {
      throw new Error(`${this.label}: insufficient funds. Have ${inputTotal} sat in ${this.utxos.length} UTXOs, need ${needed} sat`)
    }

    // Build tx
    const tx = new Transaction()

    for (const u of selected) {
      if (!u.txHex) {
        throw new Error(`${this.label}: UTXO ${u.txid}:${u.vout} has no cached parent tx hex`)
      }
      const parentTx = Transaction.fromHex(u.txHex)
      tx.addInput({
        sourceTransaction: parentTx,
        sourceOutputIndex: u.vout,
        unlockingScriptTemplate: new P2PKH().unlock(this.privateKey),
      })
    }

    const outputs: Array<{ type: string; address?: string; sats: number }> = []

    // Output 1: payment to recipient
    tx.addOutput({
      lockingScript: new P2PKH().lock(opts.recipientAddress),
      satoshis: opts.amountSats,
    })
    outputs.push({ type: 'payment', address: opts.recipientAddress, sats: opts.amountSats })

    // Output 2: marketplace fee (if any)
    if (marketplaceFeeSats > 0 && opts.marketplaceAddress) {
      tx.addOutput({
        lockingScript: new P2PKH().lock(opts.marketplaceAddress),
        satoshis: marketplaceFeeSats,
      })
      outputs.push({ type: 'marketplace_fee', address: opts.marketplaceAddress, sats: marketplaceFeeSats })
    }

    // Output 3: OP_RETURN commitment
    if (opts.commitmentData && opts.commitmentData.length > 0) {
      const opReturnScript = new Script()
      opReturnScript.writeOpCode(OP.OP_FALSE)
      opReturnScript.writeOpCode(OP.OP_RETURN)
      opReturnScript.writeBin(Array.from(opts.commitmentData))
      tx.addOutput({ lockingScript: opReturnScript, satoshis: 0 })
      outputs.push({ type: 'commitment', sats: 0 })
    }

    // Output 4: change back to self (if enough left over)
    const change = inputTotal - outputTotal - estFee
    if (change > 15) {  // dust threshold
      tx.addOutput({
        lockingScript: new P2PKH().lock(this.address),
        satoshis: change,
      })
      outputs.push({ type: 'change', address: this.address, sats: change })
    }

    await tx.sign()
    const txid = tx.id('hex') as string
    const rawHex = tx.toHex()

    // Broadcast
    const result = await arcBroadcast(rawHex, network)
    if (!result.alreadyKnown && !result.txid) {
      throw new Error(`ARC rejected: status ${result.status}`)
    }

    // Remove spent UTXOs
    for (const s of selected) {
      const idx = this.utxos.findIndex(u => u.txid === s.txid && u.vout === s.vout)
      if (idx >= 0) this.utxos.splice(idx, 1)
    }

    // Add change UTXO back
    if (change > 15) {
      const changeVout = outputs.findIndex(o => o.type === 'change')
      this.addUtxo(txid, changeVout, change, new P2PKH().lock(this.address).toHex(), rawHex)
    }

    return {
      txid,
      totalSpent: inputTotal - change,
      feeSats: inputTotal - outputTotal - (change > 15 ? change : 0),
      outputs,
    }
  }
}

// ============================================================================
// Wallet Store — persist/load all agent wallets
// ============================================================================

const WALLET_STORE_FILE = '.wallets-economy.json'

export interface WalletStore {
  marketplace: AgentWalletData
  buyers: Record<string, AgentWalletData>
  sellers: Record<string, AgentWalletData>
  createdAt: number
}

export function loadOrCreateWalletStore(buyerCount = 5, sellerNames: string[] = []): WalletStore {
  if (existsSync(WALLET_STORE_FILE)) {
    return JSON.parse(readFileSync(WALLET_STORE_FILE, 'utf-8'))
  }

  const store: WalletStore = {
    marketplace: AgentWallet.generate('marketplace', 'marketplace').toJSON(),
    buyers: {},
    sellers: {},
    createdAt: Date.now(),
  }

  // Generate buyer wallets
  for (let i = 1; i <= buyerCount; i++) {
    const label = `buyer-${i}`
    store.buyers[label] = AgentWallet.generate('buyer', label).toJSON()
  }

  // Generate seller wallets (one per service)
  for (const name of sellerNames) {
    store.sellers[name] = AgentWallet.generate('seller', name).toJSON()
  }

  writeFileSync(WALLET_STORE_FILE, JSON.stringify(store, null, 2))
  console.log(`[economy] Created ${WALLET_STORE_FILE} with ${buyerCount} buyers + ${sellerNames.length} sellers + 1 marketplace`)
  return store
}

export function loadWalletStore(): WalletStore {
  if (!existsSync(WALLET_STORE_FILE)) {
    throw new Error(`${WALLET_STORE_FILE} not found. Run setup first.`)
  }
  return JSON.parse(readFileSync(WALLET_STORE_FILE, 'utf-8'))
}

// ============================================================================
// Payment Verification — seller-side
// ============================================================================

/**
 * Verify that a tx pays the expected address the expected amount.
 * Used by sellers to confirm payment before executing work.
 *
 * In production, we'd verify via SPV proof or ARC status.
 * For hackathon, we verify the tx structure + trust ARC accepted it.
 */
export function verifyPayment(rawTxHex: string, expectedAddress: string, expectedMinSats: number): {
  valid: boolean
  paidSats: number
  error?: string
} {
  try {
    const tx = Transaction.fromHex(rawTxHex)
    const expectedScript = new P2PKH().lock(expectedAddress).toHex()

    let paidSats = 0
    for (const out of tx.outputs) {
      if (out.lockingScript?.toHex() === expectedScript) {
        paidSats += out.satoshis ?? 0
      }
    }

    if (paidSats >= expectedMinSats) {
      return { valid: true, paidSats }
    }
    return { valid: false, paidSats, error: `paid ${paidSats} sat, expected >= ${expectedMinSats}` }
  } catch (e: any) {
    return { valid: false, paidSats: 0, error: e.message }
  }
}

// ============================================================================
// Commitment — binding on-chain tx to off-chain service call
// ============================================================================

export function computeCommitment(requestId: string, serviceId: string, amountSats: number, timestamp: number): Buffer {
  const preimage = `${requestId}|${serviceId}|${amountSats}|${timestamp}`
  return createHash('sha256').update(preimage).digest()
}

// ============================================================================
// Funding helper — split a large UTXO into many small ones for agent wallets
// ============================================================================

/**
 * Fund multiple agent wallets from a single funder key.
 * Creates one tx with N outputs, one per agent.
 */
export async function fundAgents(opts: {
  funderKey: PrivateKey
  funderUtxo: { txid: string; vout: number; satoshis: number; txHex: string }
  recipients: Array<{ address: string; satoshis: number; label: string }>
  network?: Network
}): Promise<{ txid: string; funded: Array<{ label: string; address: string; satoshis: number; vout: number }> }> {
  const network = opts.network ?? 'test'
  const tx = new Transaction()

  const parentTx = Transaction.fromHex(opts.funderUtxo.txHex)
  tx.addInput({
    sourceTransaction: parentTx,
    sourceOutputIndex: opts.funderUtxo.vout,
    unlockingScriptTemplate: new P2PKH().unlock(opts.funderKey),
  })

  const funded: Array<{ label: string; address: string; satoshis: number; vout: number }> = []
  let outputTotal = 0
  for (let i = 0; i < opts.recipients.length; i++) {
    const r = opts.recipients[i]
    tx.addOutput({
      lockingScript: new P2PKH().lock(r.address),
      satoshis: r.satoshis,
    })
    funded.push({ label: r.label, address: r.address, satoshis: r.satoshis, vout: i })
    outputTotal += r.satoshis
  }

  // Change back to funder
  const estFee = Math.max(30, Math.ceil((150 + 34 * (opts.recipients.length + 1) + 10) * 0.1))
  const change = opts.funderUtxo.satoshis - outputTotal - estFee
  if (change > 15) {
    tx.addOutput({
      lockingScript: new P2PKH().lock(opts.funderKey.toAddress('testnet') as string),
      satoshis: change,
    })
  }

  await tx.sign()
  const txid = tx.id('hex') as string
  const rawHex = tx.toHex()

  const result = await arcBroadcast(rawHex, network)
  if (!result.alreadyKnown && !result.txid) {
    throw new Error(`ARC rejected funding tx: status ${result.status}`)
  }

  // Update vout references in funded array (they're already correct)
  return { txid, funded }
}
