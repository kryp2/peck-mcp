---
priority: 3
complexity: high
model: sonnet
depends_on: [ap2d_a2a_protocol, ap2b_service_agent_framework]
verify: true
test_cmd: "npx tsx src/test-cnp.ts"
---

# AP3C: Contract Net Protocol (CNP) — Desentralisert Oppgavefordeling

## Mål
Implementer auksjon-basert oppgavefordeling (Reid G. Smith, 1980) for 
dynamisk prisforhandling mellom AI-agenter. Manager-agenter kunngjør
oppgaver, worker-agenter byr, og manager velger basert på pris + reputation.

## Oppgaver

### 1. Call-for-Proposal (CFP) broadcast
- Manager-agent broadcaster oppgavekrav via A2A protocol
- CFP inneholder: task_type, requirements, max_price, deadline
- Workers som matcher capabilities mottar CFP

### 2. Bidding engine
- Worker-agenter evaluerer egen kapasitet og load
- Dynamisk prisberegning basert på:
  - Nåværende kø-lengde
  - Historisk responstid
  - Ressurskostnad (LLM tokens, compute)
- Submit bid med pris, estimert tid, SLA-garanti

### 3. Bid evaluation og delegering
- Manager sammenligner bids:
  - Pris (vekt: 40%)
  - Reputation score (vekt: 30%)
  - Estimert tid (vekt: 20%)
  - Agent capabilities match (vekt: 10%)
- Tildel oppgave til vinner, avvis resten

### 4. Commitment on-chain
- Off-chain forhandling via A2A JSON-RPC (rask, gratis)
- Kun CommitPayment → on-chain BSV (escrow eller direkte)
- OP_RETURN: hash av akseptert bid + task spec

### 5. Test
- 1 manager, 3 workers: broadcaster CFP, mottar bids, velger beste

## Filer
- `src/cnp-manager.ts` — nytt
- `src/cnp-worker.ts` — nytt  
- `src/test-cnp.ts` — nytt
