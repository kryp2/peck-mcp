---
priority: 1
complexity: medium
model: sonnet
depends_on: [ap1a_utxo_hardening]
verify: true
test_cmd: "npx tsx src/demo.ts"
---

# AP1B: Gateway-Worker Real HTTP Integration

## Kontekst
`gateway.ts` og `worker.ts` har HTTP-endepunkter men er ikke koblet sammen.
Maa faa ekte request-flow: client → gateway → worker → response → payment.

## Oppgaver

### 1. Worker HTTP-server
- Start Express/Hono server paa konfigurerbar port
- `POST /infer` — motta inference request, kjoer AI backend, returner resultat
- `GET /health` — returnerer status, kapasitet, pris per request
- `POST /register` — motta registrering fra gateway

### 2. Gateway HTTP-server
- `POST /infer` — motta client request, velg worker, forward, returner
- `GET /stats` — dashboard med worker-status, betalinger, latency
- Worker discovery: hent `/health` fra registrerte workers periodisk

### 3. Real payment flow
- Gateway bygger TX via UTXO manager etter mottatt resultat
- Proof-of-compute hash i OP_RETURN (SHA-256 av request+response)
- Async broadcast — aldri blokker response til client

### 4. Demo-script oppdatering
- Oppdater `demo.ts` til aa starte begge servere
- Kjoer 5 inference requests gjennom hele pipen
- Print gateway stats + worker earnings etter demo

## Filer
- `src/gateway.ts` — modifiser
- `src/worker.ts` — modifiser
- `src/demo.ts` — oppdater
- `src/utxo-manager.ts` — bruk buildTx()

## Viktig
- Bruk native `fetch()` (Node 18+) for HTTP-kall mellom gateway og worker
- Minimal dependencies — helst ingen ekstra HTTP-framework
- Worker maa kunne kjoere "echo" backend uten ekstern API
