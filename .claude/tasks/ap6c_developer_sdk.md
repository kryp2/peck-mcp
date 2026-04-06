---
priority: 6
complexity: medium
model: sonnet
depends_on: [ap2b_service_agent_framework, ap2c_client_agent, ap1c_http402_protocol]
verify: true
test_cmd: "npx tsx src/test-sdk.ts"
---

# AP6C: Developer SDK — "7 Lines of Code"

## Mål
Elegant, frictionless SDK som lar enhver utvikler registrere en 
mikrotjeneste eller konsumere en i under 5 minutter.
Stripe-inspirert developer experience — blockchain er usynlig.

## Kontekst fra rapport
"Stripe disrupted the industry by reducing payment integration to 
just 7 lines of code. The marketplace must offer elegant SDKs that 
allow a developer to register a microservice, set a price in USD, 
and generate an API key in under five minutes."

## Oppgaver

### 1. Provider SDK (supply side)
```typescript
import { PeckPay } from '@peck/pay';

const service = PeckPay.createService({
  name: "my-cool-service",
  price: "$0.005",  // auto-convert til satoshis
  handler: async (input) => {
    return { result: doSomething(input) };
  }
});

service.start();
```
- Abstraher alt: wallet, BSV, BRC-103, 402
- Auto-generate API key
- Zero blockchain knowledge required

### 2. Consumer SDK (demand side)
```typescript
import { PeckPay } from '@peck/pay';

const client = PeckPay.createClient({ budget: "$1.00" });
const result = await client.call("my-cool-service", { input: "hello" });
```
- Auto-discover, auto-pay, auto-retry
- Budget tracking i USD (ikke satoshis)
- Fiat mental model — BSV er usynlig

### 3. CLI tool
```bash
npx @peck/pay init           # scaffold service
npx @peck/pay register       # register on marketplace
npx @peck/pay test-call      # test your service
npx @peck/pay dashboard      # open web dashboard
```

### 4. NPM package structure
- Clean exports, TypeScript types
- README med "Getting Started in 2 minutes"
- Zero native dependencies

## Filer
- `src/sdk/index.ts` — nytt (main export)
- `src/sdk/provider.ts` — nytt
- `src/sdk/consumer.ts` — nytt
- `src/test-sdk.ts` — nytt
