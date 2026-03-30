---
priority: 4
complexity: medium
model: sonnet
depends_on: [ap4a_provider_sdk]
verify: true
test_cmd: "npx tsx src/test-provider.ts"
---

# AP4C: Multi-Backend Support (Ollama, vLLM, TGI)

## Kontekst
Provider SDK maa stoette flere AI inference backends.
Worker har allerede Gemini/Ollama/Echo — utvid med vLLM og TGI.

## Oppgaver

### 1. Backend interface
```typescript
interface InferenceBackend {
  name: string;
  models(): Promise<string[]>;
  infer(model: string, prompt: string, params?: InferParams): Promise<InferResult>;
  health(): Promise<boolean>;
}
```

### 2. Implementasjoner
- **OllamaBackend**: HTTP til Ollama API (`/api/generate`)
- **VllmBackend**: OpenAI-compatible API (`/v1/completions`)
- **TgiBackend**: HuggingFace TGI API (`/generate`)
- **EchoBackend**: Test-backend (returnerer prompt)
- **GeminiBackend**: Google Gemini API (eksisterer i worker.ts)

### 3. Backend registry
- Provider registrerer tilgjengelige backends ved oppstart
- Auto-detect: probe kjente porter (11434=Ollama, 8000=vLLM, 8080=TGI)
- Rapporter tilgjengelige modeller til gateway

### 4. Routing
- Gateway kan spesifisere oensket modell i request
- Provider velger backend basert paa modell-tilgjengelighet
- Fallback-kjoede: primaer → sekundaer → echo

## Filer
- `src/backends/` — ny mappe med interface + implementasjoner
- `src/worker.ts` — refaktor til aa bruke backend registry
- `src/provider-sdk.ts` — integrer backend discovery
