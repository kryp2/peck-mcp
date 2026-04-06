---
priority: 1
complexity: medium
model: sonnet
depends_on: []
verify: true
test_cmd: null
---

# AP1A: Zeta Development Environment Setup

## Mål
Installer Zeta-kompilatoren (v0.3.25+) og sett opp utviklingsmiljø for prosjektet.

## Oppgaver

### 1. Installer Zeta
- Klon github.com/murphsicles/zeta
- Bygg kompilatoren (`zetac`)
- Verifiser at `zetac --version` fungerer

### 2. Prosjektstruktur
Opprett `zeta/` katalog i prosjektroten:
```
zeta/
  src/
    main.zeta          — entry point
    crypto/
      signer.zeta      — ECDSA/Schnorr signing
      keys.zeta        — BRC-42 key derivation
    bsv/
      tx_builder.zeta  — Transaction construction
      utxo.zeta        — UTXO management
      broadcast.zeta   — Teranode/ARC broadcast
    brc100/
      identity.zeta    — BRC-103 agent identity
      capability.zeta  — Capability UTXOs (cop)
  build.sh             — Kompiler-script
  test/
    test_signer.zeta
```

### 3. Hello World
- Lag en minimal Zeta-fil som kompilerer
- Verifiser at Zeta kan importere/bruke BSV-relaterte intrinsics
- Dokumenter eventuelle mangler i Zeta standard-lib

### 4. ZeroMQ bridge
- Installer ZeroMQ bindings for både Zeta og Node.js/TypeScript
- Lag en minimal ping-pong test mellom Zeta-prosess og TS-prosess

## Leveranse
- Fungerende Zeta-kompilator
- ZeroMQ bridge mellom Zeta ↔ TypeScript
- Dokumentasjon av eventuelle begrensninger
