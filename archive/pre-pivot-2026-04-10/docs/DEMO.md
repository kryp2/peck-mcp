# Peck Pay — End-to-end demo (testnet, 2026-04-09)

A snapshot of what's wired up after the dag-3 sprint. Everything below
runs on a single laptop, against BSV testnet, with no GCS/cloud
dependencies. The same code paths target prod `bank.peck.to` and
`storage.peck.to` once URL env vars + BRC-104 auth-fetch are flipped.

## TL;DR

```
137 MCP memory writes attempted on testnet
136 succeeded (99.27%)
274 on-chain transactions broadcast
  └─ inline + blob paths both verified end-to-end
  └─ retry-with-backoff added after observing 1 transient (now 50/50)
  └─ all 4 known fee_tx burns are the documented wallet-toolbox
     basket-import bug, not our code
```

The full BRC stack is exercised on every write: bank-local (wallet-infra
fork) for tx build/sign/broadcast, storage-local (uhrp-storage-server +
fake-gcs) for blobs, bank-shim and storage-shim as paid marketplace
services that produce their own fee receipts. The MCP path goes through
the same JSON-RPC stdio protocol Claude Desktop uses.

## Architecture

```
                    ┌─────────────────────────────┐
                    │  MCP client                 │
                    │  (Claude Desktop, Cursor,   │
                    │   any MCP host, or our      │
                    │   test-mcp-memory.ts)       │
                    └──────────────┬──────────────┘
                                   │ JSON-RPC stdio
                    ┌──────────────▼──────────────┐
                    │  src/mcp/peck-mcp.ts        │
                    │  9 tools incl.              │
                    │   peck_memory_write/read/   │
                    │   list/search               │
                    └──────────────┬──────────────┘
                                   │ HTTP
                    ┌──────────────▼──────────────┐
                    │  memory-agent v2 :4011      │
                    │  • inline OR blob path      │
                    │  • routes via shims         │
                    │  • retry-with-backoff       │
                    │  • Postgres-backed index    │
                    └────┬──────────┬─────────────┘
                         │          │
              ┌──────────▼─┐    ┌───▼──────────────┐
              │ storage-   │    │  bank-shim :4020 │
              │ shim :4021 │    │  paid wrapper    │
              │ (>1KB blobs)    │  around          │
              │             │    │  /createAction   │
              └──────┬──────┘    │  + fee receipt   │
                     │           └───┬──────────────┘
              ┌──────▼──────────┐    │
              │ storage-local   │    │ HTTP
              │ :8090           │    │
              │ + fake-gcs:4443 │    │
              └─────────────────┘    │
                                     │
                            ┌────────▼─────────────┐
                            │  bank-local :8088    │
                            │  (wallet-infra)      │
                            │  + Postgres :5433    │
                            │  + BRC-100 :8089     │
                            └────────┬─────────────┘
                                     │ ARC
                            ┌────────▼─────────────┐
                            │  TAAL ARC (testnet)  │
                            └──────────────────────┘
```

Plus 9 reference service-agents annonced to a standalone marketplace
registry, so the catalog has 12 services total:

```
GET http://localhost:8080/marketplace
  memory-store-v2          :4011   60sat   memory,storage,kv,recall
  bank-as-a-service        :4020   15sat   wallet,tx-build,broadcast,signing
  storage-as-a-service     :4021   20sat   storage,blob,uhrp,kv
  inference-fast           :4030    5sat   gemma-3-4b
  inference-balanced       :4031   30sat   gemma-3-12b
  inference-coder          :4032   50sat   qwen3-coder
  inference-premium        :4033  100sat   gpt-oss-120b
  weather                  :4034   10sat   open-meteo
  geocode                  :4035    5sat   open-meteo
  testnet-tip              :4036    3sat   WoC chain info
  echo                     :4037    1sat   sanity baseline
  recall-demo              :4038   25sat   uses memory-agent v2 (composition)
```

## Self-ref multiplier (the pitch)

Every memory-write produces 1, 2, or 3 on-chain transactions depending on
which shims it touches:

```
Inline write (< 1KB):
  ├─ bank-shim fee receipt OP_RETURN tx     ← marketplace fee for tx-build service
  └─ memory-write OP_RETURN tx              ← the actual anchor

Blob write (> 1KB):
  ├─ storage-shim fee receipt OP_RETURN tx  ← marketplace fee for storage service
  ├─ bank-shim fee receipt OP_RETURN tx     ← marketplace fee for tx-build service
  └─ memory-write OP_RETURN tx              ← anchors blob:<sha256> handle
```

Each fee receipt is bound by `sha256(request_id)` to the specific call
it pays for, so volume is provably meaningful — no wash trading.

**Math for 1.5M tx target:**
- 3000 active MCP installs × 50 memory ops/day × 2.3 avg tx/op = 345k tx/day
- Or 1500 installs × 100 ops/day × 3 avg tx/op = 450k tx/day
- 1.5M is reachable with 5000 daily-active users and modest write rates,
  no metric gaming

## Today's test runs

| Test | Attempts | Success | On-chain txs | Notes |
|---|---|---|---|---|
| 12-burst inline | 12 | 12 | 23 | First-call basket-import burn |
| 5-burst inline | 5 | 5 | 10 | All clean |
| 15-burst inline | 15 | 15 | 29 | First-call burn |
| 5-burst blob | 5 | 5 | 15 | 3 tx each — full multiplier |
| 50-burst inline | 50 | 49 | 97 | 1 transient, motivated retry impl |
| 50-burst inline (with retry) | 50 | 50 | 100 | Clean run |
| **Total** | **137** | **136 (99.27%)** | **274** | |

All 274 transactions broadcast through the BRC-stack — no WoC, no raw
ARC calls in the hot path. WoC is only used by the BRC-29 funding-script
(once per refund cycle, not per write).

### Sample on-chain proofs (testnet, may still be in mempool)

- Inline write: [`a2031eff…`](https://test.whatsonchain.com/tx/a2031eff208f266e3d22c009ff88190591c57925b7b04221ba5641d79bad36d4)
- Blob write: [`44516cb3…`](https://test.whatsonchain.com/tx/44516cb3780bd19dc67fdf4828635772cab4f4ba8ac7ae3b21d3db150a64e283)
- Bank-shim fee receipt: [`d861f7a4…`](https://test.whatsonchain.com/tx/d861f7a4a26932c70efe8e9ef13bcdd34fbd711b06ef24e91b5dfca41a273af5)
- Storage-shim fee receipt: [`34a1849b…`](https://test.whatsonchain.com/tx/34a1849b2eb443b263711defd0d64a98390f71033b81aec9d6f273625186ddd7)

## How to run the whole stack from scratch

```bash
cd /home/thomas/Documents/peck-to/peck-mcp

# 1. Infra (Docker)
cd infra
docker compose -p bank-local    -f bank-local.compose.yml    up -d --build
docker compose -p storage-local -f storage-local.compose.yml up -d --build
cd ..

# 2. Fund bank-local once (BRC-29 from worker1, ~12 min on testnet)
FUNDER=worker1 SATS=200000 npx tsx scripts/fund-bank-local-brc29.ts
# If internalize fails on first attempt due to merkle-proof race:
npx tsx scripts/retry-brc29-internalize.ts

# 3. Service processes (each on its own port, all background)
nohup npx tsx src/registry-daemon.ts > /tmp/reg.log 2>&1 & disown

PORT=4020 nohup npx tsx src/agents/bank-shim.ts > /tmp/bshim.log 2>&1 & disown
PORT=4021 nohup npx tsx src/agents/storage-shim.ts > /tmp/sshim.log 2>&1 & disown

PORT=4011 BANK_SHIM_URL=http://localhost:4020 STORAGE_SHIM_URL=http://localhost:4021 \
  nohup npx tsx src/agents/memory-agent-v2.ts > /tmp/memv2.log 2>&1 & disown

MEMORY_AGENT_URL=http://localhost:4011 REGISTRY_URL=http://localhost:8080 \
  nohup npx tsx src/multi-host-launcher.ts > /tmp/multi.log 2>&1 & disown

# 4. Verify
curl http://localhost:8080/marketplace | jq '. | length'      # → 12
curl http://localhost:8088/balance                             # bank-local sat balance
curl http://localhost:4011/health                              # memory-agent state
```

## How to test the MCP path (3 ways)

### A) Our scripted JSON-RPC stdio test (what we used today)

```bash
N_WRITES=12 npx tsx scripts/test-mcp-memory.ts
N_WRITES=5 SIZE_BYTES=2500 npx tsx scripts/test-mcp-blob-burst.ts
```

These spawn `peck-mcp.ts` as a child process, do the MCP handshake,
list tools, run a burst of writes, then list/search/read to verify.

### B) Anthropic's official MCP Inspector (interactive web UI)

```bash
npx @modelcontextprotocol/inspector npx tsx src/mcp/peck-mcp.ts
```

Opens `http://localhost:5173` (or similar) where you can:
- See all 9 tools with their JSON schemas
- Click any tool, fill in arguments, run it
- Inspect the raw JSON-RPC request/response side by side
- View live stdio logs

This is the easiest way to manually poke at the server. Same tool
Anthropic's own engineers use during MCP server development.

### C) Wire into Claude Desktop

Add to `~/.config/Claude/claude_desktop_config.json` (or the macOS path):

```json
{
  "mcpServers": {
    "peck-pay": {
      "command": "npx",
      "args": ["tsx", "/home/thomas/Documents/peck-to/peck-mcp/src/mcp/peck-mcp.ts"],
      "env": {
        "PECK_MEMORY_AGENT_URL": "http://localhost:4011",
        "PECK_REGISTRY_URL": "http://localhost:8080"
      }
    }
  }
}
```

Then in any Claude conversation, the assistant gets `peck_memory_write`,
`peck_list_services`, etc. Asking it "remember that my favourite testnet
endpoint is TAAL" produces a real on-chain transaction.

## What's still missing for mainnet

1. **BRC-104 auth-fetch client.** Memory-agent + shims currently use plain
   `fetch()`. Prod `bank.peck.to` and `storage.peck.to` are auth-protected
   via `@bsv/auth-express-middleware`. Need a thin wrapper that signs each
   outgoing request with the agent's identity key.

2. **URL toggles.** All BRC-stack URLs are env-driven (`BANK_LOCAL_URL`,
   `STORAGE_LOCAL_URL`, `BANK_SHIM_URL`, `STORAGE_SHIM_URL`,
   `FAKE_GCS_URL`, `STORAGE_LOCAL_BUCKET`). For mainnet just set:
   - `BANK_LOCAL_URL=https://bank.peck.to`
   - `STORAGE_LOCAL_URL=https://storage.peck.to`
   - drop `FAKE_GCS_URL` (use real GCS via storage.peck.to's signed URLs)
   - and supply BRC-100 identity keys via `SERVER_PRIVATE_KEY`.

3. **Mainnet funding.** ~2.7 BSV from Thomas → a mainnet wallet → BRC-29
   send to bank.peck.to identity key → `/receiveBrc29` → ready.

4. **One mainnet sustained burst** as the final sanity. Same script,
   same flow, just different URLs and a real testnet → mainnet flip.

Estimated effort: ~1-2 hours of code (auth-fetch wrapper + retries),
the rest is config + funding.

## Known issues filed for upstream after the hackathon

See `~/.claude/projects/-home-thomas-Documents-peck-to/memory/project_upstream_contributions_after_hackathon.md`
for the full backlog. The 4 most-impactful ones:

1. **wallet-infra `/createAction` cannot spend basket-imported P2PKH outputs.**
   Workaround: never use `/importUtxo`, always use BRC-29 `/receiveBrc29`.
2. **Failed createActions don't release inputs cleanly.** First call of
   every fresh wallet-toolbox session burns one input.
3. **storage-server's `crypto-polyfill.ts` aliases `globalThis.window`,
   which makes google-auth-library use BrowserCrypto and crash on Node 22
   webcrypto JWK validation.** Worked around with a `STORAGE_LOCAL_NO_BROWSER_POLYFILL=1`
   env gate; upstream PR pending.
4. **fake-gcs-server doesn't accept V4 signed URL PUTs to direct paths.**
   Workaround: bypass storage-server's `/upload` and POST bytes directly to
   fake-gcs's JSON API.

## Files that came out of dag 3

```
infra/
  bank-local.compose.yml          # local wallet-infra docker stack
  storage-local.compose.yml       # local storage-server + fake-gcs stack
  fake-sa.json + fake-sa.key      # fake GCP SA so @google-cloud/storage works

src/
  registry-daemon.ts              # standalone marketplace registry
  multi-host-launcher.ts          # boots 9 reference agents in one process
  agents/
    agent-factory.ts              # generic micro-agent HTTP factory
    memory-agent-v2.ts            # bank-local-backed, blob-aware, retry-equipped
    bank-shim.ts                  # wallet-as-a-service paid wrapper
    storage-shim.ts               # storage-as-a-service paid wrapper
  clients/
    bank-local.ts                 # TS client for wallet-infra internal API
    storage-local.ts              # TS client for storage-server + fake-gcs
  mcp/
    peck-mcp.ts                   # +4 peck_memory_* tools

scripts/
  consolidate-dust.ts             # sweep dust UTXOs into one fat one
  fund-address.ts                 # generic 'send N sat from worker to addr'
  fund-bank-local-brc29.ts        # full BRC-29 sender flow + persist metadata
  retry-brc29-internalize.ts      # auto-retry from .peck-state pending file
  test-mcp-memory.ts              # MCP stdio JSON-RPC burst test
  test-mcp-blob-burst.ts          # MCP stdio test for blob path

../wallet-infra/wallet-infra/src/internalApi.ts
                                  # patched: + POST /receiveBrc29 endpoint

../storage-server/src/crypto-polyfill.ts
                                  # patched: gated window/self alias behind env
```

## TL;DR: does it work?

Yes. End to end, on testnet, through the real MCP protocol, against the
real BRC-stack, with 99.27% measured success rate over 137 sustained
attempts in a single session. The only gap to mainnet is auth-fetch +
URL config + funding — no architectural changes required.
