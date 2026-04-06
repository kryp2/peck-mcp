---
priority: 3
complexity: high
model: sonnet
depends_on: [ap3b_chronicle_opcodes, ap2a_zeta_crypto_core]
verify: true
test_cmd: null
---

# AP3E: OP_VER Overlay Network Routing

## Mål
Bruk Chronicle-restored OP_VER (0x62) for å partisjonere BSV-nettverket 
i marketplace-spesifikke overlay-soner. Marketplace-transaksjoner markeres 
med custom nVersion, og overlay-noder prosesserer kun relevante txs.

## Kontekst
OP_VER pusher transaksjonens 4-byte version field onto the stack.
OP_VERIF sammenligner stack mot version — instant conditional branching.
Dette muliggjør "Bitcoin Layered Networks" — partisjonerte soner.

## Oppgaver

### 1. Custom nVersion for marketplace
- Definer nVersion = 0x00000007 (eller annen unik verdi) for Peck Pay
- Alle marketplace-transaksjoner bruker denne versjonen
- Standard P2PKH-transaksjoner forblir nVersion = 1

### 2. OP_VER locking script
```
OP_VER              // push tx version onto stack
<7> OP_NUMEQUAL     // verify version == 7
OP_VERIFY           // fail if not marketplace tx
<agent_pubkey> OP_CHECKSIG  // standard sig check
```
- Bare marketplace-deltakere kan bruke disse UTXOs
- Non-marketplace txs avvises kryptografisk

### 3. Overlay node indexer
- Modifiser junglebus-indexer til å filtrere på nVersion
- Kun prosesser marketplace-txs — ignorér resten
- Drastisk redusert processing-load

### 4. Integration med Zeta tx builder
- Sett nVersion i Zeta-genererte transaksjoner
- Chronicle OTDA sighash (0x20) + overlay versioning

## Filer
- `zeta/src/bsv/overlay.zeta` — nytt
- `src/overlay-indexer.ts` — nytt

## Viktig
Chronicle aktiverer 7. april — test på testnet først!
