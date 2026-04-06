---
priority: 4
complexity: medium
model: sonnet
depends_on: [ap2b_service_agent_framework, ap1c_http402_protocol]
verify: true
test_cmd: "npx tsx src/test-hero-services.ts"
---

# AP4D: Hero Services — Datamynt Portfolio Integration

## Mål
Integrer Datamynts eksisterende produkter som "day one" mikrotjenester.
Løser cold-start problemet — markedsplassen har instant utility.

## Kontekst fra rapport
"Datamynt solves the initial supply-side liquidity problem by offering 
its own mature products as the premier services on the platform."

## Tjenester

### 1. merdata.no Agent (eSIM provisioning)
- Wrapper rundt merdata.no API
- Agent-kall: "Provision 1GB data i Tyskland"
- Pris: ~500 sat ($0.50 equivalent)
- Use case: IoT-agenter som trenger mobiltilkobling

### 2. heltenig.no Agent (Digital kontrakt)
- Wrapper rundt heltenig.no kontraktsignering
- Agent-kall: "Opprett og signer avtale mellom agent A og B"
- Pris: ~1000 sat
- Use case: Agent-til-agent SLA-avtaler, on-chain anchored

### 3. beviset.no Agent (Eierskap + bevissikring)
- Wrapper rundt beviset.no BRC-52/94 registrering
- Agent-kall: "Registrer eierskap til datasett X"
- Pris: ~200 sat
- Use case: Agenter som akkumulerer digitale assets

### 4. Service Agent wrapper
- Hver tjeneste som standard ServiceAgent med 402 middleware
- BRC-103 identity per service
- Auto-registrering i marketplace discovery

### 5. Test
- Kall hver hero-service via ClientAgent, verifiser flow

## Filer
- `src/services/merdata-agent.ts` — nytt
- `src/services/heltenig-agent.ts` — nytt
- `src/services/beviset-agent.ts` — nytt
- `src/test-hero-services.ts` — nytt
