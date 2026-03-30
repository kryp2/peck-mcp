---
priority: 1
complexity: medium
model: sonnet
depends_on: []
verify: true
test_cmd: "npx tsx src/test-payment.ts"
---

# AP1A: UTXO Manager Hardening + Testnet Sync

## Kontekst
`src/utxo-manager.ts` har grunnstrukturen men trenger hardening for paalitelig testnet-bruk.
Maa haandtere edge cases: tom UTXO-pool, double-spend, chain-reorg, ARC-feil.

## Oppgaver

### 1. Robust initialSync
- Retry-logikk for WoC API (3 forsok, exponential backoff)
- Valider UTXO-er mot ARC for aa unngaa stale UTXOs
- Logg antall UTXOs og total saldo ved sync

### 2. UTXO-pool management
- Split store UTXOs i mindre (fan-out TX) for parallell signing
- Minimum UTXO-pool size threshold — trigger fan-out automatisk
- Track UTXO-state: available / reserved / spent

### 3. Feilhaandtering
- ARC broadcast retry med idempotency (samme txid = OK)
- Graceful handling av "already in mempool" responses
- Fallback: re-sync fra WoC hvis lokal state divergerer

### 4. Testnet-verifisering
- Kjoer `test-payment.ts` med ekte testnet-midler
- Verifiser TX paa test.whatsonchain.com
- Maal lokal signing-hastighet (maal: >100 TPS)

## Filer
- `src/utxo-manager.ts` — hovedfil, modifiser
- `src/test-payment.ts` — verifiseringsscript
- `.wallets.json` — testnet-wallets (IKKE endre)

## Viktig
- Bruk `@bsv/sdk` v2.0.13 (allerede installert)
- ARC endpoint: `https://arc.gorillapool.io`
- Hex-noekler, ALDRI WIF
- Alle env-vars fra `.wallets.json`, ikke `.env`
