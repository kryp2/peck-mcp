---
priority: 5
complexity: high
model: sonnet
depends_on: [ap5a_agent_sdk]
verify: true
test_cmd: "npx tsx src/test-402.ts"
---

# AP5B: HTTP 402 BSV-Native Protocol

## Kontekst
Inspirert av Coinbase x402 (HTTP 402 + stablecoins), men BSV-native.
Standard HTTP protocol: server returnerer 402, client betaler, re-sender request.

## Oppgaver

### 1. 402 Response format
```
HTTP/1.1 402 Payment Required
X-Payment-Network: bsv
X-Payment-Address: <worker pubkey hex>
X-Payment-Amount: 50
X-Payment-Unit: satoshis
X-Payment-Channel: <channel-id eller "new">
X-Payment-Accepts: channel,direct
```

### 2. Client-side 402 handler
- Agent SDK intercepter 402 automatisk
- Betaler via channel (foretrukket) eller direkte TX
- Re-sender request med payment proof header:
```
X-Payment-Proof: <txid eller channel-update-signature>
X-Payment-Channel: <channel-id>
```

### 3. Server-side middleware
- Express/Hono middleware for gateway
- Sjekk X-Payment-Proof header
- Verifiser betaling (channel state eller TX lookup)
- Tillat request videre hvis betalt

### 4. Spec-dokument
- Skriv kort protokoll-spec (README-seksjon)
- Sammenlign med x402
- BSV-fordeler: ingen stablecoins, native satoshis, payment channels

## Filer
- `src/http402.ts` — middleware + client handler
- `src/test-402.ts` — tester
- `src/agent-sdk.ts` — integrer 402 handler
- `src/gateway.ts` — legg til middleware

## Viktig
- Kompatibel med standard HTTP — proxier og CDN-er maa ikke brekke
- Payment proof maa vaere kompakt (passer i HTTP header)
- Channel-ID i header for stateful sessions
