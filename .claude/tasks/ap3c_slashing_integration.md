---
priority: 3
complexity: medium
model: sonnet
depends_on: [ap3b_dispute_mechanism, ap1c_escrow_e2e]
verify: true
test_cmd: "npx tsx src/demo-escrow.ts"
---

# AP3C: Slashing + Escrow Integration

## Kontekst
Koble dispute-mekanismen (AP3B) til escrow-systemet (AP1C).
Feilet dispute = automatisk slash av worker escrow.

## Oppgaver

### 1. Automatisk slash ved dispute-tap
- Dispute resolver kaller `escrow.slash(workerId)` ved mismatch
- Slash-TX refererer til dispute-TX som bevis
- Worker fjernes fra aktiv worker-pool

### 2. Escrow top-up
- Worker kan toppe opp escrow uten aa re-stake
- Gateway krever minimum escrow-saldo for aa sende jobber
- Varsel til worker naar escrow er lav

### 3. Reputation score
- Track: total_jobs, successful_audits, failed_audits, disputes_won, disputes_lost
- Score = weighted ratio (nyere jobber teller mer)
- Gateway bruker score for worker-seleksjon

### 4. Demo-oppdatering
- Utvid `demo-escrow.ts` med dispute-flow
- Vis: honest worker challenget → challenger taper bond
- Vis: dishonest worker challenget → worker slashet

## Filer
- `src/escrow.ts` — integrer dispute callbacks
- `src/dispute.ts` — koble til escrow
- `src/demo-escrow.ts` — utvid demo
