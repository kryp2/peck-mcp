---
priority: 3
complexity: medium
model: sonnet
depends_on: [ap1c_escrow_e2e]
verify: true
test_cmd: "npx tsx src/test-verification.ts"
---

# AP3A: Compute Commitment Protocol

## Kontekst
opML (optimistic ML) — anta at compute er korrekt, challenge ved mistanke.
Foerste steg: deterministisk commitment-hash som kan verifiseres.

## Oppgaver

### 1. Commitment-format
- `commitment = SHA-256(model_id + prompt + response + nonce)`
- Nonce = worker's per-job counter (forhindrer replay)
- Commitment lagres i OP_RETURN paa betalings-TX

### 2. Commitment registry
- Lokal database (JSON) av alle commitments per worker
- Indeksert paa: jobId, workerId, timestamp, commitment hash
- Retention policy: behold siste N dager (konfigurerbart)

### 3. Verifiserbar re-execution
- Gitt (model_id, prompt, nonce): kjoer inference paa nytt
- Sammenlign response-hash med original commitment
- Haandter non-determinism: fuzzy matching for LLM output

### 4. Test-suite
- `src/test-verification.ts`
- Test: identisk input gir matchende commitment
- Test: tampered response feiler verifisering
- Test: commitment lagres korrekt i OP_RETURN

## Viktig
- LLM-output er IKKE deterministisk — bruk temperature=0 + seed for best-effort
- For non-deterministic backends: hash prompt + model_id (ikke response)
- Commitment maa vaere kompakt (32 bytes SHA-256)
