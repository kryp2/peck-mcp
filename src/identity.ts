import { PrivateKey, PublicKey, Hash, Signature, Script } from '@bsv/sdk';

// 1. Agent wallet + identity (BRC-42 / BRC-103)
export class AgentIdentity {
  public privKey: PrivateKey;
  public pubKey: PublicKey;
  public agentName: string;
  public capabilities: string[];

  constructor(agentName: string, capabilities: string[] = [], privKey?: PrivateKey) {
    this.agentName = agentName;
    this.capabilities = capabilities;
    this.privKey = privKey || PrivateKey.fromRandom();
    this.pubKey = this.privKey.toPublicKey();
  }

  // Create BRC-103 identity certificate UTXO payload (MessageBox overlay)
  createIdentityCertificate(): Script {
    const createdAt = Date.now().toString();
    const caps = this.capabilities.join(',');
    
    const script = new Script();
    script.writeOpCode(0);
    script.writeOpCode(106); // OP_RETURN
    script.writeBin(Array.from(Buffer.from('brc103', 'utf8')));
    script.writeBin(Array.from(Buffer.from(this.agentName, 'utf8')));
    script.writeBin(Array.from(Buffer.from(this.pubKey.toString(), 'utf8')));
    script.writeBin(Array.from(Buffer.from(createdAt, 'utf8')));
    script.writeBin(Array.from(Buffer.from(caps, 'utf8')));
    
    return script;
  }
}

// 2. SIWB-100 Authentication Flow (Sign-In with BRC-100)
export class SIWB100 {
  static createChallenge(domain: string, ttlMs: number = 60000) {
    return {
      nonce: Math.random().toString(36).substring(2, 15),
      domain,
      expiry: Date.now() + ttlMs
    };
  }

  static signChallenge(challenge: any, privKey: PrivateKey): string {
    const message = `${challenge.nonce}:${challenge.domain}:${challenge.expiry}`;
    const hash = Hash.sha256(Array.from(Buffer.from(message)));
    const sig = privKey.sign(hash);
    return Buffer.from(sig.toDER()).toString('hex');
  }

  static verifySignature(challenge: any, signatureHex: string, pubKey: PublicKey): boolean {
    if (Date.now() > challenge.expiry) return false;
    const message = `${challenge.nonce}:${challenge.domain}:${challenge.expiry}`;
    const hash = Hash.sha256(Array.from(Buffer.from(message)));
    try {
      const sigBuffer = Buffer.from(signatureHex, 'hex');
      const sig = Signature.fromDER(Array.from(sigBuffer));
      return pubKey.verify(hash, sig);
    } catch (e) {
      return false;
    }
  }
}

// 3. Capability UTXOs
export class CapabilityManager {
  static createCapabilityUTXO(agentIdentity: AgentIdentity, targetPubkey: PublicKey, operations: number, validMs: number): Script {
    const expiry = Date.now() + validMs;
    
    const script = new Script();
    script.writeOpCode(0);
    script.writeOpCode(106); // OP_RETURN
    script.writeBin(Array.from(Buffer.from('brc100', 'utf8')));
    script.writeBin(Array.from(Buffer.from('cop', 'utf8')));
    script.writeBin(Array.from(Buffer.from('mint_capability', 'utf8')));
    script.writeBin(Array.from(Buffer.from(targetPubkey.toString(), 'utf8')));
    script.writeBin(Array.from(Buffer.from(operations.toString(), 'utf8')));
    script.writeBin(Array.from(Buffer.from(expiry.toString(), 'utf8')));
    script.writeBin(Array.from(Buffer.from(agentIdentity.pubKey.toString(), 'utf8')));
    
    return script;
  }
}
