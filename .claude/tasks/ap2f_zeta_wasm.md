---
priority: 2
complexity: high
model: sonnet
depends_on: [ap1a_zeta_setup, ap2a_zeta_crypto_core]
verify: true
test_cmd: null
---

# AP2F: Zeta → WASM Compilation Target

## Mål
Kompiler Zeta crypto core til WebAssembly. Sub-10KB WASM payload 
som kan kjøres i browser, edge workers, og som marketplace compute service.

## Kontekst fra rapport
"Zeta's 7.1 KB Hello World means it can emit pristine, microscopic 
WASM payloads natively. Sub-millisecond cold starts, perfect for 
high-frequency edge routing and instant on-chain interactions."

## Oppgaver

### 1. WASM build target
- Konfigurer Zeta compiler for wasm32 target
- Hvis zetac ikke støtter WASM ennå: bruk Rust wrapper + wasm-pack
- Minimal runtime, ingen GC

### 2. Eksporter crypto functions
- ECDSA sign(privkey, hash) → signature
- SHA-256 hash(data) → digest
- Transaction template builder
- Key derivation (BRC-42 compatible)

### 3. JavaScript bridge
- Load WASM module i Node.js/browser
- TypeScript types for alle exports
- Benchmark: sammenlign med @bsv/sdk JavaScript

### 4. Edge deployment
- Cloudflare Workers-kompatibelt format
- Eller Deno Deploy / Bun
- Sub-1ms cold start verifisert

## Filer
- `zeta/wasm/` — nytt directory
- `src/zeta-wasm-bridge.ts` — nytt
