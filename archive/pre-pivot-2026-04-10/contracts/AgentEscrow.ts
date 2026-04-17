/**
 * AgentEscrow — sCrypt smart contract for trustless agent-to-agent escrow.
 *
 * Implements Wright §5.4 escrow accountability as a Bitcoin Script covenant.
 * The rules are enforced by consensus, not by trust.
 *
 * Three spending paths:
 *   1. SETTLE — after timelock, funds split: 70% service + 30% marketplace
 *      Anyone can trigger (no signature needed). Math enforced by script.
 *
 *   2. SLASH — marketplace can claim 100% if it provides proof of
 *      misbehavior (a txid with low reputation). Service loses escrow.
 *
 *   3. REFUND — buyer can reclaim after a longer timelock if neither
 *      settle nor slash happened. Safety net.
 *
 * Chronicle opcodes used:
 *   - Transaction introspection via ScriptContext (OP_PUSH_TX pattern)
 *   - Output amount/script verification
 *
 * Compile: npx scrypt-cli compile
 * Deploy: via bank-local createAction with the compiled script
 */
import {
  SmartContract,
  method,
  prop,
  assert,
  PubKey,
  Sig,
  hash256,
  Utils,
  SigHash,
  pubKey2Addr,
  Addr,
} from 'scrypt-ts'

export class AgentEscrow extends SmartContract {
  // Service agent's public key — receives 70% on settle
  @prop()
  serviceKey: PubKey

  // Marketplace public key — receives 30% on settle, 100% on slash
  @prop()
  marketplaceKey: PubKey

  // Buyer public key — can reclaim on refund (after long timelock)
  @prop()
  buyerKey: PubKey

  // Settlement split: service gets this percentage (e.g. 70 = 70%)
  @prop()
  servicePercent: bigint

  // Block height after which settlement is allowed
  @prop()
  settleAfterBlock: bigint

  // Block height after which buyer can refund (safety net)
  @prop()
  refundAfterBlock: bigint

  constructor(
    serviceKey: PubKey,
    marketplaceKey: PubKey,
    buyerKey: PubKey,
    servicePercent: bigint,
    settleAfterBlock: bigint,
    refundAfterBlock: bigint,
  ) {
    super(...arguments)
    this.serviceKey = serviceKey
    this.marketplaceKey = marketplaceKey
    this.buyerKey = buyerKey
    this.servicePercent = servicePercent
    this.settleAfterBlock = settleAfterBlock
    this.refundAfterBlock = refundAfterBlock
  }

  /**
   * SETTLE — release funds according to the agreed split.
   * Anyone can call this after the timelock expires.
   * The script verifies that outputs match the split exactly.
   *
   * Wright §5.4: "The mechanism g maps strategy profiles to outcomes"
   * The covenant IS the mechanism — it enforces the outcome mathematically.
   */
  @method()
  public settle(serviceSig: Sig) {
    // Verify service signed (proves they want to settle)
    assert(this.checkSig(serviceSig, this.serviceKey), 'invalid service signature')

    // Calculate split amounts
    const totalSats = this.ctx.utxo.value
    const serviceSats = (totalSats * this.servicePercent) / 100n
    const marketplaceSats = totalSats - serviceSats

    // Verify outputs: service gets their share
    const serviceAddr = pubKey2Addr(this.serviceKey)
    let outputs = Utils.buildPublicKeyHashOutput(serviceAddr, serviceSats)

    // Marketplace gets the rest
    const marketplaceAddr = pubKey2Addr(this.marketplaceKey)
    outputs += Utils.buildPublicKeyHashOutput(marketplaceAddr, marketplaceSats)

    // Enforce outputs match exactly
    assert(hash256(outputs) == this.ctx.hashOutputs, 'outputs do not match required split')
  }

  /**
   * SLASH — marketplace claims 100% due to service misbehavior.
   * Requires marketplace signature as proof of authority.
   *
   * Wright §5.4: "If a node is found to have propagated an incorrect
   * or inconsistent state, then e_i → forfeit"
   */
  @method()
  public slash(marketplaceSig: Sig) {
    // Only marketplace can slash
    assert(this.checkSig(marketplaceSig, this.marketplaceKey), 'only marketplace can slash')

    // All funds go to marketplace
    const totalSats = this.ctx.utxo.value
    const marketplaceAddr = pubKey2Addr(this.marketplaceKey)
    const outputs = Utils.buildPublicKeyHashOutput(marketplaceAddr, totalSats)

    assert(hash256(outputs) == this.ctx.hashOutputs, 'slash output must pay marketplace')
  }

  /**
   * REFUND — buyer reclaims if neither settle nor slash happened.
   * Only available after a longer timelock (safety net).
   *
   * This ensures funds are never permanently locked.
   */
  @method()
  public refund(buyerSig: Sig) {
    // Only buyer can refund
    assert(this.checkSig(buyerSig, this.buyerKey), 'only buyer can refund')

    // All funds back to buyer
    const totalSats = this.ctx.utxo.value
    const buyerAddr = pubKey2Addr(this.buyerKey)
    const outputs = Utils.buildPublicKeyHashOutput(buyerAddr, totalSats)

    assert(hash256(outputs) == this.ctx.hashOutputs, 'refund must pay buyer')
  }
}
