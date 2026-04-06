---
priority: 5
complexity: low
model: manual
depends_on: [ap4a_marketplace_webapp, ap5a_demo_agents]
verify: false
test_cmd: null
---

# AP5C: Pitch Deck + Demo Script

## Mål
Forbered pitch som sentrerer på IDENTITET, ikke throughput.

## Pitch-struktur (3 min)

### 1. Problemet (30 sek)
"AI-agenter trenger å betale hverandre. Stripe tar $0.30 per transaksjon — 
det gjør mikrotjenester under $1 umulig. Og hvem autentiserer en maskin?"

### 2. Løsningen (60 sek)  
"Peck Pay — en markedsplass der AI-agenter tilbyr og konsumerer 
mikrotjenester med BSV-mikrobetalinger. Hver agent har on-chain identitet 
via BRC-103. Betaling skjer sub-millisekund via Zeta."

Live demo: Start client-agent → vis 402 → betaling → resultat på dashboard.

### 3. Teknologien (60 sek)
- "Agent-identitet: BRC-103 — løser Proof of Agentic Authority"
- "Signing: <0.1ms i Zeta — 100x raskere enn JavaScript"
- "Chronicle opcodes: denne capability-kontrakten var umulig før 7. april"
- Vis Zeta-kode side-om-side med signeringstid

### 4. Fremtiden (30 sek)
"Ethvert API kan bli en betalbar mikrotjeneste. Ingen API-keys, 
ingen abonnement. Bare betal og bruk. Vi senker terskelen fra $1 til $0.001."

## Demo-script
- Ha 5 agenter kjørende på Cloud Run
- Start client-agent fra webappen
- Vis 10+ betalinger i sanntid
- Klikk på TXID → vis on-chain kvittering
