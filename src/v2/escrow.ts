/**
 * P2MS Escrow — 2-of-2 multisig between service and marketplace.
 *
 * Tier 1 escrow: held earnings model where a percentage of each service
 * payment is locked in a 2-of-2 multisig between the service operator
 * and the marketplace. Settlement requires both signatures, ensuring:
 *   - Marketplace can't steal held funds unilaterally
 *   - Service can't withdraw without marketplace approval
 *   - Slashing (sending to marketplace only) requires service misbehavior proof
 *
 * This is the non-custodial replacement for the v1 JSON-ledger.
 * Will be upgraded to Chronicle covenant (sCrypt) in Tier 2.
 *
 * Usage:
 *   const escrow = new MultisigEscrow(serviceKey, marketplaceKey)
 *   const { txid, vout } = await escrow.create(500)  // lock 500 sat
 *   const { txid } = await escrow.settle(splits)      // release to parties
 */
import { PrivateKey, PublicKey, P2PKH, Transaction, Script, OP } from '@bsv/sdk'
import { arcBroadcast, type Network } from '../ladder/arc.js'

// ============================================================================
// P2MS Script helpers
// ============================================================================

/**
 * Build a 2-of-2 multisig locking script.
 * OP_2 <pubkeyA> <pubkeyB> OP_2 OP_CHECKMULTISIG
 */
export function p2msLockingScript(pubkeyA: PublicKey, pubkeyB: PublicKey): Script {
  const s = new Script()
  s.writeOpCode(OP.OP_2)
  s.writeBin(Array.from(pubkeyA.encode(true) as number[]))
  s.writeBin(Array.from(pubkeyB.encode(true) as number[]))
  s.writeOpCode(OP.OP_2)
  s.writeOpCode(OP.OP_CHECKMULTISIG)
  return s
}

// ============================================================================
// MultisigEscrow
// ============================================================================

export interface EscrowUtxo {
  txid: string
  vout: number
  satoshis: number
  txHex: string
}

export interface SettlementSplit {
  address: string
  satoshis: number
  label: string
}

export class MultisigEscrow {
  readonly serviceKey: PrivateKey
  readonly marketplaceKey: PrivateKey
  readonly servicePub: PublicKey
  readonly marketplacePub: PublicKey
  readonly lockingScript: Script

  private utxos: EscrowUtxo[] = []

  constructor(serviceKey: PrivateKey, marketplaceKey: PrivateKey) {
    this.serviceKey = serviceKey
    this.marketplaceKey = marketplaceKey
    this.servicePub = serviceKey.toPublicKey()
    this.marketplacePub = marketplaceKey.toPublicKey()
    this.lockingScript = p2msLockingScript(this.servicePub, this.marketplacePub)
  }

  get scriptHex(): string {
    return this.lockingScript.toHex()
  }

  get totalLocked(): number {
    return this.utxos.reduce((sum, u) => sum + u.satoshis, 0)
  }

  /**
   * Create a new escrow UTXO by funding the multisig from a P2PKH input.
   */
  async create(opts: {
    funderKey: PrivateKey
    funderUtxo: { txid: string; vout: number; satoshis: number; txHex: string }
    escrowSats: number
    network?: Network
  }): Promise<EscrowUtxo> {
    const network = opts.network ?? 'test'
    const tx = new Transaction()

    const parentTx = Transaction.fromHex(opts.funderUtxo.txHex)
    tx.addInput({
      sourceTransaction: parentTx,
      sourceOutputIndex: opts.funderUtxo.vout,
      unlockingScriptTemplate: new P2PKH().unlock(opts.funderKey),
    })

    // Output 0: escrow (2-of-2 multisig)
    tx.addOutput({
      lockingScript: this.lockingScript,
      satoshis: opts.escrowSats,
    })

    // Output 1: change back to funder
    const estFee = 30
    const change = opts.funderUtxo.satoshis - opts.escrowSats - estFee
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
      throw new Error(`Escrow creation rejected: ${JSON.stringify(result)}`)
    }

    const utxo: EscrowUtxo = { txid, vout: 0, satoshis: opts.escrowSats, txHex: rawHex }
    this.utxos.push(utxo)
    return utxo
  }

  /**
   * Settle escrow — release locked funds according to splits.
   * Requires both service and marketplace signatures (2-of-2).
   *
   * Typical splits:
   *   - Normal: 70% service, 30% marketplace
   *   - Slash:  0% service, 100% marketplace (service misbehaved)
   */
  async settle(opts: {
    utxo: EscrowUtxo
    splits: SettlementSplit[]
    network?: Network
  }): Promise<{ txid: string; splits: SettlementSplit[] }> {
    const network = opts.network ?? 'test'
    const tx = new Transaction()

    const parentTx = Transaction.fromHex(opts.utxo.txHex)

    // Custom unlocking script for 2-of-2 multisig:
    // OP_0 <sig_service> <sig_marketplace>
    // (OP_0 is the dummy element for CHECKMULTISIG off-by-one bug)
    tx.addInput({
      sourceTransaction: parentTx,
      sourceOutputIndex: opts.utxo.vout,
      unlockingScriptTemplate: {
        sign: async (tx: Transaction, inputIndex: number) => {
          // Sign with both keys
          const sigService = tx.sign(this.serviceKey, undefined, inputIndex, this.lockingScript, opts.utxo.satoshis)
          const sigMarketplace = tx.sign(this.marketplaceKey, undefined, inputIndex, this.lockingScript, opts.utxo.satoshis)

          const unlockScript = new Script()
          unlockScript.writeOpCode(OP.OP_0) // dummy for CHECKMULTISIG
          unlockScript.writeBin(Array.from(sigService as any))
          unlockScript.writeBin(Array.from(sigMarketplace as any))
          return unlockScript
        },
        estimateLength: () => 150,
      },
    })

    // Add split outputs
    let totalSplit = 0
    for (const split of opts.splits) {
      tx.addOutput({
        lockingScript: new P2PKH().lock(split.address),
        satoshis: split.satoshis,
      })
      totalSplit += split.satoshis
    }

    // Fee is whatever's left after splits
    const fee = opts.utxo.satoshis - totalSplit
    if (fee < 0) {
      throw new Error(`Split total ${totalSplit} exceeds escrow ${opts.utxo.satoshis}`)
    }

    await tx.sign()
    const txid = tx.id('hex') as string
    const rawHex = tx.toHex()

    const result = await arcBroadcast(rawHex, network)
    if (!result.alreadyKnown && !result.txid) {
      throw new Error(`Settlement rejected: ${JSON.stringify(result)}`)
    }

    // Remove spent UTXO
    const idx = this.utxos.findIndex(u => u.txid === opts.utxo.txid && u.vout === opts.utxo.vout)
    if (idx >= 0) this.utxos.splice(idx, 1)

    return { txid, splits: opts.splits }
  }

  /**
   * Accumulate escrow — take a portion of a payment and lock it in escrow.
   * Used in the held-earnings model: each service call contributes a percentage
   * to the escrow rather than requiring upfront capital.
   */
  async accumulateFromPayment(opts: {
    buyerKey: PrivateKey
    buyerUtxo: { txid: string; vout: number; satoshis: number; txHex: string }
    sellerAddress: string
    sellerSats: number
    escrowSats: number
    commitmentData?: Buffer
    network?: Network
  }): Promise<{
    txid: string
    escrowVout: number
    sellerVout: number
  }> {
    const network = opts.network ?? 'test'
    const tx = new Transaction()

    const parentTx = Transaction.fromHex(opts.buyerUtxo.txHex)
    tx.addInput({
      sourceTransaction: parentTx,
      sourceOutputIndex: opts.buyerUtxo.vout,
      unlockingScriptTemplate: new P2PKH().unlock(opts.buyerKey),
    })

    // Output 0: seller payment
    tx.addOutput({
      lockingScript: new P2PKH().lock(opts.sellerAddress),
      satoshis: opts.sellerSats,
    })

    // Output 1: escrow (2-of-2 multisig)
    tx.addOutput({
      lockingScript: this.lockingScript,
      satoshis: opts.escrowSats,
    })

    // Output 2: OP_RETURN commitment (if any)
    if (opts.commitmentData) {
      const opReturn = new Script()
      opReturn.writeOpCode(OP.OP_FALSE)
      opReturn.writeOpCode(OP.OP_RETURN)
      opReturn.writeBin(Array.from(opts.commitmentData))
      tx.addOutput({ lockingScript: opReturn, satoshis: 0 })
    }

    // Output 3: change back to buyer
    const totalOutputs = opts.sellerSats + opts.escrowSats
    const estFee = 40
    const change = opts.buyerUtxo.satoshis - totalOutputs - estFee
    if (change > 15) {
      tx.addOutput({
        lockingScript: new P2PKH().lock(opts.buyerKey.toAddress('testnet') as string),
        satoshis: change,
      })
    }

    await tx.sign()
    const txid = tx.id('hex') as string
    const rawHex = tx.toHex()

    const result = await arcBroadcast(rawHex, network)
    if (!result.alreadyKnown && !result.txid) {
      throw new Error(`Escrow-accumulate tx rejected: ${JSON.stringify(result)}`)
    }

    // Track the escrow UTXO
    this.utxos.push({ txid, vout: 1, satoshis: opts.escrowSats, txHex: rawHex })

    return { txid, sellerVout: 0, escrowVout: 1 }
  }
}
