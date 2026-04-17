# Peck Pay — Current Status

> **Read this first when continuing the project.** Supersedes MORNING.md.
> Last updated: 2026-04-08, end of dag 2.

## Where we are

We've shipped **dag 1 + dag 2** of the 9-day hackathon plan and are
1.5 days ahead of schedule. The project has pivoted from "BRC-100
marketplace + force 1.5M tx" to **"MCP-as-onboarding for BSV agentic
payments"** — see the strategic reframe at the bottom.

The thing that works end-to-end:

```
   Anyone installs peck-mcp in their Claude Desktop / Cursor / etc.
                              │
                  fresh wallet auto-generated
                              │
                  request faucet → 800 sat
                              │
                  build small UTXO ladder
                              │
   Claude says "use peck pay to ask an LLM why BSV scales"
                              │
   peck_list_services → discovers inference-balanced
                              │
   peck_call_service → 30 sat payment + parallel HTTP call
                              │
   real LLM response + 32-byte commitment in OP_RETURN on chain
                              │
   total time: ~30 seconds from blank install to verified on-chain proof
```

This is **not a hackathon stunt** — it's a real product loop.

## Architecture (current)

```
            ┌──────────────────────────────────────┐
            │  Any MCP client (Claude, Cursor,     │
            │  custom code, dumb bots)             │
            └──────────────┬───────────────────────┘
                           │ MCP json-rpc
            ┌──────────────▼───────────────────────┐
            │  src/mcp/peck-mcp.ts                 │
            │                                      │
            │  Tools (5 so far, ~7 by dag 7):      │
            │  - peck_list_services (filter+page)  │
            │  - peck_balance                      │
            │  - peck_wallet_info                  │
            │  - peck_request_faucet (testnet)     │
            │  - peck_call_service                 │
            │                                      │
            │  Auto-generates hot wallet at        │
            │  .peck-state/wallet.json on first    │
            │  start. Address-scoped agent label.  │
            └──┬─────────────────────────┬─────────┘
               │                         │
       ┌───────▼──────┐         ┌────────▼─────────┐
       │ Marketplace  │         │ src/ladder/      │
       │ Registry     │         │ + PaymentRifle   │
       │ (HTTP 8080)  │         │ + LadderClient   │
       │              │         │                  │
       │ Lists agents,│         │ Pre-built UTXO   │
       │ filters by   │         │ exact-fit leaves │
       │ capability   │         │ → direct ARC     │
       │              │         │ broadcast        │
       └──────┬───────┘         │                  │
              │                 │ 38 TPS sustained │
       ┌──────▼─────────────┐   │ proven testnet   │
       │ Service agents:    │   └──────────────────┘
       │ - inference-       │
       │   balanced (free)  │
       │   wraps OpenRouter │
       │   gpt-oss-20b      │
       │ - (more on dag 3)  │
       └────────────────────┘
```

## What works (verified end-to-end on testnet)

### Layer 1 — Pre-built UTXO ladder
- `src/ladder/arc.ts` — direct ARC broadcast (TAAL + GorillaPool round-robin
  for mainnet; testnet TAAL only since arc-test.gorillapool.io is NXDOMAIN)
- `src/ladder/db.ts` — knex/sqlite leaves table with atomic claim
- `src/ladder/builder.ts` — `buildFlatLadder()` makes N exact-fit P2PKH leaves
  in one setup tx
- `src/ladder/rifle.ts` — `PaymentRifle.fire()` claims leaf, builds 1-in-1-out
  tx (or 1-in-2-out with optional OP_RETURN), signs, broadcasts
- `src/ladder/client.ts` — `LadderClient.call()` binds payment + parallel
  HTTP call + 32-byte SHA256 commitment in OP_RETURN

**Proven sustained TPS:** 38.5 (single endpoint, single process, 60 parallel
rifles, 0% failure rate). Headroom 2.2× over hackathon 17 TPS requirement.
Mainnet should ~double via TAAL+GorillaPool sharding.

### Layer 2 — MCP server
- `src/mcp/peck-mcp.ts` — full MCP server, 5 tools live, lazy ladder init
- Auto-wallet at `.peck-state/wallet.json` (gitignored). Address-scoped label
  prevents stale leaves from previous test wallets being claimed.
- Faucet at `peck_request_faucet` sponsors from `worker1` (testnet only,
  rate-limited per address).
- Cached funding tx hex written to wallet json so build-tiny-ladder.ts can
  bypass WoC mempool indexing entirely.

### Layer 3 — One real LLM agent
- `src/agents/inference-agent.ts` — wraps a single OpenRouter model as a
  paid HTTP service. Spinnable with different MODEL/PORT/PRICE per instance.
- `src/ladder/openrouter.ts` — chat completions wrapper. 4 free-tier models
  picked: gemma-3-4b, gemma-3-12b, qwen3-coder, gpt-oss-120b.
- `OPENROUTER_API_KEY` set in `.env` (key burned in chat — must rotate post
  hackathon).

### Tools (`scripts/`)
| Script | Purpose |
|---|---|
| `build-tiny-ladder.ts` | Build N-leaf ladder. Supports `FUNDER=auto` (.peck-state/wallet.json), explicit `SEED_TXID/VOUT`, or auto-pick from WoC. |
| `fire-tiny-ladder.ts` | Fire all leaves of an owner agent against a recipient. |
| `sweep-ladder.ts` | Concurrency sweep with endpoint statistics. |
| `fire-meaningful-ladder.ts` | Stub-service + commitments + WoC verify (proves the meaningful-tx pattern). |
| `test-fresh-wallet-flow.sh` | Full e2e test: wipe → faucet → build → call. |
| `test-mcp-end-to-end.sh` | Earlier MCP integration test (pre-auto-wallet). |
| `demo-bedtime.sh` | **The polished demo.** Use this to show off the project. |

## Wallets state

- **worker1** `myKgxPgojoqkR9d2yTy1Bnx9fb61dG6uCP` — heavily fragmented from
  testing. ~135k sat across ~933 outputs. Biggest is now 1173 sat after the
  bedtime demo run. **Needs consolidation before next session if we want
  more big-UTXO operations.**
- **worker2** `myrdYvFjSEyvHAASo6c19rAXrVZwfAeb5S` — also fragmented. ~120k
  sat across ~730 outputs. Biggest 1050 sat.
- **gateway** in `.wallets.json` — untouched, not used for anything yet.
- **`.wallets-mainnet.json`** — generated mainnet wallets, not yet funded.
  Awaiting user's 2.7 BSV commitment for the real run.

**Cleanup task (dag 3 first thing):** Write `scripts/consolidate-dust.ts`
that takes ~50 dust UTXOs from worker1/worker2 and sweeps them into one
clean ~50k sat UTXO each. Then we have room to operate freely again.

## On-chain stamps (cumulative across all sessions)

- 8+ setup-tx-er bygd via vår builder
- ~1100+ ekte shot-tx-er fra ladder
- 21+ av dem med commitment-hash i OP_RETURN
- Bedtime demo: tx [`44fcbba0…`](https://test.whatsonchain.com/tx/44fcbba031a7cdf0771fecbb6487b086cd277e24d85acaf3765550a01db83239)
  bevisbart bundet via commitment til en gpt-oss-20b inference call

## Strategic reframe (post-dag 2)

The big realization that happened end of dag 2:

> **Peck Pay MCP isn't a hackathon trick to game 1.5M tx.**
> **It's a real onboarding layer for BSV via the MCP ecosystem.**

Math: 3000 active MCP installations × 100 service calls/day × 5x composition
= 1.5M tx/day. We don't have to manufacture volume; we have to ship a real
tool that people install. The hackathon target becomes the natural shape of
modest organic adoption.

The pitch reframes from:
- ❌ "We forced 1.5M tx as a stunt"
- ✅ "We built a tool so frictionless that 1.5M tx is a quiet Tuesday"

This changes every dag 3-9 priority. See PLAN.md for the updated roadmap.

## What's NOT done

### Hackathon-critical
- [ ] Consolidate worker1/worker2 dust → big UTXOs (dag 3 morning, ~30 min)
- [ ] Multi-host the reference agents (4-5 inference + 5 dumb services)
- [ ] **On-chain memory storage agent** (the BSV-killer-app idea — see PLAN)
- [ ] Open registration via `peck_register_agent` MCP tool
- [ ] Reputation index + on-chain Merkle anchor
- [ ] Workflow agents (research-agent, news-digest-agent) for composition
- [ ] Mainnet sanity test
- [ ] 24h pre-flight run
- [ ] Pitch video + README rewrite + submission

### Polish / nice-to-have
- [ ] Frontend dashboard (read-only, observatorium for humans)
- [ ] BSV Desktop Wallet integration via BRC-100 (cold wallet → MCP hot wallet)
- [ ] Auto-build ladder when peck_call_service has no ammo (UX polish)
- [ ] Per-MCP-connection wallets (multi-tenant support)

## Tomorrow morning — start here

1. **Read this file** (you just did)
2. **Read PLAN.md** for the updated 9-day roadmap with the strategic reframe baked in
3. **Run `./scripts/demo-bedtime.sh`** to see the current state work end-to-end
   (need worker1 to have ~1500 sat in one UTXO — may need to consolidate first)
4. **First task:** consolidate worker1/worker2 dust so we have room to operate
5. **Then:** sign up for [tavily.com](https://tavily.com) (free), put `TAVILY_API_KEY` in `.env`
6. **Then:** start dag 3 — multi-host reference agents + on-chain memory storage agent

## Known issues / sharp edges

- **WoC mempool indexing is unreliable on fresh tx.** Workaround: cached funding
  tx in auto-wallet json. Don't trust /unspent or /tx for txs <2 minutes old.
- **`alreadyKnown` ARC bug fixed** — was matching "already spent" as success,
  silently accepting double-spends. Now only matches "already in mempool/mined".
- **Bash `${var:-{}}` parser bug** — strips brace expansion wrong. Use explicit
  `if [ -z ]`. Fixed in mcp_call helpers.
- **Port 4003 collisions** when test scripts crash. Always `pkill -f` between runs.
- **OPENROUTER_API_KEY in chat history** — burn after hackathon, rotate.
- **Auto-wallet `.peck-state/wallet.json` is gitignored** but the burned key
  `mo2qFctoGRijGQQGnimCosDsru1LbHg41o` was committed in 2754757 then removed
  in 576a6de. Don't reuse that address.
