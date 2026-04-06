---
priority: 1
complexity: high
model: sonnet
depends_on: []
verify: true
test_cmd: "npx tsx src/test-identity.ts"
---

# AP1B: BRC-103 Agent Identity System

## Mål
Hver AI-agent får en kryptografisk on-chain identitet via BRC-103.
Dette er kjernen i "Proof of Agentic Authority" — agenter autentiserer 
seg mot hverandre uten API-keys.

## Oppgaver

### 1. Agent wallet + identity
- Generer BRC-42 nøkkelpar per agent
- Opprett BRC-103 identity certificate UTXO
- Felter: agent_name, capabilities[], created_at, owner_pubkey

### 2. SIWB-100 authentication flow  
- Implementer Sign-In with BRC-100:
  1. Challenger sender nonce + domain + expiry
  2. Agent signerer med BRC-100 UTXO private key
  3. Verifier sjekker signatur + on-chain state
- Fungerer som maskin-til-maskin auth

### 3. Capability UTXOs
- Implementer `cop` (capability operation) fra BRC-100
- Mint scoped capability-UTXOs som session-pass
- Eksempel: "50 API-kall, gyldig i 2 timer"

### 4. Test
- `src/test-identity.ts`: Opprett 2 agenter, verifiser gjensidig auth
- Vis at agent A kan verifisere agent B sin identitet on-chain

## Viktig
- Bruk @bsv/sdk for nå — Zeta-versjon kommer i AP2A
- BRC-103 overlay via MessageBox for discovery
