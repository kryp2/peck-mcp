# Agentic Pay Dispatch Plan

Desentralisert AI compute marketplace med BSV micropayments. Bygger videre på
hackathon-agentic-pay (TypeScript), llm-payment-channel (sCrypt), og peck-ink (mainnet).

BSV er non-negotiable. Vi bygger for fremtiden, ikke dagens marked.

## Posisjonering

Open-source BSV payment/escrow framework for AI compute — ikke lukket marketplace.
Differensiator: sCrypt payment channels + game-theoretic escrow + ~120 TPS lokal signing.
Konkurrenter (Bittensor, Ritual, Akash) bruker egne L1-tokens. Vi bruker ekte penger (BSV).

## Eksisterende kode

| Repo | Status | Gjenbruk |
|------|--------|----------|
| hackathon-agentic-pay | Gateway + worker + escrow + UTXO manager (skeleton) | Hoved-repo, bygges videre |
| llm-payment-channel | sCrypt lock-and-drain, 10 tester OK | Port kontrakten inn |
| peck-ink | Live mainnet sCrypt accumulation | Arkitektur-referanse |
| llm-gateway | Go OpenAI-compatible router | Kan brukes som alternativ gateway |

## Fase 1: Hackathon MVP (testnet E2E)

Mål: Fungerende demo — Gateway mottar inference request, Worker utfører, betaling skjer on-chain.

| Block | Oppgave | Avhenger av | Modell | Kompleksitet |
|-------|---------|-------------|--------|--------------|
| AP1A | UTXO manager hardening + testnet sync | — | sonnet | medium |
| AP1B | Gateway↔Worker HTTP integration | AP1A | sonnet | medium |
| AP1C | Escrow E2E + demo-script | AP1A | sonnet | medium |

## Fase 2: Payment Channels (sCrypt)

Mål: Erstatt enkelt-TX-betaling med sCrypt payment channel for høy throughput.

| Block | Oppgave | Avhenger av | Modell | Kompleksitet |
|-------|---------|-------------|--------|--------------|
| AP2A | Port sCrypt lock-and-drain kontrakt | AP1B | sonnet | high |
| AP2B | Channel lifecycle (open/update/close) | AP2A | sonnet | high |
| AP2C | Payment channel i gateway hot loop | AP2B, AP1B | sonnet | medium |

## Fase 3: Verification Layer (opML)

Mål: Optimistic verification — anta riktig, challenge ved mistanke. Ikke zkML (for dyrt).

| Block | Oppgave | Avhenger av | Modell | Kompleksitet |
|-------|---------|-------------|--------|--------------|
| AP3A | Compute commitment protocol (hash) | AP1C | sonnet | medium |
| AP3B | Challenge/response dispute mechanism | AP3A | sonnet | high |
| AP3C | Slashing + escrow integration | AP3B, AP1C | sonnet | medium |

## Fase 4: Provider SDK

Mål: Gjort det enkelt for compute-leverandører å koble seg til nettverket.

| Block | Oppgave | Avhenger av | Modell | Kompleksitet |
|-------|---------|-------------|--------|--------------|
| AP4A | Provider SDK — registrering, heartbeat, billing | AP2C | sonnet | medium |
| AP4B | Provider discovery via Overlay/MessageBox | AP4A | sonnet | medium |
| AP4C | Multi-backend (Ollama, vLLM, TGI) | AP4A | sonnet | medium |

## Fase 5: Agent SDK + HTTP 402

Mål: Client-side SDK for AI agenter som vil kjøpe compute. BSV-native 402-protokoll.

| Block | Oppgave | Avhenger av | Modell | Kompleksitet |
|-------|---------|-------------|--------|--------------|
| AP5A | Agent SDK — pay-per-call interface | AP2C | sonnet | medium |
| AP5B | HTTP 402 BSV-native protokoll | AP5A | sonnet | high |
| AP5C | Usage dashboard + billing API | AP5A, AP4A | sonnet | medium |

## Fase 6: Production (mainnet)

Mål: Deploy på mainnet (Chronicle aktiv 7. april), open-source release.

| Block | Oppgave | Avhenger av | Modell | Kompleksitet |
|-------|---------|-------------|--------|--------------|
| AP6A | Mainnet migration (Chronicle) | AP2C, AP3C | sonnet | medium |
| AP6B | Gateway Cloud Run + monitoring | AP6A | sonnet | medium |
| AP6C | Open-source release + docs + npm | AP6B, AP5B | sonnet | low |

## Avhengighetsgraf

```
AP1A ──┬── AP1B ──── AP2A ── AP2B ──┬── AP2C ──┬── AP4A ──┬── AP4B
       │                            │          │          ├── AP4C
       └── AP1C ──── AP3A ── AP3B ──┴── AP3C   │          └── AP5C
                                                ├── AP5A ──── AP5B
                                                ├── AP6A ──── AP6B ── AP6C
```

## Tidsestimat

| Fase | Timer (manuelt) | Timer (AI-assistert) |
|------|-----------------|---------------------|
| 1: Hackathon MVP | 40-60 | 15-25 |
| 2: Payment Channels | 60-80 | 25-35 |
| 3: Verification | 40-60 | 15-25 |
| 4: Provider SDK | 40-50 | 15-20 |
| 5: Agent SDK | 50-70 | 20-30 |
| 6: Production | 30-40 | 10-15 |
| **Total** | **260-360** | **100-150** |

## Hackathon-strategi (6-17. april)

Hackathon-deadline prioriterer Fase 1 + deler av Fase 2.
Minste leverbare: AP1A → AP1B → AP1C → AP2A (fungerende payment channel demo).
Stretch goal: AP2B + AP2C (full channel lifecycle i hot loop).

## Tekniske valg

- **Signing**: Lokal TX-bygging, UTXO-chaining, batch ARC broadcast (~120+ TPS)
- **Verification**: opML (optimistic ML) — ikke zkML. Challenge-basert, mye billigere
- **Discovery**: MessageBox + BRC-103 autentisering (allerede i koden)
- **Escrow**: Game-theoretic — stake → audit → slash. Rasjonell strategi = vær ærlig
- **Protocol**: BSV-native HTTP 402 (inspirert av Coinbase x402, men med BSV)
- **Smart contracts**: sCrypt (fra llm-payment-channel, bevist fungerende)
