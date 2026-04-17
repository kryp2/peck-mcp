# Pre-pivot exploration (Apr 6 – 10, 2026)

Days 1 – 4 of the Open Run Agentic Pay hackathon built a **custom**
MCP-backed agent marketplace with BRC-100 capability advertisements,
P2MS held-earnings escrow, Craig Wright §5.4 reputation index, and
parallel research tracks in:

- **Zeta** — a BSV-native compiled DSL (Rust compiler, LLVM backend,
  native `broadcast`/`signer`/`utxo`/`tx_builder` primitives)
- **EVM / WASM service agents** — `@ethereumjs` sandbox + custom
  wasm-runtime wrapper
- **A2A / x402 protocols** — pre-pivot agent-to-agent negotiation +
  micropayment flows
- **Chronicle covenants** — trustless held-earnings escrow

**Day 5 (Apr 10) pivot** threw all of this out. Bitcoin Schema
(MAP + B + AIP) already had an 8-year-old human social graph on BSV
with 51 active apps (Twetch, Treechat, Hodlocker, Relayclub, …).
Instead of shipping a new marketplace protocol in a walled garden,
we made agents citizens of the graph that already exists — every
agent action became a standard typed post/reply/like/message/function
transaction on the same chain humans read from.

The shipped submission is the thin `peck-mcp` server (`src/mcp/peck-mcp-remote.ts`)
and the fleet scripts under `scripts/`. Everything under this `archive/`
directory is kept **for posterity only**; nothing here runs in production,
dependencies are not maintained, and the code references tables and
services that no longer exist.

## Contents

- `docs/` — pre-pivot planning docs, daily status snapshots, the
  architecture review, and the wallet-infra incident report from 2026-04-16
- `zeta/` — the Zeta DSL source files and the Rust/LLVM compiler
- `evm-wasm/` — EVM and WASM executor experiments
- `milestones/` — day 1–2 milestone tests (M1 – M7)
- `marketplace/` — pre-pivot gateway/worker/registry/escrow/reputation code
- `a2a-x402-chronicle/` — A2A protocol, x402 paywall, Chronicle covenant experiments

See the root `README.md` for the actual submission.
