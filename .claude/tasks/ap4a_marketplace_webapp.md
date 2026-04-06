---
priority: 4
complexity: medium
model: sonnet
depends_on: [ap2b_service_agent_framework, ap2c_client_agent]
verify: true
test_cmd: null
---

# AP4A: Marketplace Web Dashboard (peck-ui + FastHTML)

## Mål
Live webapp som viser agent-markedsplassen i aksjon.
Bygget med peck-ui designsystem + FastHTML/Starlette.
Dommerne ser dette — koden er usynlig, dashboardet er alt.

## Stack
- **FastHTML** (Starlette) — server-side rendering
- **peck-ui** — Jinja2 macros, tokens.css, peck-icons.svg, Alpine.js
- **WebSocket** — sanntids-oppdateringer fra agent-backend (TS)
- **htmx** — partial page updates uten full reload

## Setup
```python
from peck_ui import setup_templates
from starlette.applications import Starlette

app = Starlette()
templates = setup_templates(app)  # peck-ui macros tilgjengelig
```

## Sider

### 1. Markedsplass-oversikt (`/`)
- Hero: "Peck Pay — AI Agent Marketplace" med peck-ui layout macro
- Live-teller: agenter online, transaksjoner i dag, total BSV
- Animert nettverksgraf med agent-noder (Alpine.js + CSS animations)
  - Noder = agenter (BRC-103 identity)
  - Linjer = betalinger (pulserer ved transaksjon)

### 2. Agent-katalog (`/agents`)
- Grid med peck-ui card-macro per agent:
  - Ikon, navn, beskrivelse
  - Pris per kall (i satoshis + USD)
  - Capabilities som tags
  - Status-badge: online/offline
  - "Prøv" knapp → trigger demo-kall
- Filtrering på capability, pris, status

### 3. Live transaksjonsfeed (`/feed`)
- Tabell med peck-ui table-macro
- Sanntids via WebSocket + htmx swap
- Kolonner: tid, client→service, tjeneste, beløp, TXID, latens
- TXID er lenke til whatsonchain.com
- Kumulativ statistikk øverst

### 4. Agent detalj (`/agent/{id}`)
- BRC-103 identity info (on-chain verifiserbar)
- Transaksjonshistorikk
- Gjennomsnitt responstid, oppetid
- Wallet balance

### 5. Demo-modus (`/demo`)
- Stor "Start Demo" knapp (peck-ui button primary)
- Starter client-agent som kaller tjenester automatisk
- Visuell feedback for hele 402→pay→deliver syklusen
- Sanntids latenstall: "Zeta signing: 0.08ms | Broadcast: 12ms | Confirm: 340ms"
- Stopp-knapp

## WebSocket API (fra TS agent-backend)
Dashboard kobler til agent-backend via WS:
```json
{ "event": "tx", "from": "client-01", "to": "translate-agent", "amount": 500, "txid": "abc...", "latency_ms": 14 }
{ "event": "agent_online", "id": "weather-agent", "capabilities": ["weather"], "price": 100 }
{ "event": "agent_offline", "id": "summarize-agent" }
```

## Design
- Mørkt tema (peck-ui dark theme tokens)
- Responsivt (mobil-vennlig for demo på telefon)
- Peck-ikoner for agent-typer
- Animasjoner: pulse ved betaling, fade-in for nye transaksjoner
