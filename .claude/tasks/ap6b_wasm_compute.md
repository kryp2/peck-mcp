---
priority: 6
complexity: medium
model: sonnet
depends_on: [ap2b_service_agent_framework]
verify: true
test_cmd: "npx tsx src/test-wasm-compute.ts"
---

# AP6B: WASM Micro-Compute Service

## Mål
WebAssembly-basert compute marketplace — agenter sender .wasm moduler 
og input, worker eksekverer i sandbox, betaling per millisekund CPU-tid.

## Kontekst fra rapport
"Zetas sub-10 KB WASM payload ville eksekvere instantant. BSV 
marketplace bridges the gap by offering WASM micro-compute services 
via MCP servers. Pay per 10ms execution window."

## Oppgaver

### 1. WASM runtime
- Bruk Node.js WebAssembly API (native, ingen deps)
- Memory sandbox: 1MB max per execution
- CPU timeout: 100ms max per execution
- Instantiate → execute → extract result

### 2. ServiceAgent: "wasm-compute"
- Input: { wasm_base64, function_name, args[] }
- Alternativ: { wasm_hash } for cached modules
- Output: { result, execution_ms, memory_peak_kb }
- Pris: 10 satoshis per 10ms CPU-tid

### 3. Module cache
- Hash-basert cache av kompilerte WASM modules
- Eliminerer kompileringsoverhead for gjentatte kall
- LRU eviction ved >100 cached modules

### 4. Pre-built WASM tools
- Enkel JSON parser (for agent data processing)
- Markdown → HTML converter
- SHA-256 hasher (for proof-of-compute)
- Base64 encode/decode

### 5. Test
- Last en WASM modul, eksekvér funksjon, verifiser resultat og betaling

## Filer
- `src/wasm-runtime.ts` — nytt
- `src/services/wasm-compute-agent.ts` — nytt
- `src/test-wasm-compute.ts` — nytt
