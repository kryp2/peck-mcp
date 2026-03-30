---
priority: 4
complexity: medium
model: sonnet
depends_on: [ap2c_channel_hotloop]
verify: true
test_cmd: "npx tsx src/test-provider.ts"
---

# AP4A: Provider SDK — Registrering, Heartbeat, Billing

## Kontekst
Gjor det enkelt for compute-leverandorer aa koble seg til nettverket.
SDK som wrapper worker-logikk i et enkelt API.

## Oppgaver

### 1. Provider klasse
```typescript
const provider = new AgenticProvider({
  privateKey: "hex...",
  gateway: "https://gateway.example.com",
  backends: [{ type: "ollama", url: "http://localhost:11434" }],
  pricing: { perToken: 1 },  // satoshis
  escrowAmount: 1000,         // satoshis
});
await provider.start();
```

### 2. Auto-registrering
- Ved start: registrer hos gateway med pubkey + capabilities
- Stake escrow automatisk
- Annonsér prising og tilgjengelige modeller

### 3. Heartbeat
- Periodisk ping til gateway (default 30s)
- Inkluder: load, capacity, uptime, earnings
- Gateway fjerner workers som mister 3 heartbeats

### 4. Billing dashboard
- Provider kan query egne earnings
- Per-channel breakdown
- Pending vs settled betalinger

## Filer
- `src/provider-sdk.ts` — ny fil
- `src/test-provider.ts` — tester
- `src/worker.ts` — refaktor til aa bruke SDK internt

## Viktig
- SDK maa fungere som npm-pakke (eksporterbar)
- Minimal config — sensible defaults
- TypeScript-first med full typing
