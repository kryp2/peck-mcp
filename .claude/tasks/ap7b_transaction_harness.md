---
priority: 7
complexity: medium
model: sonnet
depends_on: [ap7a_swarm_simulation, ap5b_mainnet_deploy]
verify: true
test_cmd: "npx tsx src/test-harness.ts"
---

# AP7B: 1.5M Transaction Demo Harness

## Mål
Produksjonsklar harness som kjører 24h og demonstrerer 1.5M 
meningsfulle transaksjoner. Alt monitoreres, logges, og vises live.

## Kontekst fra rapport
"Teranode absorbs 17.4 TPS effortlessly. The system must maintain 
average throughput by parameterizing the discrete-event simulation 
to ensure every high-level task breaks down into dozens of required 
telemetry, caching, and state-verification microservices."

## Oppgaver

### 1. Harness orchestrator
- Start swarm engine med production-parametere
- Mål: 15-45 TPS (organisk variasjon via Poisson)
- Self-healing: restart agents som feiler
- Budget guard: stopp hvis wallet balance < threshold

### 2. Transaction breakdown per task
Hver high-level task genererer multiple txs:
- 1x reputation query (micropayment for data)
- 1x escrow/commitment
- 10-50x micropayments (streaming for sub-tasks)
- 1x completion anchor (OP_RETURN med resultat-hash)
- 1x settlement (final payment)
= 13-53 txs per task → trenger ~30 000 tasks/24h

### 3. Monitoring dashboard
- Live TPS gauge (target: green zone 15-45)
- Cumulative tx counter med projeksjon
- Agent health: online/offline/error
- Wallet balance burndown chart
- BSV cost tracking (estimated $1-5 for full demo)

### 4. Recovery & resilience
- Checkpoint hvert 10. minutt (progress saved)
- Resume fra siste checkpoint ved crash
- Automatic UTXO pool refill ved lav balance

### 5. Final report
- Auto-generert rapport etter 24h:
  - Total transactions, TPS avg/peak/min
  - Unique agents, services consumed
  - BSV spent, cost per transaction
  - WoC explorer links til largest batches

## Filer
- `src/harness/runner.ts` — nytt
- `src/harness/monitor.ts` — nytt
- `src/harness/checkpoint.ts` — nytt
- `src/test-harness.ts` — nytt
