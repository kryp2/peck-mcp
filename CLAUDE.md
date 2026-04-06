# hackathon-agentic-pay — "Peck Pay"

Open Run Agentic Pay hackathon — April 6-17, 2026.
AI-agent mikrotjeneste-markedsplass med BSV-mikrobetalinger.

## Konsept
Markedsplass der AI-agenter tilbyr og konsumerer mikrotjenester.
Betaling via BSV — ingen API-keys, ingen abonnement, ingen mellommenn.
Enhver tjeneste under $1 blir økonomisk mulig (BSV tx fee: $0.0001).

## Stack
- **Runtime:** Node.js + TypeScript (ESM) — orchestrator, HTTP, LLM
- **Crypto core:** Zeta lang — signing, tx building, UTXO management
- **Bridge:** ZeroMQ (Zeta ↔ TypeScript)
- **BSV:** @bsv/sdk (TypeScript), native intrinsics (Zeta)
- **Identity:** BRC-103 agent identity, SIWB-100 auth
- **Network:** ARC/ARCADE (SSE), Teranode WebSocket
- **Chronicle:** OTDA sighash 0x20, restored opcodes

## Architecture
```
┌─────────────────────────────────────────┐
│         Marketplace Dashboard           │
│    (React/HTML — live agent activity)   │
└──────────────┬──────────────────────────┘
               │ WebSocket
┌──────────────┴──────────────────────────┐
│         TypeScript Orchestrator          │
│  - HTTP 402 protocol (x402)             │
│  - Service discovery (BRC-103)          │
│  - LLM calls (strategy layer)          │
│  - Agent lifecycle management           │
└──────────────┬──────────────────────────┘
               │ ZeroMQ
┌──────────────┴──────────────────────────┐
│           Zeta Crypto Core              │
│  - ECDSA/Schnorr signing (<0.1ms)      │
│  - UTXO management (actor-isolated)    │
│  - Transaction building (CTFE)         │
│  - Teranode broadcast (WebSocket)      │
│  - BRC-100 capability scripts          │
└─────────────────────────────────────────┘
```

## Task blocks (30 tasks, 7 blocks)
- **Block 1** (pri 1): Foundation — Zeta env, BRC-103 identity, HTTP 402
- **Block 2** (pri 2): Core — Zeta crypto, service/client agent SDK, A2A protocol, MCP server, WASM
- **Block 3** (pri 3): Infrastructure — ARCADE SSE, Chronicle opcodes, CNP bidding, reputation, OP_VER overlay, recursive covenants
- **Block 4** (pri 4): Product — Dashboard webapp, payment channels, semantic cache, hero services (merdata/beviset/heltenig), metering engine
- **Block 5** (pri 5): Demo agents — 5+ standard agents, oracle/data feeds, compute agents, mainnet deploy, pitch
- **Block 6** (pri 6): Advanced — Off-chain EVM execution, WASM micro-compute, developer SDK
- **Block 7** (pri 7): Scale — Agent swarm simulation (5000 agents), 1.5M transaction demo harness

## Hackathon requirements
- 2+ AI agents with individual BSV wallets
- 1.5M meaningful on-chain transactions in 24h (~17 TPS)
- Agent discovery via BRC-100 + MessageBox
- Web UI showing agent activity
- Must solve a real problem (no spam/wash trading)

## Commands
```bash
npm install
npx tsx src/test-identity.ts   # Test BRC-103 identity
npx tsx src/test-402.ts        # Test HTTP 402 flow
npx tsx src/agent-service.ts   # Start a service agent
npx tsx src/agent-client.ts    # Start client agent
```

## Networks
- Testnet: Chronicle active since block 1,713,168
- Mainnet: Chronicle activates April 7, 2026 (block 943,816)
- ARC: https://arc.gorillapool.io
- Explorer: https://whatsonchain.com
