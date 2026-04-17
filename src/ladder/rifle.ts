/**
 * PaymentRifle — the hot path. Takes one pre-built leaf, builds a 1-in
 * 1-out P2PKH transaction, signs it, broadcasts directly to ARC, marks
 * the leaf as fired. No wallet-toolbox, no createAction, no SQLite write
 * lock contention beyond the leaf-claim transaction.
 *
 * Per-shot end-to-end budget: ~30-100ms (signing ~1ms + ARC ~30-100ms).
 *
 * Each shot is a complete, independent on-chain transaction. There is no
 * change output — the input value is split exactly between the recipient
 * payment and the miner fee.
 */
import { Transaction, P2PKH, PrivateKey, Script, OP } from '@bsv/sdk'
import { LadderDB, LeafRow } from './db.js'
import { arcBroadcast, type Network } from './arc.js'

export interface RifleConfig {
  agentName: string         // matches owner_agent in DB
  ownerKey: PrivateKey      // unlocks all leaves owned by this agent
  network?: Network
  db: LadderDB
}

export interface ShotResult {
  txid: string
  shotLeaf: { txid: string; vout: number; satoshis: number }
  paymentSats: number
  feeSats: number
  durationMs: number
  endpoint: string
}

export class PaymentRifle {
  private network: Network

  constructor(private cfg: RifleConfig) {
    this.network = cfg.network ?? 'test'
  }

  /**
   * Fire one shot to a recipient address. Optionally include an OP_RETURN
   * with arbitrary data (e.g. a 32-byte commitment hash linking the on-chain
   * tx to a specific off-chain service call). Returns the broadcast txid.
   *
   * When opReturnData is provided, the tx becomes 1-in 2-out (payment +
   * OP_FALSE OP_RETURN <data>). The leaf must hold enough satoshis to
   * cover both payment + the slightly larger fee (~25 sat extra for a
   * 32-byte commitment).
   */
  async fire(
    recipientAddress: string,
    paymentSats: number,
    opReturnData?: Buffer,
  ): Promise<ShotResult> {
    const t0 = Date.now()

    // 1. Claim a leaf atomically
    const leaf = await this.cfg.db.claimLeaf(this.cfg.agentName)
    if (!leaf) throw new Error(`agent ${this.cfg.agentName} is out of ammo`)

    if (leaf.satoshis <= paymentSats) {
      await this.cfg.db.releaseLeaf(leaf.txid, leaf.vout)
      throw new Error(
        `leaf ${leaf.txid}:${leaf.vout} only holds ${leaf.satoshis} sat, cannot cover ${paymentSats} payment + fee`
      )
    }

    try {
      // 2. Load the parent setup tx so we can build the input correctly.
      // The hex was cached at build-time so this is one local DB read, no network.
      const parentHex = await this.cfg.db.getSetupTxHex(leaf.txid)
      if (!parentHex) {
        throw new Error(`no cached setup tx for leaf ${leaf.txid}:${leaf.vout}`)
      }
      const parentTx = Transaction.fromHex(parentHex)

      // 3. Build the 1-in-1-out shot tx
      const tx = new Transaction()
      tx.addInput({
        sourceTransaction: parentTx,
        sourceOutputIndex: leaf.vout,
        unlockingScriptTemplate: new P2PKH().unlock(this.cfg.ownerKey),
      })
      tx.addOutput({
        lockingScript: new P2PKH().lock(recipientAddress),
        satoshis: paymentSats,
      })
      // Optional OP_RETURN commitment — proves this on-chain tx is bound
      // to a specific off-chain service call (request_id, etc).
      if (opReturnData && opReturnData.length > 0) {
        const opReturnScript = new Script()
        opReturnScript.writeOpCode(OP.OP_FALSE)
        opReturnScript.writeOpCode(OP.OP_RETURN)
        opReturnScript.writeBin(Array.from(opReturnData))
        tx.addOutput({
          lockingScript: opReturnScript,
          satoshis: 0,
        })
      }
      // No change output. Fee = leaf.satoshis - paymentSats (set implicitly).
      await tx.sign()

      const txid = tx.id('hex') as string
      const rawHex = tx.toHex()
      const feeSats = leaf.satoshis - paymentSats

      // 4. Broadcast direct to ARC
      const result = await arcBroadcast(rawHex, this.network)
      if (!result.alreadyKnown && !result.txid) {
        throw new Error(`ARC accepted but returned no txid (status ${result.status})`)
      }

      // 5. Mark the leaf as fired with the resulting txid
      await this.cfg.db.markFired(leaf.txid, leaf.vout, txid)

      return {
        txid,
        shotLeaf: { txid: leaf.txid, vout: leaf.vout, satoshis: leaf.satoshis },
        paymentSats,
        feeSats,
        durationMs: Date.now() - t0,
        endpoint: result.endpoint,
      }
    } catch (e) {
      // Broadcast or build failed — release the leaf so it can be retried
      await this.cfg.db.releaseLeaf(leaf.txid, leaf.vout)
      throw e
    }
  }

  async remainingAmmo(): Promise<number> {
    const s = await this.cfg.db.stats(this.cfg.agentName)
    return s.remaining
  }
}
