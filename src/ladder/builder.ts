/**
 * Ladder builder — pre-builds N exact-fit UTXOs ("leaves") owned by one
 * private key, by splitting a single funding UTXO with one or more fanout
 * transactions.
 *
 * For now this implements the SIMPLEST possible structure: a single setup
 * transaction with N outputs of equal value. That's perfect for tiny tests
 * and small ladders. The two-level (root + branches) variant is a future
 * extension when N exceeds what fits in one tx (~3000 outputs ≈ 100KB).
 *
 * Math:
 *   leaf_value     = the satoshi amount each leaf holds (= payment + fee)
 *   funding_needed = N * leaf_value + setup_fee
 *
 * The setup tx structure is: 1 input (funding UTXO) → N leaf outputs.
 * No change output — funding UTXO must be exactly N*leaf + fee, OR we add
 * an explicit change-back output to the funder. We do the latter so the
 * funder doesn't have to know the precise fee in advance.
 */
import { Transaction, P2PKH, PrivateKey } from '@bsv/sdk'
import { LadderDB } from './db.js'
import { arcBroadcast, type Network } from './arc.js'

export interface FundingUTXO {
  txid: string
  vout: number
  satoshis: number
  sourceTransaction: Transaction  // needed for signing
}

export interface BuildLadderParams {
  funderKey: PrivateKey
  funding: FundingUTXO
  leafCount: number
  leafSats: number
  ownerAgent: string         // identifier under which leaves are recorded in DB
  ownerKey?: PrivateKey      // if different from funder; defaults to funder
  network?: Network
  db: LadderDB
}

export interface BuildLadderResult {
  setupTxid: string
  setupRawHex: string
  leavesCreated: number
  totalSpent: number
  changeReturned: number
}

export async function buildFlatLadder(params: BuildLadderParams): Promise<BuildLadderResult> {
  const network: Network = params.network ?? 'test'
  const ownerKey = params.ownerKey ?? params.funderKey
  const ownerAddress = ownerKey.toAddress(network === 'test' ? 'testnet' : 'mainnet')
  const funderAddress = params.funderKey.toAddress(network === 'test' ? 'testnet' : 'mainnet')

  const totalLeafValue = params.leafCount * params.leafSats
  if (totalLeafValue >= params.funding.satoshis) {
    throw new Error(
      `funding ${params.funding.satoshis} sat insufficient for ${params.leafCount} × ${params.leafSats} = ${totalLeafValue} sat (need fee headroom on top)`
    )
  }

  // Build the setup tx: 1 input → N leaf outputs + 1 change output
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: params.funding.sourceTransaction,
    sourceOutputIndex: params.funding.vout,
    unlockingScriptTemplate: new P2PKH().unlock(params.funderKey),
  })
  for (let i = 0; i < params.leafCount; i++) {
    tx.addOutput({
      lockingScript: new P2PKH().lock(ownerAddress),
      satoshis: params.leafSats,
    })
  }
  // Change back to funder. tx.fee() computes the fee and resizes this output.
  tx.addOutput({
    lockingScript: new P2PKH().lock(funderAddress),
    change: true,
  })
  await tx.fee()
  await tx.sign()

  const setupTxid = tx.id('hex') as string
  const setupRawHex = tx.toHex()

  // Persist setup tx hex BEFORE broadcasting so we can re-attempt safely
  await params.db.insertSetupTx({
    txid: setupTxid,
    raw_hex: setupRawHex,
    network,
    created_at: Date.now(),
  })

  // Broadcast
  const result = await arcBroadcast(setupRawHex, network)
  if (!result.txid && !result.alreadyKnown) {
    throw new Error(`ARC accepted but returned no txid (status ${result.status})`)
  }

  // Insert leaf rows (vout 0..leafCount-1; the change output is at vout leafCount)
  const leafRows = []
  for (let v = 0; v < params.leafCount; v++) {
    leafRows.push({
      txid: setupTxid,
      vout: v,
      satoshis: params.leafSats,
      owner_agent: params.ownerAgent,
    })
  }
  await params.db.insertLeaves(leafRows)

  // Compute change actually returned
  const changeOut = tx.outputs[params.leafCount]
  const changeReturned = changeOut?.satoshis ?? 0

  return {
    setupTxid,
    setupRawHex,
    leavesCreated: params.leafCount,
    totalSpent: params.funding.satoshis - changeReturned,
    changeReturned,
  }
}
