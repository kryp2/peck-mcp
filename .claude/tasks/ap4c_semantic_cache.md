---
priority: 4
complexity: medium
model: sonnet
depends_on: [ap2b_service_agent_framework]
verify: true
test_cmd: "npx tsx src/test-cache.ts"
---

# AP4C: Semantic Deduplication Cache Service

## Mål
Marketplace mikrotjeneste som intercepter LLM-prompts, genererer 
vector embeddings, og serverer cached responses for semantisk like queries.
Opptil 90% kostnadsreduksjon for gjentatte spørsmål.

## Kontekst fra rapport
Redis LangCache demonstrerer 90% reduksjon i API-kostnader og 15x 
akselerasjon. "What is the BSV tx fee?" og "How much does a BSV tx cost?" 
er semantisk identiske — cachen gjenkjenner dette.

## Oppgaver

### 1. Embedding generation
- Generer vector embedding av innkommende prompt
- Bruk lightweight embedding model (all-MiniLM-L6-v2 eller tilsvarende)
- Alternativ: simple cosine similarity med TF-IDF

### 2. Cache store
- In-memory vector store med cosine similarity search
- Threshold: >0.92 similarity = cache hit
- TTL per entry (default 1 time)
- Max cache size med LRU eviction

### 3. Marketplace integration
- Registrer som ServiceAgent med pris: 50 satoshis per query
- Før hvert LLM-kall: client sjekker cache
- Cache hit → returner cached response (skip LLM, spar $)
- Cache miss → route til LLM, lagre response i cache

### 4. Stats
- Hit rate, miss rate, estimated savings
- Eksporter til dashboard

### 5. Test
- 10 semantisk like queries → verifiser cache hits

## Filer
- `src/semantic-cache.ts` — nytt
- `src/test-cache.ts` — nytt
