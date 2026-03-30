---
priority: 6
complexity: medium
model: sonnet
depends_on: [ap6a_mainnet_migration]
verify: true
test_cmd: "echo 'Manual deploy verification'"
---

# AP6B: Gateway Cloud Run + Monitoring

## Kontekst
Deploy gateway som Cloud Run service. Same pattern som peck-ink.

## Oppgaver

### 1. Dockerfile
- Multi-stage build: builder (npm ci + tsc) → runner (node:20-slim)
- Kopier kun kompilerte JS-filer + node_modules
- Health check endpoint: `GET /health`

### 2. Cloud Run config
- GCP prosjekt: `gen-lang-client-0447933194`
- Service: `agentic-pay-gateway`
- Min instances: 1 (alltid varm for channels)
- Max instances: 3
- Memory: 512Mi, CPU: 1
- Env vars via Secret Manager (private keys)

### 3. Cloud Build
- `cloudbuild.yaml` — build + deploy pipeline
- Trigger: push to main branch
- Inkluder: npm test foer deploy

### 4. Monitoring
- Cloud Logging: strukturert JSON logging
- Custom metrics: requests/s, channels active, TX broadcast
- Alert policy: >5% error rate → PagerDuty/email
- Dashboard i Cloud Monitoring

## Filer
- `Dockerfile` — ny fil
- `cloudbuild.yaml` — ny fil
- `.gcloudignore` — ny fil
- `src/logger.ts` — strukturert logging

## Viktig
- GCP prosjekt-ID: `gen-lang-client-0447933194` (ALLTID dette)
- Private keys i Secret Manager, ALDRI i env vars direkte
- Min 1 instance — channels maa overleve request-gaps
