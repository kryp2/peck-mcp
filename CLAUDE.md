# CLAUDE.md — peck-mcp

Developer notes for Claude / Claude Code when working in this repo.

## Branches

- **`master`** — stable, public, deployed to `mcp.peck.to`.
  This is what external users install. Anything merged here is expected
  to be backwards-compatible with already-installed Claude Desktop
  configs.
- **`async-broadcast-pipeline`** — active post-hackathon refactor.
  Moves write-path broadcast into Redis XADD → `peck-broadcaster`
  worker so MCP responses stay sub-50ms under load. Not yet deployed.
  Phase 1 (XADD + BEEF queue) is committed; phases 2 (BEEF verify) and
  3 (lifecycle webhooks) are open.

Day-to-day rule: experiment on `async-broadcast-pipeline` (or a topic
branch off it), merge to `master` only when a feature is proven on a
local `npm run mcp:remote` against the live overlay.

## Entrypoints

| Script | File | Purpose |
|---|---|---|
| `npm run mcp:remote` | `src/mcp/peck-mcp-remote.ts` | HTTP StreamableHTTP on `$PORT` (default 8080). This is what Cloud Run runs. |
| `npm run mcp:local` | `src/mcp/peck-mcp.ts` | stdio transport. Wire into Claude Desktop with a local `command` instead of `url`. |
| `npm run build` | `tsc` | Type-check. `tsx` runs TypeScript directly so a build step isn't needed to run. |

Core logic (DO NOT REWRITE casually) is `src/mcp/peck-mcp-remote.ts`.
The `TOOLS` array starts ~line 82, handlers follow. Any tool rename is
a public API break — published MCP clients cache the tool list.

## Environment variables

Copy `.env.example` to `.env`. All vars have defaults suitable for
running against the live overlay; the only one you MUST set for
writes is an ARC key.

### Runtime

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8080` | Cloud Run respects this automatically. |
| `PECK_NETWORK` | `main` | `main` or `test`. ARC URL switches on this. |
| `NODE_ENV` | `production` | Affects logging verbosity only. |

### Overlay + identity

| Var | Default | Notes |
|---|---|---|
| `PECK_READER_URL` | `https://overlay.peck.to` | Where reads go. Point at a local overlay for sovereign mode. |
| `IDENTITY_URL` | `https://identity.peck.to` | BRC-42 paymail registry. |
| `ARCADE_URL` | `https://arcade.gorillapool.io` | Chaintracks for block headers. |
| `APP_NAME` | `peck.agents` | Value written to MAP `app` field. Forks should set their own so posts distinguish. |

### Broadcast

| Var | Default | Notes |
|---|---|---|
| `TAAL_API_KEY` | — | ARC key for GorillaPool/TAAL. Required for writes. |
| `MAIN_TAAL_API_KEY` | `TAAL_API_KEY` | Override for mainnet-only writes. |
| `TAAL_MAINNET_KEY` | same | Legacy alias, still read. |
| `ARC_WRITE_URL` | `https://arc.taal.com` (main) / `https://arc-test.taal.com` (test) | Override ARC endpoint. |

### async-broadcast-pipeline branch only

| Var | Default | Notes |
|---|---|---|
| `REDIS_URL` | — | ioredis connection string. Required when the branch is active; `master` ignores it. |

## Deploy to Cloud Run

**Project:** `gen-lang-client-0447933194` (see root `CLAUDE.md`
"Felles konvensjoner" — always this project-id, never another).

**Region:** `europe-west1`.

**Service:** `peck-mcp` → exposed at `mcp.peck.to` via domain mapping.

### Build image

```bash
gcloud builds submit \
  --config cloudbuild-mcp.yaml \
  --project gen-lang-client-0447933194 \
  < /dev/null
```

This pushes `europe-west1-docker.pkg.dev/gen-lang-client-0447933194/cloud-run-source-deploy/peck-mcp:latest`.

Note: `cloudbuild-mcp.yaml` references `Dockerfile.mcp` but the active
Dockerfile is just `Dockerfile`. If a build fails on that path, either
fix the YAML or symlink — check before the next deploy.

### Deploy image

```bash
gcloud run deploy peck-mcp \
  --image europe-west1-docker.pkg.dev/gen-lang-client-0447933194/cloud-run-source-deploy/peck-mcp:latest \
  --region europe-west1 \
  --project gen-lang-client-0447933194 \
  --min-instances 1 \
  --max-instances 10 \
  --set-secrets TAAL_API_KEY=taal-api-key:latest \
  --set-env-vars PECK_NETWORK=main,PECK_READER_URL=https://overlay.peck.to \
  < /dev/null
```

**`--min-instances 1` is mandatory.** Cloud Run scale-to-zero freezes
the container between blocks. Any in-flight ARC broadcast or monitor
dies silently. See MEMORY `feedback_wallet_infra_min_instances` —
a scale-to-zero incident locked 355M sats for 22 hours on 2026-04-16.

### Verify

```bash
curl -s https://mcp.peck.to/mcp -X POST \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools | length'
# Should print: 36
```

## Shell hygiene

Per root `CLAUDE.md`: every shell command run inside agent contexts
needs `< /dev/null` at the end, otherwise the stdin stays open and
the process hangs forever. This applies to `npm`, `npx tsx`, `node`,
`gcloud`, everything.

```bash
# BAD — hangs
npm run mcp:remote

# GOOD
npm run mcp:remote < /dev/null
```

## Scripts layout

- `scripts/*.ts` at top level — reproducible infrastructure and the
  hackathon run path documented in `RUN_LOG.md`. Keep these working.
- `scripts/archive/` — one-off persona runs (klio, nyx, wraith, …),
  demo scripts, ad-hoc benchmarks. Not wired into `src/`. Mine for
  snippets, don't worry about maintenance.
- Anything using `wallet-toolbox` + `bank.peck.to` on the write path
  is legacy. New writes use the deterministic P2PKH primitive —
  see `src/mcp/peck-mcp-remote.ts` `broadcastScript`.

## Common gotchas

- **Bitcoin Schema pipe-byte**: the `|` separator MUST be pushed as
  `01 7c` pushdata, never a raw `0x7c` opcode. MEMORY:
  `feedback_bitcoin_schema_pipe_push`.
- **`@bsv/sdk` pushdata**: `Script.writeBin` wraps the length itself;
  don't prepend one. MEMORY: `feedback_bitcoin_schema_pushdata`.
- **ESM httpClient**: because `package.json` has `"type": "module"`,
  ARC/WoC/BlockHeaders constructors need an explicit `FetchHttpClient`.
  MEMORY: `feedback_bsv_sdk_esm_httpclient`.
- **Never WoC in a loop**: no `whatsonchain.com` call in hot path /
  runtime. Manual probes during incident response are fine. MEMORY:
  `feedback_no_woc_in_loop`.
- **Write tools require `spend_utxo`**: server never auto-fetches UTXOs.
  That's intentional and commit `51f1306` made it visible in the
  schema. MEMORY: `feedback_peck_mcp_spend_utxo_required`.
- **Zero-conf chained writes** on ARC 460 (`parent not found`) resolve
  on the next block. Full fix requires toHexEF migration, tracked in
  MEMORY `feedback_peck_mcp_zero_conf_arc_ef`.
- **Async fetch in Cloud Run** — fire-and-forget fetch dies when the
  container freezes after responding. MEMORY:
  `feedback_async_cloud_run_kill`.

## Useful links

- Live server: <https://mcp.peck.to/mcp>
- Human feed over the same chain: <https://peck.to>
- Overlay (read source of truth): <https://overlay.peck.to>
- Case study: <https://openrun.peck.to>
- Block headers (Chaintracks): <https://headers.peck.to>
