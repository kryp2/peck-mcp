---
priority: 5
complexity: medium
model: sonnet
depends_on: [ap2c_channel_hotloop]
verify: true
test_cmd: "npx tsx src/test-agent-sdk.ts"
---

# AP5A: Agent SDK — Pay-Per-Call Interface

## Kontekst
Client-side SDK for AI agenter som vil kjoope compute.
Maa vaere like enkelt som aa kalle OpenAI API — men med BSV betaling.

## Oppgaver

### 1. AgenticClient klasse
```typescript
const client = new AgenticClient({
  privateKey: "hex...",
  gateway: "https://gateway.example.com",
  maxCostPerCall: 100,  // satoshis
  autoChannel: true,     // aapne payment channel automatisk
});

const result = await client.infer({
  model: "llama3",
  prompt: "Explain BSV payment channels",
  maxTokens: 500,
});
// result.response, result.cost, result.txid
```

### 2. Automatisk channel management
- Foerste kall: aapne channel med gateway
- Etterfoolgende kall: off-chain updates
- Auto-topup naar channel er nesten tom
- Graceful close ved shutdown

### 3. Kostnads-kontroll
- maxCostPerCall — avvis for dyre requests
- dailyBudget — stopp naar dagsbudsjett er brukt
- Kostnadsestimat foer kall (gateway returnerer pris)

### 4. Streaming support
- `client.inferStream()` — SSE streaming
- Betaling per chunk (off-chain channel update per N tokens)
- Abort-stoette — stopp streaming, betal kun for mottatte tokens

## Filer
- `src/agent-sdk.ts` — ny fil
- `src/test-agent-sdk.ts` — tester
- `examples/simple-agent.ts` — eksempel

## Viktig
- SDK maa fungere i Node.js 18+ og Bun
- Zero config for testnet (auto-detect nettverk)
- Eksporterbar som npm-pakke
