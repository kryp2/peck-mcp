---
priority: 6
complexity: low
model: sonnet
depends_on: [ap6b_cloud_run_deploy, ap5b_http402_protocol]
verify: true
test_cmd: "npx tsx src/demo.ts"
---

# AP6C: Open-Source Release + Docs + npm

## Kontekst
Publiser som open-source npm-pakke. Posisjonér som BSV payment infrastructure
for AI compute — ikke lukket marketplace.

## Oppgaver

### 1. npm-pakke struktur
- `@peck/agentic-pay` (scoped package)
- Eksporter: AgenticClient, AgenticProvider, ChannelManager
- TypeScript declarations inkludert
- Minimal dependencies

### 2. README
- Tydelig value prop: "BSV micropayments for AI compute"
- Quick start: 5 linjer for client, 5 linjer for provider
- Arkitektur-diagram (ASCII)
- Sammenligning med x402 og Bittensor

### 3. Eksempler
- `examples/simple-client.ts` — enkleste mulige client
- `examples/ollama-provider.ts` — Ollama som compute provider
- `examples/gateway-setup.ts` — sett opp egen gateway

### 4. Lisens og community
- MIT-lisens
- CONTRIBUTING.md
- GitHub Actions: CI (test + lint)
- npm publish workflow

## Filer
- `package.json` — oppdater for npm publish
- `README.md` — komplett dokumentasjon
- `examples/` — eksempler
- `.github/workflows/ci.yml` — CI pipeline
- `LICENSE` — MIT

## Viktig
- Fjern alle hardkodede testnet-noekler fra eksempler
- Bruk placeholder-verdier i docs
- Ingen `.wallets.json` i npm-pakke (.npmignore)
