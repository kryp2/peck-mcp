/**
 * Covenant Manager — TypeScript wrapper for BRC-100 recursive covenant capability tokens.
 *
 * Bridges the Zeta crypto core (ZeroMQ) with the TypeScript orchestrator.
 * Manages the lifecycle of capability-token UTXOs:
 *   mint → transfer → spend (decrement scope) → exhausted
 *
 * Chronicle OTDA (activated April 7 2026) enables the recursive covenant pattern
 * where each spending tx must recreate the same locking script with updated state.
 */

import { Hash, PrivateKey, PublicKey, Script } from '@bsv/sdk';
import * as zmq from 'zeromq';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CovenantState {
  /** HASH160 of the BRC-103 agent pubkey authorised to spend */
  agentPubkeyHash: string; // hex, 20 bytes
  /** Remaining API-call budget */
  scopeRemaining: number;
  /** Capability type tag, e.g. "api_call", "translate", "summarize" */
  capabilityTag: string;
}

export interface CapabilityToken {
  /** Stable 32-byte token identity (hex) */
  tokenId: string;
  /** The UTXO that holds this token */
  utxo: { txid: string; vout: number; satoshis: number };
  state: CovenantState;
  /** Issuer BRC-103 pubkey (hex) */
  issuerPubkey: string;
}

export interface SpendResult {
  /** New txid after spending the covenant UTXO */
  txid: string;
  /** Updated token with decremented scope */
  updatedToken: CapabilityToken | null; // null when scope reaches 0
}

// ─── ZeroMQ bridge ───────────────────────────────────────────────────────────

async function zetaCall(cmd: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sock = new zmq.Request();
  sock.connect('tcp://127.0.0.1:5555');
  const msg = JSON.stringify({ cmd, ...params });
  await sock.send(msg);
  const [reply] = await sock.receive();
  sock.close();
  return JSON.parse(reply.toString());
}

// ─── Script builders (TypeScript side) ───────────────────────────────────────

/**
 * Build the OP_FALSE OP_RETURN BRC-100 metadata script for a capability token.
 * This is broadcast alongside the covenant P2SH output so overlay indexers
 * can track token state without parsing covenant scripts.
 */
function buildBrc100MetadataScript(token: CapabilityToken): Script {
  const script = new Script();
  script.writeOpCode(0);    // OP_FALSE
  script.writeOpCode(106);  // OP_RETURN

  const enc = (s: string) => Array.from(Buffer.from(s, 'utf8'));
  const hex2buf = (h: string) => Array.from(Buffer.from(h, 'hex'));
  const u32le = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n, 0);
    return Array.from(b);
  };

  script.writeBin(enc('brc100cop'));
  script.writeBin(enc('cop'));
  script.writeBin(hex2buf(token.tokenId));
  script.writeBin(enc(token.state.capabilityTag));
  script.writeBin(u32le(token.state.scopeRemaining));
  script.writeBin(hex2buf(token.state.agentPubkeyHash));
  script.writeBin(hex2buf(token.issuerPubkey));

  return script;
}

/**
 * Derive the covenant locking script hash for a given state.
 * Used to locate the correct UTXO after a spend and to validate
 * that the new output matches the expected covenant template.
 */
function covenantStateHash(state: CovenantState): string {
  const data = Buffer.concat([
    Buffer.from(state.agentPubkeyHash, 'hex'),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(state.scopeRemaining, 0); return b; })(),
    Buffer.from(state.capabilityTag, 'utf8'),
  ]);
  return Buffer.from(Hash.sha256(Array.from(data))).toString('hex');
}

// ─── CovenantManager ─────────────────────────────────────────────────────────

export class CovenantManager {
  /** In-memory token registry: tokenId → CapabilityToken */
  private tokens = new Map<string, CapabilityToken>();

  /**
   * Mint a new capability token covenant.
   *
   * Calls the Zeta core to build + sign a tx with two outputs:
   *   1. Covenant P2SH UTXO (holds the spendable capability token)
   *   2. OP_RETURN BRC-100 metadata (for overlay indexing)
   *
   * @param issuerPrivkey  Issuer's private key (hex)
   * @param fundingUtxo    UTXO to fund the mint tx
   * @param agentPubkey    BRC-103 pubkey of the authorised agent (hex)
   * @param capabilityTag  What this token grants (e.g. "translate")
   * @param scope          Number of uses (max 50 by default)
   */
  async mint(
    issuerPrivkey: string,
    fundingUtxo: { txid: string; vout: number; satoshis: number },
    agentPubkey: string,
    capabilityTag: string,
    scope: number = 50,
  ): Promise<CapabilityToken> {
    const issuerKey = PrivateKey.fromString(issuerPrivkey);
    const issuerPubkey = issuerKey.toPublicKey().toString();

    // HASH160 of the agent pubkey (20 bytes)
    const agentPubkeyHashBuf = Hash.hash160(
      Array.from(Buffer.from(agentPubkey, 'hex')),
    );
    const agentPubkeyHash = Buffer.from(agentPubkeyHashBuf).toString('hex');

    const state: CovenantState = {
      agentPubkeyHash,
      scopeRemaining: scope,
      capabilityTag,
    };

    // Stable token identity — deterministic from issuer + tag + funding utxo
    const tokenIdBuf = Hash.sha256(
      Array.from(Buffer.from(`${issuerPubkey}:${capabilityTag}:${fundingUtxo.txid}:${fundingUtxo.vout}`, 'utf8')),
    );
    const tokenId = Buffer.from(tokenIdBuf).toString('hex');

    // Ask Zeta core to build the covenant locking script + sign the mint tx
    const mintResult = await zetaCall('build_covenant_mint_tx', {
      issuer_privkey_hex: issuerPrivkey,
      funding_utxo: JSON.stringify(fundingUtxo),
      agent_pubkey_hash_hex: agentPubkeyHash,
      scope_remaining: scope,
      capability_tag: capabilityTag,
      covenant_template_hash_hex: covenantStateHash(state),
      token_id_hex: tokenId,
    });

    if (mintResult.error) {
      throw new Error(`Zeta mint failed: ${mintResult.error}`);
    }

    // Broadcast via Zeta
    const broadcastResult = await zetaCall('broadcast', {
      rawtx_hex: mintResult.rawtx_hex,
    });

    const txid = broadcastResult.txid as string;

    const token: CapabilityToken = {
      tokenId,
      utxo: { txid, vout: 0, satoshis: fundingUtxo.satoshis - 1000 }, // minus fee
      state,
      issuerPubkey,
    };

    this.tokens.set(tokenId, token);
    console.log(`[CovenantManager] Minted capability token ${tokenId} tag=${capabilityTag} scope=${scope} txid=${txid}`);
    return token;
  }

  /**
   * Spend one use of a capability token (cop — capability operation).
   *
   * Builds + broadcasts a tx that:
   *   - Spends the current covenant UTXO (unlocking script: sig + pubkey + new_scope)
   *   - Creates a new covenant UTXO with scope - 1  (self-replication)
   *   - Creates BRC-100 metadata output with updated state
   *
   * Returns null updatedToken when scope reaches 0 (token exhausted).
   */
  async spend(
    tokenId: string,
    agentPrivkey: string,
  ): Promise<SpendResult> {
    const token = this.tokens.get(tokenId);
    if (!token) throw new Error(`Token ${tokenId} not found`);
    if (token.state.scopeRemaining === 0) {
      throw new Error(`Token ${tokenId} is exhausted (scope = 0)`);
    }

    const newScope = token.state.scopeRemaining - 1;
    const newState: CovenantState = { ...token.state, scopeRemaining: newScope };

    // Ask Zeta core to build the covenant spend tx
    const spendResult = await zetaCall('build_covenant_spend_tx', {
      agent_privkey_hex: agentPrivkey,
      covenant_utxo: JSON.stringify(token.utxo),
      current_scope: token.state.scopeRemaining,
      new_scope: newScope,
      agent_pubkey_hash_hex: token.state.agentPubkeyHash,
      capability_tag: token.state.capabilityTag,
      covenant_template_hash_hex: covenantStateHash(newState),
      token_id_hex: token.tokenId,
    });

    if (spendResult.error) {
      throw new Error(`Zeta covenant spend failed: ${spendResult.error}`);
    }

    const broadcastResult = await zetaCall('broadcast', {
      rawtx_hex: spendResult.rawtx_hex,
    });

    const txid = broadcastResult.txid as string;

    if (newScope === 0) {
      // Token exhausted — remove from registry
      this.tokens.delete(tokenId);
      console.log(`[CovenantManager] Token ${tokenId} exhausted after final spend (txid=${txid})`);
      return { txid, updatedToken: null };
    }

    const updatedToken: CapabilityToken = {
      ...token,
      utxo: { txid, vout: 0, satoshis: token.utxo.satoshis - 1000 },
      state: newState,
    };

    this.tokens.set(tokenId, updatedToken);
    console.log(`[CovenantManager] Token ${tokenId} spent — scope ${token.state.scopeRemaining} → ${newScope} (txid=${txid})`);
    return { txid, updatedToken };
  }

  /**
   * Transfer a capability token to a new authorised agent.
   *
   * The covenant is recreated with the new agent's HASH160 but the same scope.
   * Both the issuer and original holder must co-sign (2-of-2) in a full
   * implementation; here the current holder signs the transfer.
   */
  async transfer(
    tokenId: string,
    holderPrivkey: string,
    newAgentPubkey: string,
  ): Promise<CapabilityToken> {
    const token = this.tokens.get(tokenId);
    if (!token) throw new Error(`Token ${tokenId} not found`);
    if (token.state.scopeRemaining === 0) {
      throw new Error(`Token ${tokenId} is exhausted — cannot transfer`);
    }

    const newAgentPubkeyHashBuf = Hash.hash160(
      Array.from(Buffer.from(newAgentPubkey, 'hex')),
    );
    const newAgentPubkeyHash = Buffer.from(newAgentPubkeyHashBuf).toString('hex');

    const newState: CovenantState = {
      ...token.state,
      agentPubkeyHash: newAgentPubkeyHash,
    };

    const transferResult = await zetaCall('build_covenant_transfer_tx', {
      holder_privkey_hex: holderPrivkey,
      covenant_utxo: JSON.stringify(token.utxo),
      current_scope: token.state.scopeRemaining,
      new_agent_pubkey_hash_hex: newAgentPubkeyHash,
      capability_tag: token.state.capabilityTag,
      covenant_template_hash_hex: covenantStateHash(newState),
      token_id_hex: token.tokenId,
    });

    if (transferResult.error) {
      throw new Error(`Zeta covenant transfer failed: ${transferResult.error}`);
    }

    const broadcastResult = await zetaCall('broadcast', {
      rawtx_hex: transferResult.rawtx_hex,
    });

    const txid = broadcastResult.txid as string;

    const updatedToken: CapabilityToken = {
      ...token,
      utxo: { txid, vout: 0, satoshis: token.utxo.satoshis - 1000 },
      state: newState,
    };

    this.tokens.set(tokenId, updatedToken);
    console.log(`[CovenantManager] Token ${tokenId} transferred to ${newAgentPubkey.slice(0, 16)}... (txid=${txid})`);
    return updatedToken;
  }

  // ── Read-only helpers ────────────────────────────────────────────────────

  getToken(tokenId: string): CapabilityToken | undefined {
    return this.tokens.get(tokenId);
  }

  listTokens(): CapabilityToken[] {
    return Array.from(this.tokens.values());
  }

  isExhausted(tokenId: string): boolean {
    const token = this.tokens.get(tokenId);
    return !token || token.state.scopeRemaining === 0;
  }

  /** Compute BRC-100 metadata script for any token (for indexing / display) */
  buildMetadataScript(tokenId: string): Script {
    const token = this.tokens.get(tokenId);
    if (!token) throw new Error(`Token ${tokenId} not found`);
    return buildBrc100MetadataScript(token);
  }
}

// Singleton export — one manager per process
export const covenantManager = new CovenantManager();
