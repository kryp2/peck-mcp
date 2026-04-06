---
priority: 5
complexity: medium
model: sonnet
depends_on: [ap2b_service_agent_framework]
verify: true
test_cmd: "npx tsx src/test-compute-agents.ts"
---

# AP5E: Compute & Cognitive Utility Agents

## Mål
Compute-as-a-Service agenter som tilbyr ephemeral execution, 
data transformation, og kognitive utilities.

## Kontekst fra rapport
"Agents kan purchase 10-millisecond execution windows of CPU time, 
paid per execution directly via BSV." WASM micro-compute services 
via MCP servers — dynamisk offloading uten cloud-abonnement.

## Agenter

### 1. Code Sandbox Agent ($0.01/execution)
- Kjør untrusted kode i isolert VM (vm2/isolated-vm)
- Input: { code, language, timeout_ms }
- Output: { result, stdout, execution_ms }
- Støtter: JavaScript, Python (via child_process)

### 2. Data Transform Agent ($0.005/kall)
- Input: { data, from_format, to_format }
- Støtter: JSON↔CSV, XML→JSON, Markdown→HTML, YAML→JSON
- Batch-modus for store datasett

### 3. Image Analysis Agent ($0.02/kall)
- Input: { image_url }
- Bruker Gemini Vision (gratis) for analyse
- Output: { description, objects[], text_detected }

### 4. Document Summarizer Agent ($0.01/kall)
- Input: { url } eller { text }
- Henter innhold, oppsummerer via LLM
- Output: { summary, key_points[], word_count }

### 5. Embedding Generator Agent ($0.003/kall)
- Input: { text }
- Genererer vector embedding (for semantic search)
- Output: { embedding: number[], model, dimensions }

## Filer
- `src/services/code-sandbox.ts` — nytt
- `src/services/data-transform.ts` — nytt
- `src/services/image-analysis.ts` — nytt
- `src/services/doc-summarizer.ts` — nytt
- `src/services/embedding-gen.ts` — nytt
- `src/test-compute-agents.ts` — nytt
