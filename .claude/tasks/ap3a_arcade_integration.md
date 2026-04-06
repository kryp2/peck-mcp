---
priority: 3
complexity: medium
model: sonnet
depends_on: [ap1c_http402_protocol]
verify: true
test_cmd: "npx tsx src/test-arcade.ts"
---

# AP3A: ARCADE SSE + BEEF Transaction Broadcasting

## Mål
Asynkron transaksjonsbekreftelse via ARCADE Server-Sent Events.
BEEF-format for å omgå mempool chaining limits.

## Oppgaver

### 1. ARCADE SSE Client
- EventSource connection til ARC endpoint
- Lytt på events: SEEN_ON_NETWORK, MINED
- Auto-reconnect med Last-Event-ID for event replay
- Callback system: `onConfirmed(txid, callback)`

### 2. BEEF Transaction Format
- Implementer BRC-64/95/96 BEEF envelope
- Bundle ancestor transactions + BUMPs
- Enables SPV-verifisering uten full mempool

### 3. Broadcast Pipeline
- build_tx → sign → wrap_beef → POST /tx → SSE confirm
- Hele pipelinen async — HTTP-respons sendes IKKE etter broadcast
- Service-agent venter på SSE SEEN_ON_NETWORK før den leverer

### 4. Fallback
- Hvis SSE feiler: poll ARC /tx/{txid}/status hvert 2. sekund
- Timeout etter 30 sekunder → refund eller retry
