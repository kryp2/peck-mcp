---
priority: 2
complexity: high
model: sonnet
depends_on: [ap1b_gateway_worker_http]
verify: true
test_cmd: "npx tsx src/test-channel.ts"
---

# AP2A: Port sCrypt Lock-and-Drain Payment Channel

## Kontekst
`llm-payment-channel` har en fungerende sCrypt lock-and-drain kontrakt med 10 tester.
Port denne til hackathon-agentic-pay for hoey-throughput betalinger mellom gateway og worker.

## Referansekode
Se `/home/thomas/Documents/peck-to/llm-payment-channel/` for:
- sCrypt kontrakt (lock-and-drain pattern)
- Test-suite med 10 tester
- SIGHASH_ANYONECANPAY_SINGLE signing pattern

## Oppgaver

### 1. Port sCrypt-kontrakt
- Kopier og tilpass lock-and-drain kontrakt
- Gateway laaaser midler i channel
- Worker drainer per-inference (akkumulerer)
- Cooperative close eller timeout-refund

### 2. Kontrakt-integrasjon
- Installer sCrypt dependencies (`scrypt-ts`)
- Kompiler kontrakt
- Deploy-script for testnet

### 3. Test-suite
- Opprett `src/test-channel.ts`
- Test: open channel, drain 1 sat, drain N sat, close channel
- Test: timeout refund (simuler med locktime)
- Test: invalid drain (feil signatur) avvises

### 4. Dokumenter channel-format
- Beskriv UTXO-format for channel output
- Beskriv signing-flow (two-party)
- Beskriv state-oppdatering (off-chain increment)

## Viktig
- sCrypt v2 syntax
- Behold kompatibilitet med eksisterende UTXO manager
- Channel-state lagres lokalt (JSON), ikke on-chain per update
