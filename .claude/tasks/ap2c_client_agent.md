---
priority: 2
complexity: medium
model: sonnet
depends_on: [ap1b_brc103_identity, ap1c_http402_protocol]
verify: true
test_cmd: "npx tsx src/test-client-agent.ts"
---

# AP2C: Client Agent + Service Discovery

## Mål
Agent som autonomt oppdager tjenester, forhandler pris, betaler, og bruker dem.

## Oppgaver

### 1. Service Discovery
- Søk BRC-103 overlay for tilgjengelige tjenester
- Filter på capability, pris, og agent reputation
- Cache discovered services med TTL

### 2. ClientAgent klasse
```typescript
const client = new ClientAgent({
  name: "research-agent",
  wallet: myWallet,
  budget: 10000, // max satoshis per sesjon
});

// Automatisk: discover → 402 → pay → get result
const translation = await client.call("translate", {
  text: "Hello world",
  targetLang: "no"
});
```

### 3. Budget management
- Track total spent per sesjon
- Maks kostnad per kall (avvis for dyre tjenester)
- Rapport: hvilke tjenester brukt, kostnad, resultat-kvalitet

### 4. LLM-drevet strategi (valgfritt)
- Periodisk LLM-kall for å justere strategi:
  "Basert på disse resultatene, hvilke tjenester bør jeg bruke videre?"
- Demonstrerer AI-agent som tar autonome økonomiske beslutninger
