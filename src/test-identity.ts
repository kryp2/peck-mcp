import { AgentIdentity, SIWB100, CapabilityManager } from './identity.js';

async function main() {
  console.log("=== 1. Agent Wallet + Identity ===");
  const agentA = new AgentIdentity("Agent A", ["trade", "negotiate"]);
  const agentB = new AgentIdentity("Agent B", ["trade", "settle"]);

  console.log(`Agent A: pubkey=${agentA.pubKey.toString()}`);
  console.log(`Agent B: pubkey=${agentB.pubKey.toString()}`);

  const certA = agentA.createIdentityCertificate();
  const certB = agentB.createIdentityCertificate();
  console.log(`Agent A Certificate Script length: ${certA.toHex().length / 2} bytes`);
  console.log(`Agent B Certificate Script length: ${certB.toHex().length / 2} bytes`);

  console.log("\n=== 2. SIWB-100 Authentication Flow ===");
  const challengeForB = SIWB100.createChallenge("agent-a.local");
  console.log(`A sends challenge to B:`, challengeForB);

  const sigByB = SIWB100.signChallenge(challengeForB, agentB.privKey);
  console.log(`B signs challenge. Signature hex: ${sigByB.substring(0, 30)}...`);

  const isVerifiedB = SIWB100.verifySignature(challengeForB, sigByB, agentB.pubKey);
  console.log(`A verifies B's signature: ${isVerifiedB ? "SUCCESS" : "FAILED"}`);

  const challengeForA = SIWB100.createChallenge("agent-b.local");
  const sigByA = SIWB100.signChallenge(challengeForA, agentA.privKey);
  const isVerifiedA = SIWB100.verifySignature(challengeForA, sigByA, agentA.pubKey);
  console.log(`B verifies A's signature: ${isVerifiedA ? "SUCCESS" : "FAILED"}`);

  console.log("\n=== 3. Capability UTXOs (cop) ===");
  const validMs = 2 * 60 * 60 * 1000;
  const capScript = CapabilityManager.createCapabilityUTXO(agentA, agentB.pubKey, 50, validMs);
  console.log(`Capability Script issued by A to B:`);
  console.log(`  Script Hex: ${capScript.toHex()}`);
  console.log(`  Target Pubkey: ${agentB.pubKey.toString()}`);
  console.log(`  Operations: 50`);
  console.log(`  Valid for: 2 hours`);

  console.log("\nMutual authentication and capability granting successful!");
}

main().catch(console.error);
