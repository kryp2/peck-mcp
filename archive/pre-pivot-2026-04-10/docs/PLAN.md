# Peck Pay — 9-day Plan (post-strategic-reframe)

> Last updated: 2026-04-08, end of dag 2.
> Strategy: build a real product, not a hackathon stunt. The 1.5M tx target
> follows naturally from organic MCP adoption.

## The thesis (the one sentence)

> *"Peck Pay is the first MCP server that turns the entire LLM-tool ecosystem
> into a BSV agent marketplace. Install it, and any Claude/Cursor/MCP-client
> user can buy real services from real agents using sub-cent on-chain
> payments — without ever touching crypto manually."*

This is what we're building toward. Every dag 3-9 decision should be tested
against: *"does this make peck-mcp easier to install, more useful when
installed, or more compelling to demo?"*

## Why this beats every other agentic-pay attempt

| Solution | Friction |
|---|---|
| ETH-based agent payments | Gas math, manual on-ramp, $5+ per call |
| Lightning agent payments | Channel management, liquidity, restricted to BTC |
| Stripe-for-AI subscriptions | Subscription model, no per-call billing, vendor lock |
| Prepaid API credit pools | Centralized, vendor-specific, no composability |
| **Peck Pay MCP** | Zero setup, sub-cent calls, composes with any MCP client |

**The unique unlock:** MCP is the first interface where the LLM does all
the wallet management *for the user*. The user never sees a private key,
never manages gas, never thinks about crypto. They just say "do this thing"
and Claude handles `peck_list_services` + `peck_call_service` invisibly.

## What's done (dag 1 + dag 2)

- ✅ Pre-built UTXO ladder architecture, 38 TPS sustained, 0% failure
- ✅ OP_RETURN commitments binding on-chain tx to off-chain service calls
- ✅ MCP server (`src/mcp/peck-mcp.ts`) with 5 tools, scales to 1000+ services
  via filter+sort+paginate
- ✅ Auto-generated hot wallet on first MCP boot
- ✅ Testnet faucet sponsored from worker1
- ✅ Cached funding tx pattern (bypasses WoC mempool lag)
- ✅ One real LLM agent (`inference-balanced` wrapping OpenRouter free tier)
- ✅ End-to-end demo: fresh wallet → faucet → ladder → service call → real
  LLM response + on-chain proof, all in ~30 seconds

## What's coming (dag 3 → dag 9)

### Dag 3 (estimated 4-6h) — more agents, less friction

1. **Consolidate dust** (~30 min) — `scripts/consolidate-dust.ts`. Sweeps
   ~50 dust UTXOs from worker1/worker2 into one big clean UTXO each. Fixes
   the fragmentation we've accumulated through testing.

2. **Multi-host reference agents** (~2h) — one orchestrator script that
   spawns ALL the seller agents as child processes:
   - `inference-tiny` — gemma-3-4b:free, 5 sat
   - `inference-balanced` — gemma-3-12b:free, 30 sat
   - `inference-coder` — qwen3-coder:free, 50 sat
   - `inference-big` — gpt-oss-120b:free, 100 sat
   - `weather` — open-meteo wrapper, 20 sat
   - `wikipedia` — wikipedia API wrapper, 10 sat
   - `web-search` — Tavily wrapper, 50 sat (needs Tavily key)
   - `crypto-price` — CoinGecko wrapper, 5 sat

3. **🌟 On-chain memory storage agent** (~1-2h) — **the killer BSV-specific
   agent.** This is the user's late-night realization that ties the whole
   pitch together.
   - `peck/memory-write` (60 sat) → POST `{namespace, key, value}`, returns
     `{txid, vout, hash}` — value goes into OP_RETURN, handle returned
   - `peck/memory-read` (5 sat) → GET data by `{namespace, key}` → returns
     value + verification proof
   - `peck/memory-list` (10 sat) → list keys in a namespace
   - `peck/memory-pin` (100 sat) → request long-term retention guarantee
   - `peck/memory-search-tag` (20 sat) → find memories by tag
   - **Why this is the killer feature:** BSV is the only chain where on-chain
     persistent memory at sub-cent prices is economically viable. ETH would
     be $5-50 per write. Solana has size limits. Filecoin is for big files,
     not key-value. AGENTS NEED PERSISTENT MEMORY between runs and existing
     solutions (Postgres, Redis, S3) all require account setup, vendors,
     monthly bills. Peck Pay memory-agent: 60 sat per write, no account,
     no vendor, kryptografisk verifiserbart, permanent.
   - **Why it scales the marketplace:** every workflow agent that has state
     between runs uses memory-agent. Composition multiplier explodes. A
     news-digest-agent that remembers what it published yesterday calls
     memory-write at the end of each cycle. 100 agents × 10 reads/writes
     per minute = 1.4M tx/day from memory traffic alone.
   - **Why it sticks people:** unlike one-shot LLM calls, memory creates
     ongoing relationships. Once an agent has data in Peck Pay memory, it
     keeps coming back. Retention loop built in.
   - **Tagline for pitch:** *"Agent recall as a service. The first storage
     layer where you pay only when you remember."*

4. **Sign up for Tavily** (~5 min, user task) — register at tavily.com,
   put `TAVILY_API_KEY=...` in `.env`. Blocks `web-search` agent above.

### Dag 4 (estimated 4-5h) — trust + composition

1. **Reputation index** (~2h) — extends the existing `src/metering.ts`
   pattern. Off-chain rolling stats per agent, periodic Merkle root
   anchored to BSV via OP_RETURN. New MCP tool `peck_get_reputation`.
   New service `reputation-agent` that sells lookups for 1 sat.

2. **`peck_register_agent` MCP tool** (~1h) — POSTs agent manifest to
   marketplace registry's `/announce`. Allows third parties to plug in
   their own agents from any MCP client. The pitch-winning move.

3. **`peck_dispute` MCP tool** (~1h) — challenge a bad service result.
   Decrements the agent's reputation score. Off-chain log + periodic
   anchor.

### Dag 5 (estimated 5h) — smart buyer agents

1. **`research-agent`** — first composer. Takes a question, decomposes it
   via gpt-oss-120b, fans out to wikipedia + web-search + LLM-summary,
   merges. Each user query → 5-10 sub-payments. **Reads from memory-agent
   first to check if it already researched something similar — saves work,
   creates memory→inference composition.**

2. **`news-digest-agent`** — runs every 5 min in background. Fetches HN
   top stories, summarizes each via inference-balanced, **stores digest
   in memory-agent**, publishes a digest. ~25 tx per cycle × 12 cycles/hour
   × 24h = 7200 tx/day per running instance. 10 running instances = 72k
   tx/day from a single workflow.

### Dag 6 (estimated 4h) — cold storage + open onboarding

1. **BSV Desktop Wallet bridge** — `peck_link_desktop_wallet` MCP tool.
   Connects to BSV Desktop's local BRC-100 endpoint. Lets users top up
   their hot wallet from a real cold wallet they already control. Massive
   pitch credibility move ("we don't custody anything").

2. **Open agent SDK** (`peck-agent-sdk` npm package, light) — 30 lines of
   code lets anyone register a new agent. Documented with a quickstart.

### Dag 7 (estimated 4h) — human-facing dashboard

1. **Read-only frontend** — extends marketplace-registry's existing
   dashboard. Live SSE feed showing agent activity, recent payments,
   reputation graph. **Note:** humans observe via the dashboard; agents
   transact via MCP. Two faces, one underlying registry.

2. **MCP install instructions** — README section + a script that detects
   the user's Claude Desktop / Cursor config path and writes the right
   mcpServers entry.

### Dag 8 (estimated 4h) — sustained validation

1. **Mainnet sanity test** — fund `worker_main` from user's source. Build
   a 100-leaf mainnet ladder. Fire 100 shots. Verify TAAL+GorillaPool
   sharding doubles throughput.

2. **24h pre-flight** — spin up 4-5 reference agents + 2-3 workflow agents.
   Let it run for 1-2 hours. Extrapolate to 24h. Adjust if rate limits or
   memory leaks bite.

### Dag 9 (estimated 4h) — submission package

1. **README rewrite** — describe the actual current architecture, with
   install instructions and the demo flow.
2. **Pitch video** (3-5 min):
   - 30s — the problem (agents need to pay each other, every existing
     solution sucks)
   - 60s — the demo (open Claude Desktop, install peck-mcp, type a
     prompt, watch the on-chain payment happen live)
   - 60s — the architecture (ladder + MCP + composition + memory)
   - 60s — the math (3000 active users = 1.5M tx/day organic; on-chain
     proof; verifiable receipts)
   - 30s — the call to action (install it, register your own agent,
     join the marketplace)
3. **Submission**: github repo cleaned, README polished, video uploaded,
   form submitted. **17. april 23:59 UTC.**

## Buffer policy

Dag 1 finished early. Dag 2 finished early with bonus. We have ~1.5 days
of slack baked in. Use it for:
- Tomorrow's dust consolidation (buys back time spent on workarounds)
- Inevitable testing rabbit holes
- Final 1-2 days of polish before submission

## Daily exit criteria

Each dag is "done" when:
- All planned scripts compile cleanly
- The relevant test scripts pass end-to-end
- Changes are committed and pushed to main
- Memory + STATUS.md updated for next session
- A clear next-morning starting point exists

## What we're explicitly NOT building

- ❌ Credit card / fiat on-ramp (out of scope, hurts thesis)
- ❌ Custodial wallets (against the principle)
- ❌ A web UI for *transacting* (humans observe; agents transact)
- ❌ Multi-chain support (BSV is the unique unlock)
- ❌ Smart contracts beyond P2PKH + OP_RETURN (we don't need them)
- ❌ Token / NFT issuance (out of scope)
- ❌ A custom LLM (we wrap OpenRouter)
- ❌ Recursive covenants / Chronicle stretch (parked, see memory)
- ❌ CLI / API key sharing (TOS violations, BYOC is v2 direction)

## Open questions to resolve early

- **Mainnet timing:** when does the user commit the 2.7 BSV? We need it
  by dag 8 latest for the 24h run.
- **Tavily key:** user signup task. Blocks `web-search` agent on dag 3.
- **Registration policy for third-party agents:** any vetting? Or fully
  open with reputation as the filter? (Recommend: fully open, reputation
  filters bad actors organically.)
- **Faucet wallet refill:** worker1/2 will burn down. Need a sustainable
  source for testnet sat — maybe automate a periodic refill from a
  dedicated faucet wallet that we top up from witnessonchain.

## Memory + receipts

- `memory/project_hackathon_agentic_pay.md` — rolling project memory
- `.ladder-state/leaves.db` — ladder state
- `.peck-state/wallet.json` — auto-wallet (gitignored)
- `.ladder-state/receipts.jsonl` — LadderClient receipts log

All of these survive across sessions. The next session starts fresh by
reading STATUS.md → PLAN.md → memory.
