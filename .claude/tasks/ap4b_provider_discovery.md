---
priority: 4
complexity: medium
model: sonnet
depends_on: [ap4a_provider_sdk]
verify: true
test_cmd: "npx tsx src/test-provider.ts"
---

# AP4B: Provider Discovery via Overlay/MessageBox

## Kontekst
Desentralisert provider discovery — ikke avhengig av sentral gateway-registrering.
Bruk BSV Overlay Network og/eller MessageBox for P2P discovery.

## Oppgaver

### 1. MessageBox-annonsering
- Provider publiserer capability-melding til MessageBox
- Format: pubkey, modeller, prising, endpoint, escrow-bevis
- BRC-103 autentisert (allerede i agent-b.ts)

### 2. Gateway discovery
- Gateway poller MessageBox for nye providers
- Filtrerer paa: modell-stoette, pris-range, minimum escrow
- Automatisk registrering av oppdagede providers

### 3. Overlay Network lookup (fremtidig)
- SHIP/SLAP protocol for topic-basert lookup
- Topic: "agentic-pay-provider-v1"
- Stub implementasjon — full Overlay er post-hackathon

### 4. Provider directory cache
- Lokal cache av kjente providers
- TTL-basert invalidering
- Fallback til direkte HTTP hvis MessageBox er nede

## Filer
- `src/discovery.ts` — ny fil
- `src/gateway.ts` — integrer discovery
- `src/provider-sdk.ts` — publiser til MessageBox
