---
priority: 3
complexity: high
model: sonnet
depends_on: [ap3a_compute_commitment]
verify: true
test_cmd: "npx tsx src/test-verification.ts"
---

# AP3B: Challenge/Response Dispute Mechanism

## Kontekst
opML fase 2: hvem som helst kan challenge et compute-resultat.
Challenger staker bond, worker maa bevise korrekthet.

## Oppgaver

### 1. Challenge-protokoll
- Challenger poster challenge-TX med bond (stakes sat)
- Challenge refererer til original commitment (txid + vout)
- Timeout: worker har N blokker til aa svare

### 2. Response-protokoll
- Worker poster response-TX med re-execution bevis
- Bevis = full (prompt, response, nonce) slik at alle kan verifisere
- Verifier (gateway eller tredjepart) sjekker match

### 3. Resolution
- Match: challenger mister bond (betales til worker)
- Mismatch: worker mister escrow (betales til challenger)
- Timeout (worker svarer ikke): worker mister escrow

### 4. Bisection for store modeller (fremtidig)
- For deterministic compute: bisection protocol (halverer search space)
- Ikke implementer fullt — bare interface/stub for fremtidig bruk
- Dokumenter hvordan dette vil fungere med WASM/Risc-V trace

## Filer
- `src/dispute.ts` — ny fil
- `src/test-verification.ts` — utvid

## Viktig
- Hold det enkelt: foerste versjon bruker "trusted verifier" (gateway)
- Fullt trustless (on-chain bisection) er Fase 7+ arbeid
- Challenge-bond maa vaere hoey nok til aa forhindre spam
