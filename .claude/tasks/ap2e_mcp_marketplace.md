---
priority: 2
complexity: medium
model: sonnet
depends_on: [ap2b_service_agent_framework]
verify: true
test_cmd: "npx tsx src/test-mcp-server.ts"
---

# AP2E: MCP Marketplace Server

## Mål
Wrap markedsplassen som en MCP server — enhver AI-agent (Claude, Cursor, etc.)
kan oppdage og bruke mikrotjenester direkte via Model Context Protocol.
"USB-C porten" for AI-agent mikrotjenester.

## Oppgaver

### 1. MCP Server implementering
- Implementer MCP server (JSON-RPC over stdio/SSE)
- Tools = marketplace services (dynamisk fra registrerte agenter)
- Hver tool har:
  - Input schema (fra service agent definition)
  - Price info i description
  - Auto-402 payment handling

### 2. Tool discovery
- `marketplace_search` tool — søk tjenester på capabilities
- `marketplace_call` tool — kall en spesifikk tjeneste (auto-pay)
- `marketplace_balance` tool — sjekk wallet-saldo
- `marketplace_history` tool — se transaksjonshistorikk

### 3. Dynamic tool registration
- Når nye service-agenter registrerer seg, oppdater MCP tool list
- Hot-reload uten restart av MCP server
- Filter per budget/capability

### 4. Test
- Start MCP server, koble til som client, kall en tjeneste

## Filer
- `src/mcp-server.ts` — nytt
- `src/test-mcp-server.ts` — nytt

## Kontekst fra rapport
Anthropics MCP er "USB-C for AI" — Datamynts ecosystem-mcp server
gir perfekt teknologisk conduit. Ved å wrappe markedsplassen som MCP
får enhver LLM-client instant tilgang til hele mikrotjeneste-katalogen.
