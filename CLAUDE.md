# hackathon-agentic-pay

Open Run Agentic Pay hackathon — April 6-17, 2026.
Two AI agents trading via BSV micropayments. 1.5M TXs in 24h.

## Stack
- **Runtime:** Node.js + TypeScript (ESM)
- **BSV:** @bsv/sdk for transactions, @bsv/simple for high-level wallet ops
- **Network:** Testnet (Chronicle active), switch to mainnet for competition
- **Broadcasting:** ARC/Arcade via `https://arc.gorillapool.io`
- **P2P:** MessageBox for agent discovery + BRC-103 auth

## Architecture
- **Strategy layer** (LLM): periodic calls to adjust pricing/rules (~every 5 min)
- **Execution layer** (reflex): deterministic hot loop at ~17 TPS
- Agent A ("Adam"): data provider, sells resources
- Agent B ("Eva"): data consumer, buys and analyzes

## Key files
- `src/agent-a.ts` — Adam agent (provider)
- `src/agent-b.ts` — Eva agent (consumer)
- `src/test-tx.ts` — Basic SDK/wallet test

## Hackathon requirements
- 2+ AI agents with individual BSV wallets
- 1.5M meaningful on-chain transactions in 24h (~17 TPS)
- Agent discovery via BRC-100 + MessageBox
- Web UI showing agent activity
- Must solve a real problem (no spam/wash trading)

## Commands
```bash
npm install
npm run test       # Test SDK + generate wallets
npm run agent:a    # Start Adam
npm run agent:b    # Start Eva
```

## Testnet
- Explorer: https://test.whatsonchain.com
- ARC: https://arc.gorillapool.io
- Chronicle active since blokkhøyde 1,713,168 (Jan 2026)
- Mainnet Chronicle: April 7, 2026 (blokkhøyde 943,816)
