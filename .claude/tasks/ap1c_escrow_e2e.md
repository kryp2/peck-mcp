---
priority: 1
complexity: medium
model: sonnet
depends_on: [ap1a_utxo_hardening]
verify: true
test_cmd: "npx tsx src/demo-escrow.ts"
---

# AP1C: Escrow E2E paa Testnet

## Kontekst
`escrow.ts` har game-theoretic escrow-logikk men bruker mock TXs.
Maa kobles til ekte UTXO manager for on-chain escrow paa testnet.

## Oppgaver

### 1. On-chain escrow staking
- Worker staker escrow via ekte TX (UTXO manager)
- Escrow-beloep i OP_RETURN med worker pubkey commitment
- Verifiser broadcast via ARC

### 2. Audit-mekanisme
- Random audit (konfigurerbar rate, default 5%)
- Audit = re-kjoer inference, sammenlign hash med original
- Deterministisk hash-sjekk (SHA-256 av prompt + response)

### 3. Slash-mekanisme
- Dishonest worker: escrow confiscated
- Slash-TX sendes on-chain som bevis
- Worker fjernes fra aktiv pool

### 4. Demo-forbedring
- `demo-escrow.ts`: full flow med ekte testnet-TXs
- Vis honest worker faar betalt, dishonest worker mister escrow
- Print TX-IDer slik at man kan verifisere paa WoC

## Filer
- `src/escrow.ts` — modifiser
- `src/demo-escrow.ts` — oppdater med ekte TXs
- `src/utxo-manager.ts` — bruk for TX-bygging

## Viktig
- Escrow-beloep maa vaere konfigurerbart (default 100 sat)
- Audit-hash maa vaere deterministisk (samme input = samme hash)
- Ikke bruk tilfeldige noekler — bruk wallets fra `.wallets.json`
