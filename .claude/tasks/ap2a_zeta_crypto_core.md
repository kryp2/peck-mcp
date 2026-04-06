---
priority: 2
complexity: high
model: sonnet
depends_on: [ap1a_zeta_setup]
verify: true
test_cmd: null
---

# AP2A: Zeta Crypto Core Module

## Mål
Implementer BSV kryptografi i Zeta — dette er hot-pathen som gir 
sub-millisekund signing og erstatter @bsv/sdk for ytelseskritiske operasjoner.

## Oppgaver

### 1. ECDSA Signing (secp256k1)
- Implementer sign(privkey, hash) → signature i Zeta
- Bruk Zetas native krypto-intrinsics hvis tilgjengelig
- Fallback: implementer fra scratch med Zetas big-int support
- Benchmark: mål signing-tid (mål: <0.1ms)

### 2. Transaction Builder
- Bygg rå BSV-transaksjoner som byte-arrays
- CTFE (Compile-Time Function Evaluation) for tx-templates:
  - P2PKH output script (standard betaling)
  - OP_RETURN data output (kvitteringer)
  - BRC-100 token output
- Chronicle OTDA sighash (0x20) support

### 3. UTXO Manager
- Hold en in-memory UTXO-pool per agent
- Lock UTXO ved bruk, frigjør ved bekreftelse eller timeout
- Actor-isolasjon: én agent = én UTXO-pool, ingen delt state

### 4. Teranode Broadcast
- WebSocket/gRPC connection til Teranode
- Stream rå hex-transaksjoner via persistent connection
- Ikke HTTP per transaksjon — multipleks alt over én socket

### 5. ZeroMQ API
Eksponér følgende kommandoer over ZeroMQ til TypeScript:
- `sign(privkey_hex, data_hex) → sig_hex`
- `build_p2pkh_tx(utxos, outputs) → rawtx_hex`
- `broadcast(rawtx_hex) → txid`
- `get_utxos(address) → utxo_list`

## Benchmark-krav
- Signing: <0.1ms per signatur
- Tx building: <0.5ms per transaksjon
- Throughput: >1000 tx/sek sustained
