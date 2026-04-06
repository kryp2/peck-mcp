---
priority: 3
complexity: high
model: sonnet
depends_on: [ap2a_zeta_crypto_core]
verify: true
test_cmd: null
---

# AP3B: Chronicle Opcode Integration

## Mål
Bruk Chronicle-restored opcodes i agent smart contracts.
"Denne kontrakten var umulig før forrige uke."

## Oppgaver

### 1. OTDA Sighash (0x20)
- Implementer Chronicle sighash flag i Zeta tx builder
- Original Transaction Digest Algorithm som alternativ til BIP143
- Brukes for multi-party agent-signaturer

### 2. Capability-locking script
Bruk restored opcodes for on-chain capability-verifisering:
```
OP_SUBSTR — parse agent-capability fra UTXO data
OP_LEFT — ekstraher scope-felt
OP_2MUL — beregn prisjustering basert on-chain
```
- Locking script som verifiserer: "denne agenten har capability X 
  og har betalt minst Y satoshis"

### 3. Pre-compiled scripts via CTFE
- Bruk Zetas Compile-Time Function Evaluation
- Prekompiler vanlige script-templates til byte-arrays
- Eksempel: P2PKH, capability-check, payment-receipt
- Mål: 0-cost runtime for standard scripts

### 4. Test på testnet
- Chronicle er allerede aktiv på testnet
- Send reelle transaksjoner med nye opcodes
- Verifiser via whatsonchain testnet explorer
