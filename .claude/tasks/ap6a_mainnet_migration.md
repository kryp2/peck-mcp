---
priority: 6
complexity: medium
model: sonnet
depends_on: [ap2c_channel_hotloop, ap3c_slashing_integration]
verify: true
test_cmd: "npx tsx src/test-mainnet.ts"
---

# AP6A: Mainnet Migration (Chronicle)

## Kontekst
Chronicle mainnet aktiveres 7. april 2026 (blokkhoeyde 943,816).
Migrér fra testnet til mainnet med riktig konfigurasjon.

## Oppgaver

### 1. Network-konfigurasjon
- Miljoevar `BSV_NETWORK=mainnet|testnet` styrer alt
- ARC endpoint: mainnet vs testnet URL
- WoC API: mainnet vs testnet
- Generer nye mainnet-wallets (IKKE gjenbruk testnet-noekler!)

### 2. Funding-strategi
- Minimum gateway-saldo for aa starte
- Auto-split UTXOs ved foerste sync
- Dokumentér: "hvordan fylle paa gateway wallet"

### 3. Safety checks
- Bekreftelse foer mainnet-TX (interaktiv prompt)
- Max TX-beloep guard (konfigurerbart)
- Dry-run mode: bygg TX uten broadcast

### 4. Chronicle-spesifikke features
- Larger OP_RETURN (opptil 4GB paa Chronicle)
- Arcade broadcaster (erstatter ARC)
- Teranode-kompatibilitet (fremtidig)

## Filer
- `src/config.ts` — ny fil, network-konfigurasjon
- `src/utxo-manager.ts` — network-aware endpoints
- `src/test-mainnet.ts` — mainnet connectivity test (dry-run)

## Viktig
- ALDRI commit mainnet private keys
- Bruk `.wallets.json` med `.gitignore`
- Chronicle != Teranode — vi targets Chronicle foerst
