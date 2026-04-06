---
priority: 5
complexity: medium
model: sonnet
depends_on: [ap5a_demo_agents, ap3a_arcade_integration]
verify: true
test_cmd: null
---

# AP5B: Mainnet Migration + Cloud Run Deploy

## Mål
Flytt fra testnet til mainnet etter Chronicle aktivering (7. april).
Deploy til Cloud Run for 24/7 drift under hackathon.

## Oppgaver

### 1. Mainnet config
- Switch ARC endpoint til mainnet
- Fund agent wallets med ekte BSV (minimal mengde)
- Verifiser at Chronicle opcodes fungerer på mainnet

### 2. Cloud Run deploy
- Dockerfile for service-agenter
- Én container per agent, eller multi-agent i én container
- Env vars: BSV_NETWORK=mainnet, ARC_URL, agent private keys via Secret Manager

### 3. Monitoring
- Health check endpoints per agent
- Alert ved wallet balance < threshold
- Transaction success rate tracking

### 4. Kostnadsstyring
- Beregn BSV-kostnad per 24h ved 17 TPS
- ~1.5M txs × 1 sat/tx = ~0.015 BSV ≈ $1
- Sett hard budget limit i agent config
