---
priority: 4
complexity: medium
model: sonnet
depends_on: [ap2b_service_agent_framework, ap3a_arcade_integration]
verify: true
test_cmd: "npx tsx src/test-metering.ts"
---

# AP4E: Real-Time Metering & Billing Engine

## Mål
Tamper-proof metering av alle mikrotjeneste-kall. Append-only log 
forankret i BSV — begge parter ser nøyaktig hva som ble forbrukt.

## Kontekst fra rapport
"When a vendor runs both the AI agent and the billing meter, buyers 
must take charges on faith; third-party neutral metering on a public 
ledger provides the verifiable transparency that enterprise procurement 
teams require."

## Oppgaver

### 1. Metering collector
- Hook inn i ServiceAgent request lifecycle
- Per request: timestamp, agent_id, service_id, latency_ms, cost_sat
- Categoriser: COUNT, RATE, GAUGE (Datadog-inspirert)

### 2. Append-only log
- In-memory ring buffer (siste 10 000 events)
- Hvert 100. event: batch-anchor til BSV via OP_RETURN
- Merkle root av batch → on-chain (tamper-proof)

### 3. Real-time metering API
- `GET /metering/live` — SSE stream av events
- `GET /metering/summary/:agentId` — aggregert per agent
- `GET /metering/verify/:batchId` — verifiser batch mot on-chain root

### 4. Rate limiting
- Configurable: max requests/sec per agent
- Soft limit → warning, hard limit → 429
- Basert på Datadog-mønster: 100 traces/sec/service

### 5. Dashboard integration
- Eksporter metering data til marketplace dashboard
- Charts: requests/min, cost/hour, top services

## Filer
- `src/metering.ts` — nytt
- `src/test-metering.ts` — nytt
