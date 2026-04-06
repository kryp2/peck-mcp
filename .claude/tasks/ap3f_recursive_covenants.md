---
priority: 3
complexity: high
model: sonnet
depends_on: [ap3b_chronicle_opcodes]
verify: true
test_cmd: null
---

# AP3F: Recursive Covenant Capability Tokens

## Mål
Bygg selvreplikerende kapabilitets-tokens via Chronicle recursive covenants.
Tokens som bærer sin egen regellogikk uendelig gjennom UTXO-grafen.
"Denne kontrakten var umulig før 7. april."

## Kontekst fra rapport
Recursive covenants = smart contracts som tvinger spending-transaksjonen 
til å gjenskape nøyaktig de samme reglene i sine nye outputs.
OP_SUBSTR + OTDA muliggjør preimage-parsing for å verifisere at
nye outputs speiler foreldrekontrakten.

## Oppgaver

### 1. Capability token covenant
Locking script som enforcer:
- Kun BRC-103-identifiserte agenter kan bruke tokenet
- Tokenet kan overføres, men reglene følger med
- Capability scope (f.eks. "max 50 API-kall") dekrementeres per bruk
- Når scope = 0, token er ubrukelig

### 2. OP_SUBSTR preimage parsing
```
// Under OTDA, parse tx preimage:
OP_SUBSTR     // extract output script from preimage
OP_SHA256     // hash extracted script
<covenant_hash> OP_EQUAL  // verify new output = same covenant
```
- Verifiser at spending-tx recreater covenant i output
- Self-replicating state machine (quine pattern)

### 3. Stateful capability tracking
- Clean Stack removal → kan beholde state-variabler på stack
- Unlocking script inneholder state-oppdatering (ny brukteller)
- Locking script validerer at state-endring er gyldig

### 4. Integration med BRC-100
- Capability token som BRC-100 stateful token
- cop (capability operation) forbruker covenant-UTXO
- Ny UTXO med oppdatert state opprettes automatisk

## Filer
- `zeta/src/brc100/covenant.zeta` — nytt
- `src/covenant-manager.ts` — TypeScript wrapper
