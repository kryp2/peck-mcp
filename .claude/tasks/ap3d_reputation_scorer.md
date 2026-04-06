---
priority: 3
complexity: medium
model: sonnet
depends_on: [ap1b_brc103_identity, ap3a_arcade_integration]
verify: true
test_cmd: "npx tsx src/test-reputation.ts"
---

# AP3D: Agentic Reputation Scorer

## Mål
On-chain reputation-system som tracker kontraktsoppfyllelse, feilrate, 
og responstid. Brukes av CNP manager ved oppgavedelegering.

## Oppgaver

### 1. Reputation data model
- Per agent (identifisert via BRC-103 identity):
  - `tasks_completed`: number
  - `tasks_failed`: number  
  - `avg_response_ms`: number
  - `total_earned_satoshis`: number
  - `dispute_rate`: number (0.0-1.0)
  - `last_active`: timestamp
- Trust score = weighted composite (0-100)

### 2. Event collection
- Lytt på BSV-transaksjoner via ARCADE SSE
- Parse OP_RETURN for completion/dispute events
- Oppdater in-memory reputation store

### 3. Query API
- `GET /reputation/:agentId` → trust score + breakdown
- `POST /reputation/batch` → bulk lookup (for CNP evaluation)
- Kost: 5 satoshis per query (mikrotjeneste-mønster)

### 4. On-chain anchoring
- Periodisk (hvert 100. event): anchor snapshot til BSV
- OP_RETURN: JSON med aggregerte scores
- Verifiserbart: enhver agent kan lese historisk reputation

### 5. Test
- Simuler 10 transaksjoner, verifiser at reputation oppdateres korrekt

## Filer
- `src/reputation.ts` — nytt
- `src/test-reputation.ts` — nytt
