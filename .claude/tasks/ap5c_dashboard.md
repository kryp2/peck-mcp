---
priority: 5
complexity: medium
model: sonnet
depends_on: [ap5a_agent_sdk, ap4a_provider_sdk]
verify: true
test_cmd: "npx tsx src/test-dashboard.ts"
---

# AP5C: Usage Dashboard + Billing API

## Kontekst
Enkel dashboard for baade providers og consumers — se earnings, spending, channel-status.

## Oppgaver

### 1. Billing API
- `GET /api/billing/summary` — total earnings/spending
- `GET /api/billing/channels` — aktive channels med saldo
- `GET /api/billing/history` — siste N transaksjoner
- `GET /api/billing/providers` — provider-statistikk

### 2. Provider dashboard-data
- Earnings per time/dag/uke
- Jobs completed, failed, disputed
- Active channels og kapasitet
- Escrow-saldo og status

### 3. Consumer dashboard-data
- Spending per modell/provider
- Average cost per request
- Channel utilization
- Budget remaining (vs dailyBudget)

### 4. Enkel HTML dashboard
- Server-rendered HTML (ingen React/Vue)
- Auto-refresh via SSE eller polling
- Responsive — fungerer paa mobil
- Charting: inline SVG (ingen chart-lib)

## Filer
- `src/billing.ts` — billing API og data-aggregering
- `src/dashboard.ts` — HTML rendering
- `src/test-dashboard.ts` — API-tester
