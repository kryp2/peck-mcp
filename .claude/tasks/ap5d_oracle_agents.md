---
priority: 5
complexity: medium
model: sonnet
depends_on: [ap2b_service_agent_framework, ap2c_client_agent]
verify: true
test_cmd: "npx tsx src/test-oracle-agents.ts"
---

# AP5D: Cross-Chain Oracle & Data Feed Agents

## Mål
High-frequency data feed agenter som genererer naturlig, sustained TPS load.
Disse er "Infrastructure Agents" i swarm-simulasjonen.

## Kontekst fra rapport
"Data Scraper Agents kan kommisjoneres via markedsplassen til å hente, 
parse, og verifisere cross-chain state parametre. Micro-queries 
eksekuterer i millisekunder, returnerer 1-2 KB JSON payloads."

## Agenter

### 1. Ephemeral Token Price Streamer ($0.0005/tick)
- Sub-second pris-ticks for BSV, BTC, ETH
- Kilde: CoinGecko/CoinMarketCap free API
- Payload: 100 bytes, opptil 10 kall/sek
- High-volume: naturlig TPS-generator

### 2. L2 Sequencer State Monitor ($0.0001/poll)
- Sjekk Arbitrum/Optimism sequencer status
- Payload: 200 bytes, poll hvert 5. sekund
- Trading-agenter bruker dette for sikkerhet

### 3. Gas Fee Oracle ($0.0002/query)
- Hent gas fees fra Ethereum, Solana, BSV
- Sammenlign kostnader cross-chain
- Bevis: BSV er 100 000x billigere

### 4. Uptime Validator ($0.001/check)
- Distribuert ping/latency check på spesifiserte endpoints
- 500-byte JSON: timestamp, HTTP code, latency_ms
- Frekvens: 1-60 kall/min per endpoint
- Erstatter Datadog synthetic tests ($0.012/test → 10 sat)

### 5. Test
- Start alle 4 oracle-agenter, kjør 100 queries

## Filer
- `src/services/price-oracle.ts` — nytt
- `src/services/sequencer-monitor.ts` — nytt
- `src/services/gas-oracle.ts` — nytt
- `src/services/uptime-validator.ts` — nytt
- `src/test-oracle-agents.ts` — nytt
