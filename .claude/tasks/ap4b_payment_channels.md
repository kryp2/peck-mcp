---
priority: 4
complexity: high
model: sonnet
depends_on: [ap3a_arcade_integration, ap2a_zeta_crypto_core]
verify: true
test_cmd: null
---

# AP4B: Payment Channels for High-Frequency Agents

## Mål
Auto-negotiate payment channel når agent-par kommuniserer >10 kall/sek.
Hybrid arkitektur: async on-chain som default, channels for hot-path.

## Oppgaver

### 1. Channel negotiation
- Detect high-frequency pattern mellom agent-par
- Foreslå channel-åpning via BRC-103 message
- Begge parter signerer funding-tx

### 2. Off-chain updates
- Micropayment updates som signerte meldinger (ikke on-chain)
- Bare 2 on-chain txs: open + close (uansett antall updates)
- Latens = kun fysisk ping (<1ms)

### 3. Channel close
- Cooperative close: begge signerer final state
- Timeout close: etter inaktivitet, seneste state on-chain
- Dispute: siste signerte update vinner

### 4. Integration med ServiceAgent
- Transparent for service-agenten
- PaymentClient auto-switcher mellom on-chain og channel
- Dashboard viser aktive channels med oppdateringsrate
