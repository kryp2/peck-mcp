---
priority: 2
complexity: medium
model: sonnet
depends_on: [ap1b_brc103_identity, ap1c_http402_protocol]
verify: true
test_cmd: "npx tsx src/test-service-agent.ts"
---

# AP2B: Service Agent Framework

## Mål
Lag et enkelt SDK for å deploye en service-agent som tilbyr en 
mikrotjeneste på markedsplassen.

## API Design
```typescript
const agent = new ServiceAgent({
  name: "translate-agent",
  description: "Oversetter tekst mellom språk",
  pricePerCall: 500, // satoshis
  capabilities: ["translate", "detect-language"],
});

agent.handle("translate", async (req) => {
  const result = await translateWithLLM(req.text, req.targetLang);
  return { translated: result };
});

agent.start({ port: 3001 });
```

## Oppgaver

### 1. ServiceAgent klasse
- Registrer capabilities og pris
- Start HTTP-server med 402-middleware
- Publiser BRC-103 identity + capabilities til MessageBox overlay

### 2. Request/Response lifecycle
- Motta request → sjekk betaling → utfør handler → returner resultat
- Logging: request_id, caller_identity, amount_paid, duration_ms
- On-chain kvittering: OP_RETURN med service_id + request_hash

### 3. Auto-discovery
- Publiser service-metadata til BRC-103 overlay
- Format: { name, description, price, endpoint, capabilities[], identity }
- Oppdater ved endring (pris, status)

### 4. Eksempel-agenter
Lag 3 demo-agenter:
- `agents/translate.ts` — Oversettelse via LLM ($0.005/kall)
- `agents/weather.ts` — Værdata via open-meteo API ($0.001/kall)
- `agents/summarize.ts` — URL-oppsummering via LLM ($0.01/kall)
