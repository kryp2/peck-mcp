---
priority: 2
complexity: medium
model: sonnet
depends_on: [ap1b_brc103_identity, ap1c_http402_protocol]
verify: true
test_cmd: "npx tsx src/test-a2a.ts"
---

# AP2D: Agent-to-Agent (A2A) Protocol Layer

## Mål
Implementer Google A2A-inspirert protokoll for strukturert agent-kommunikasjon.
Skiller seg fra MCP (tool execution) — A2A handler forhandling, 
oppgavedelegering, og status-oppdateringer mellom autonome agenter.

## Oppgaver

### 1. JSON-RPC 2.0 meldingsformat
- Definer A2A message types:
  - `agent/discover` — forespør capabilities
  - `agent/negotiate` — forhandlePris/SLA
  - `agent/delegate` — deleger oppgave
  - `agent/status` — oppdater fremdrift
  - `agent/complete` — lever resultat
- Alle meldinger har BRC-103 signatur

### 2. Agent Card
- Hver agent publiserer en "Agent Card" (JSON):
  ```json
  {
    "name": "translate-agent",
    "capabilities": ["translate", "detect-language"],
    "pricing": { "translate": 500 },
    "endpoint": "https://...",
    "identity": "<brc103-txid>",
    "protocols": ["a2a", "mcp", "http402"]
  }
  ```
- Publiseres til MessageBox overlay + tilgjengelig via GET /.well-known/agent.json

### 3. Task lifecycle
- Implementer task states: submitted → working → completed/failed
- Streaming artifacts via SSE under working-state
- Timeout og retry-logikk

### 4. Test
- `test-a2a.ts`: To agenter forhandler pris og delegerer en oversettelsesoppgave

## Filer
- `src/a2a-protocol.ts` — nytt
- `src/agent-card.ts` — nytt
- `src/test-a2a.ts` — nytt
