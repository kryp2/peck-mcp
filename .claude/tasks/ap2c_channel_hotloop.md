---
priority: 2
complexity: medium
model: sonnet
depends_on: [ap2b_channel_lifecycle, ap1b_gateway_worker_http]
verify: true
test_cmd: "npx tsx src/demo.ts"
---

# AP2C: Payment Channel i Gateway Hot Loop

## Kontekst
Integrer ChannelManager i gateway hot loop slik at hver inference-betaling
gaar via payment channel (off-chain) istedenfor individuelle TXs.

## Oppgaver

### 1. Gateway-integrasjon
- Ved foerste request til worker: aapne channel automatisk
- Per-inference: off-chain channel update (ingen TX!)
- Periodisk: batch-settle via cooperative close + re-open

### 2. Worker-integrasjon
- Worker verifiserer off-chain signatur per update
- Circuit breaker: stopp arbeid hvis channel-saldo er lav
- Worker kan trigge cooperative close for aa realisere midler

### 3. Performance-maal
- Maal: >100 off-chain updates per sekund per channel
- Benchmark: 1000 off-chain updates, maal tid
- Sammenlign med on-chain TPS fra Fase 1

### 4. Fallback
- Hvis channel feiler: fall tilbake til enkelt-TX via UTXO manager
- Logg channel-feil for debugging
- Auto-reopen channel etter feil

## Filer
- `src/gateway.ts` — integrer ChannelManager
- `src/worker.ts` — verifiser channel updates
- `src/channel-manager.ts` — bruk
- `src/demo.ts` — oppdater demo

## Viktig
- Hot loop maa vaere SYNKRON for hastighet (ingen await per update)
- Kun signing + state-update per request
- ARC broadcast kun ved open/close
