---
priority: 7
complexity: high
model: sonnet
depends_on: [ap3c_contract_net_protocol, ap5a_demo_agents, ap5d_oracle_agents]
verify: true
test_cmd: "npx tsx src/test-swarm.ts"
---

# AP7A: Agent Swarm Simulation Engine

## Mål
Discrete-event simulation av 5000 virtuelle agenter som genererer 
autentisk agentic trafikk. Ikke loop-spam — ekte agent-adferd.
Mål: 1.5M txs / 24h = ~17.4 TPS sustained.

## Kontekst fra rapport
"Rather than writing a simple, hardcoded loop to spam the network, 
the demo must showcase authentic agentic behavior. Implementer MAS 
swarm protocols fra SwarmBench og Tau-Bench."

## Agent Economy Composition
- **Orchestrator Agents (100)**: Genererer oppgaver via Poisson-distribusjon
- **Worker Agents (4000)**: Utfører mikrotjenester fra katalogen
- **Infrastructure Agents (900)**: Watchers, cache, reputation

## Oppgaver

### 1. Poisson traffic generator
- Stochastic task generation basert på Poisson-distribusjon
- Simuler enterprise traffic spikes og lulls over 24h
- Parameteriserbar: peak rate, off-peak rate, spike frequency

### 2. Agent spawner
- Spawn lightweight agent instanser (ikke ekte prosesser)
- Hvert agent-instans har: wallet, identity, capabilities
- In-memory message bus (ikke HTTP) for hastighet i simulering

### 3. Transaction loop
```
Orchestrator → CFP broadcast
Workers → bid (basert på load/capacity)
Orchestrator → reputation query (TX 1: micropayment)
Orchestrator → award task (escrow deposit)
Worker → execute (10-50 sub-tasks)
Worker → OP_RETURN result + streaming micropayments (TX 2-N)
```

### 4. TPS dashboard
- Live TPS counter
- Kumulativ transaction count
- Projeksjon: "vil nå 1.5M om X timer"
- Per-agent-type breakdown

### 5. Test
- Mini-swarm: 10 agents, 100 tasks, verifiser TPS

## Filer
- `src/swarm/engine.ts` — nytt
- `src/swarm/poisson-generator.ts` — nytt
- `src/swarm/agent-pool.ts` — nytt
- `src/test-swarm.ts` — nytt
