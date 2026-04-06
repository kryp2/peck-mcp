---
priority: 1
complexity: medium
model: sonnet
depends_on: []
verify: true
test_cmd: "npx tsx src/test-402.ts"
---

# AP1C: HTTP 402 Payment Required Protocol

## Mål
Implementer x402 — standard HTTP-basert betalingsprotokoll for agent-til-agent mikrotjenester.

## Flyten
1. Client-agent sender GET/POST til service-agent
2. Service-agent svarer **402 Payment Required** med headers:
   - `X-BSV-Payment-Address: <address>`
   - `X-BSV-Amount-Satoshis: <amount>`
   - `X-BSV-Payment-Terms: single|channel`
   - `X-BSV-Service-ID: <brc103-identity>`
3. Client-agent sender BSV-betaling
4. Client-agent sender nytt request med header:
   - `X-BSV-Payment-TXID: <txid>`
5. Service-agent verifiserer betaling (0-conf via ARCADE SSE)
6. Service-agent leverer respons

## Oppgaver

### 1. HTTP middleware
- Express/Fastify middleware som returnerer 402 for ubetalt request
- Parser X-BSV-Payment-TXID header
- Verifiserer betaling via ARC status-endepunkt

### 2. Client helper
- `PaymentClient` klasse som håndterer 402 → pay → retry automatisk
- Cacher betalingsstatus for å unngå dobbeltbetaling

### 3. ARCADE SSE integration
- Lytt på Server-Sent Events fra ARC for betalingsbekreftelse
- SEEN_ON_NETWORK = god nok for 0-conf
- Fallback til polling hvis SSE feiler

### 4. Test
- Lokal server som krever 402 betaling
- Client som automatisk betaler og får respons
