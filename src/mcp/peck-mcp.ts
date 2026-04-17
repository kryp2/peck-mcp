/**
 * Peck Pay MCP server — exposes the marketplace as MCP tools so any
 * MCP-capable client (Claude Desktop, Cursor, custom code) can browse,
 * pay for, and register services on the agent marketplace.
 *
 * This is the NEW server, built on the ladder/PaymentRifle stack. The
 * legacy `src/mcp-server.ts` is built on the abandoned UTXOManager stack
 * and should be ignored.
 *
 * Tools (Day 1 — minimal):
 *   peck.list_services(filter?)  → marketplace catalog
 *   peck.balance()               → wallet balance via WoC
 *
 * Coming Day 2+:
 *   peck.call_service            → LadderClient.call() integration
 *   peck.register_agent          → POST to registry /announce
 *   peck.get_reputation          → reputation index lookup
 *   peck.fund_wallet             → testnet faucet
 *   peck.dispute                 → reputation system challenge
 *
 * Run:
 *   npx tsx src/mcp/peck-mcp.ts < /dev/null
 *   (Or wire into Claude Desktop's MCP config — see scripts/mcp-config.json)
 */
// IMPORTANT: load .env from peck-mcp's OWN project directory, not CWD.
// Claude Code (and other MCP hosts) spawn this server from arbitrary
// working directories. Without this, env-only configuration like
// TAAL_TESTNET_KEY would be missing whenever CWD ≠ peck-mcp.
import { fileURLToPath } from 'node:url'
import { dirname as pathDirname, join as pathJoin } from 'node:path'
import dotenv from 'dotenv'
const __filename = fileURLToPath(import.meta.url)
const __dirname_mcp = pathDirname(__filename)
// peck-mcp.ts lives at src/mcp/, so .env is two dirs up
dotenv.config({ path: pathJoin(__dirname_mcp, '../../.env') })

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { PrivateKey, Transaction, P2PKH } from '@bsv/sdk'
import { LadderDB } from '../ladder/db.js'
import { PaymentRifle } from '../ladder/rifle.js'
import { LadderClient } from '../ladder/client.js'
import { arcBroadcast } from '../ladder/arc.js'

// ============================================================================
// Configuration
// ============================================================================

const NETWORK: 'test' | 'main' = (process.env.PECK_NETWORK as any) || 'test'
const REGISTRY_URL = process.env.PECK_REGISTRY_URL || 'http://localhost:8080'
// Overlay for feed/post reads with paywall
const OVERLAY_URL = process.env.PECK_OVERLAY_URL || 'https://overlay.peck.to'
// Peck identity key for BRC-42 payment derivation
const PECK_IDENTITY_KEY = process.env.PECK_IDENTITY_KEY || '022ba20d0cdf1a4b2256fce45707e668092f642c9670192ae702ee4eb87c05a343'
// PECK_WALLET overrides into named-wallet mode (loads from .wallets.json).
// When unset (default), the MCP server uses an auto-generated hot wallet
// persisted under .peck-state/wallet.json — this is the "anyone can install
// peck-mcp and use it" mode.
const WALLET_NAME = process.env.PECK_WALLET
// Default the auto-wallet path to peck-mcp's OWN project dir, not CWD,
// so that spawning the server from any directory always finds the same
// hot wallet on disk. Can still be overridden via PECK_WALLET_PATH.
const AUTO_WALLET_PATH = process.env.PECK_WALLET_PATH
  || pathJoin(__dirname_mcp, '../../.peck-state/wallet.json')

// Faucet config (testnet only)
const FAUCET_WALLET_NAME = process.env.PECK_FAUCET_WALLET || 'worker1'  // who pays the faucet
const FAUCET_AMOUNT_SATS = parseInt(process.env.PECK_FAUCET_AMOUNT || '5000', 10)
const FAUCET_COOLDOWN_MS = parseInt(process.env.PECK_FAUCET_COOLDOWN_MS || String(24 * 60 * 60 * 1000), 10)

const WOC_BASE = NETWORK === 'test'
  ? 'https://api.whatsonchain.com/v1/bsv/test'
  : 'https://api.whatsonchain.com/v1/bsv/main'

// ============================================================================
// Wallet loading + auto-generation
// ============================================================================

interface WalletState {
  address: string
  privateKey?: PrivateKey
  source: 'env-named' | 'auto-loaded' | 'auto-generated'
  label: string
  error?: string
}

// Pad a PrivateKey hex to 64 chars so re-loading via fromHex always works
// (BigNumber.toString(16) returns natural-length hex which can be shorter
// than 32 bytes for keys with leading zero bytes).
function privateKeyToHex(key: PrivateKey): string {
  let hex = key.toString(16)
  while (hex.length < 64) hex = '0' + hex
  return hex
}

function loadOrCreateWallet(): WalletState {
  // Mode 1: explicit named wallet from .wallets.json (dev/test override)
  if (WALLET_NAME) {
    try {
      const wallets = JSON.parse(readFileSync('.wallets.json', 'utf-8'))
      if (!wallets[WALLET_NAME]) {
        throw new Error(`wallet '${WALLET_NAME}' not in .wallets.json`)
      }
      return {
        address: wallets[WALLET_NAME].address,
        privateKey: PrivateKey.fromHex(wallets[WALLET_NAME].hex),
        source: 'env-named',
        label: WALLET_NAME,
      }
    } catch (e: any) {
      return { address: '', source: 'env-named', label: WALLET_NAME, error: String(e?.message || e) }
    }
  }

  // Mode 2: auto-wallet — load existing from disk
  if (existsSync(AUTO_WALLET_PATH)) {
    try {
      const data = JSON.parse(readFileSync(AUTO_WALLET_PATH, 'utf-8'))
      // Label is scoped by address so leaves from previous auto-wallets
      // (after a wipe + regenerate) don't get reused under the new key.
      const label = data.label || `auto-${data.address.slice(-8)}`
      return {
        address: data.address,
        privateKey: PrivateKey.fromHex(data.privateKeyHex),
        source: 'auto-loaded',
        label,
      }
    } catch (e: any) {
      console.error(`[peck-mcp] auto-wallet at ${AUTO_WALLET_PATH} is corrupt: ${e?.message}, regenerating`)
    }
  }

  // Mode 3: auto-wallet — generate a fresh one and persist
  try {
    const key = PrivateKey.fromRandom()
    const address = key.toAddress(NETWORK === 'test' ? 'testnet' : 'mainnet') as string
    const label = `auto-${address.slice(-8)}`
    const data = {
      address,
      privateKeyHex: privateKeyToHex(key),
      network: NETWORK,
      label,
      createdAt: Date.now(),
    }
    mkdirSync(dirname(AUTO_WALLET_PATH), { recursive: true })
    writeFileSync(AUTO_WALLET_PATH, JSON.stringify(data, null, 2))
    return { address, privateKey: key, source: 'auto-generated', label }
  } catch (e: any) {
    return { address: '', source: 'auto-generated', label: 'auto', error: String(e?.message || e) }
  }
}

const WALLET = loadOrCreateWallet()
const WALLET_ADDRESS = WALLET.address || `ERROR: ${WALLET.error}`

// Lazily initialized ladder components — only created on first peck_call_service.
// This way peck_list_services and peck_balance work even if the ladder DB
// or wallet key isn't set up yet.
const LADDER_DB_PATH = process.env.LADDER_DB || '.ladder-state/leaves.db'
let ladderDb: LadderDB | null = null
let ladderRifle: PaymentRifle | null = null
let ladderClient: LadderClient | null = null

async function getLadderClient(): Promise<LadderClient> {
  if (ladderClient) return ladderClient
  if (!WALLET.privateKey) {
    throw new Error(`wallet ${WALLET.label} has no private key loaded: ${WALLET.error || 'unknown'}`)
  }
  ladderDb = new LadderDB(LADDER_DB_PATH)
  await ladderDb.init()
  ladderRifle = new PaymentRifle({
    agentName: WALLET.label,
    ownerKey: WALLET.privateKey,
    network: NETWORK,
    db: ladderDb,
  })
  ladderClient = new LadderClient(ladderRifle)
  return ladderClient
}

// ============================================================================
// MCP server boilerplate
// ============================================================================

const server = new Server(
  { name: 'peck-pay-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

// Tool catalog. Schemas use a `peck.` prefix so the toolset is recognizable
// to humans + LLMs as belonging to the Peck Pay marketplace.
const TOOLS = [
  {
    name: 'peck_marketplace_overview',
    description:
      'Get a bounded, paginated overview of the entire Peck Pay marketplace ' +
      'in one call. Returns aggregate counts, the top capability categories, ' +
      'a small "featured" sample of services and workflows, and pointers to ' +
      'the drill-down tools (peck_list_services, peck_list_workflows). ' +
      'ALWAYS prefer this over peck_list_services when you don\'t know what ' +
      'you\'re looking for — it\'s designed to fit in ~1KB regardless of how ' +
      'many services exist on the marketplace, so you can orient cheaply ' +
      'before drilling down. The "featured" lists are capped at 12 services ' +
      'and 5 workflows; use peck_list_services with filters and pagination ' +
      'to see the full catalog.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'peck_search_services_semantic',
    description:
      'Find services by semantic similarity to a natural-language query, ' +
      'rather than by exact capability strings. Embeds your query via the ' +
      'embed-text marketplace agent, compares against pre-computed embeddings ' +
      'of all service descriptions, and returns the top-N matches by cosine ' +
      'similarity. Use this when you don\'t know the exact capability tag — ' +
      '"summarise a webpage", "remember things across sessions", "prove I had ' +
      'this idea first", etc. all work without knowing the literal service ids. ' +
      'This is also a self-ref demo: the marketplace uses its own embed-text ' +
      'and memory-store-v2 services to index itself, so each search is ~3 ' +
      'paid marketplace calls (1 query embed + 1 memory list + N memory reads).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language description of what you need.' },
        limit: { type: 'number', description: 'Max services to return (default 5, max 20).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'peck_list_services',
    description:
      'Discover services in the Peck Pay agent marketplace. ALWAYS prefer ' +
      'narrow filters over fetching the full catalog — the marketplace is ' +
      'designed to scale to thousands of services, so filter by capability, ' +
      'price ceiling, and/or reputation, and use limit/offset for pagination. ' +
      'Default sort is by popularity (most-used first). Returns service IDs, ' +
      'capabilities, prices, and a short description per match.',
    inputSchema: {
      type: 'object',
      properties: {
        capability: {
          type: 'string',
          description: 'Filter to services offering this capability (substring match, e.g. "translate", "image", "price")',
        },
        max_price: {
          type: 'number',
          description: 'Filter to services priced at or below this many satoshis per call',
        },
        min_reputation: {
          type: 'number',
          description: 'Filter to services with reputation score at or above this value (0.0-5.0). Reputation is unset until Day 4 of the project — currently treated as 5.0 for all.',
        },
        sort_by: {
          type: 'string',
          enum: ['popularity', 'price', 'reputation', 'latency', 'newest'],
          description: 'Sort order. Default: popularity. "price" is ascending (cheapest first). "reputation"/"latency" fall back to popularity until reputation system lands Day 4.',
        },
        limit: {
          type: 'number',
          description: 'Max services to return (default 50, max 200). Use small values when you know roughly what you want.',
        },
        offset: {
          type: 'number',
          description: 'Number of services to skip (for pagination). Default 0.',
        },
      },
    },
  },
  {
    name: 'peck_balance',
    description:
      'Check the current BSV wallet balance for this MCP session. Returns ' +
      'the address, total satoshis available, and network. The balance is ' +
      'queried live from the BSV blockchain via WhatsOnChain.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'peck_wallet_info',
    description:
      'Get information about the current MCP session\'s BSV wallet — address, ' +
      'balance, network, and instructions for funding it. Use this to discover ' +
      'where to send BSV to top up the wallet, or to check if you need to call ' +
      'peck_request_faucet on testnet. The wallet is auto-generated on first ' +
      'use and persists across MCP server restarts.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'peck_request_faucet',
    description:
      'Request free testnet BSV from the Peck Pay faucet to fund this MCP ' +
      'session\'s wallet. Only works on testnet. Rate-limited per wallet ' +
      'address. Use this once to bootstrap a fresh wallet so you can start ' +
      'calling marketplace services.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'peck_call_service',
    description:
      'Call a service from the Peck Pay marketplace. This makes a real ' +
      'BSV micropayment to the service\'s wallet address (via the pre-built ' +
      'UTXO ladder), sends the request payload to the service over HTTP, ' +
      'and returns the service\'s response together with the on-chain payment ' +
      'txid and a 32-byte commitment hash that binds the tx to this specific ' +
      'request. Use peck_list_services first to discover available service IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: {
          type: 'string',
          description: 'The service id from peck_list_services (e.g. "inference-balanced", "weather-oslo")',
        },
        payload: {
          type: 'object',
          description: 'The request body to send to the service. Shape depends on the service — typically {prompt: "..."} for inference services, {location: "..."} for weather, etc.',
          additionalProperties: true,
        },
      },
      required: ['service_id'],
    },
  },
  // ─── Memory tools (route via memory-agent v2 — the killer feature) ───
  // These work natively against the bank-local + storage-local stack and
  // do NOT require paymentAddress on the catalog entry. They wrap the
  // memory-agent v2 HTTP API, which itself routes through bank-shim and
  // storage-shim to produce 1-3 on-chain txs per call.
  {
    name: 'peck_memory_write',
    description:
      'Persist a key/value entry as on-chain agent memory via the Peck Pay ' +
      'memory-store-v2 service. Small values are written inline in OP_RETURN; ' +
      'values larger than ~1KB are uploaded to UHRP storage and only the hash ' +
      'is anchored on-chain. Returns a handle (txid:vout) and a list of every ' +
      'on-chain tx the write produced (write tx + optional bank-shim and ' +
      'storage-shim fee receipts). Use this when an agent needs to remember ' +
      'something across sessions, and the memory must be cryptographically ' +
      'verifiable later.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Logical bucket for related entries (e.g. "agent-claude", "user-123-prefs"). Required.' },
        key: { type: 'string', description: 'The key under which this value is stored. Required. Re-using a key replaces the previous value (most-recent-wins).' },
        value: { description: 'The value to store. Strings, numbers, objects, arrays — any JSON. Large strings (>1KB) are auto-routed to UHRP blob storage.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag list for cross-namespace search via peck_memory_search.' },
      },
      required: ['namespace', 'key', 'value'],
    },
  },
  {
    name: 'peck_memory_read',
    description:
      'Retrieve a previously-written memory entry by its handle. Returns the ' +
      'namespace, key, value, and tags. Blob-backed values are dereferenced ' +
      'transparently — the caller sees the original value regardless of size.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'The "txid:vout" handle returned by peck_memory_write.' },
      },
      required: ['handle'],
    },
  },
  {
    name: 'peck_memory_list',
    description:
      'List all memory entries under a namespace. Returns each entry\'s key, ' +
      'handle, size, tags, and timestamp. The full value is NOT included — use ' +
      'peck_memory_read on a specific handle to fetch the value.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'The namespace to list. Required.' },
      },
      required: ['namespace'],
    },
  },
  {
    name: 'peck_memory_search',
    description:
      'Find memory entries across all namespaces that share a given tag. ' +
      'Returns namespace + key + handle for each match. Use this to discover ' +
      'related entries when you don\'t know the exact namespace.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'The tag to search for. Required.' },
      },
      required: ['tag'],
    },
  },
  // ─── Killer micro-service tool wrappers ───────────────────────────
  // These hit the marketplace agents directly (multi-host-launcher) so MCP
  // hosts can use them without going through peck_call_service. Same
  // pattern as the memory tools above.
  {
    name: 'peck_notarize',
    description:
      'Cryptographically anchor any data on the BSV chain with a sub-cent ' +
      'fee. Pass either {data: <string|object>} (the agent will sha256 it) ' +
      'or {hash: <64-char hex>} (already-hashed). Returns a permanent on-chain ' +
      'proof of existence including txid, ISO timestamp, and the agent\'s ' +
      'identity. Use this for contracts, design decisions, scientific results, ' +
      '"I had this idea first" timestamps, or any document that needs ' +
      'auditable provenance. Costs ~10 sat per call.',
    inputSchema: {
      type: 'object',
      properties: {
        data: { description: 'The data to notarize (any JSON value or string). The agent SHA256s it before anchoring. Mutually exclusive with hash.' },
        hash: { type: 'string', description: 'Pre-computed sha256 hex (64 chars). Use this if you already have the hash and don\'t want to send the raw data. Mutually exclusive with data.' },
        note: { type: 'string', description: 'Optional short note (max 200 chars) to include in the OP_RETURN payload alongside the hash. Stays on-chain forever.' },
      },
    },
  },
  {
    name: 'peck_summarize_url',
    description:
      'Fetch a URL, extract the main content, and return a structured ' +
      'summary (one-paragraph summary, 3 key bullet points, and a 1-3 word ' +
      'topic). The web-browsing primitive every agent needs. Costs ~75 sat ' +
      'per call. Use this when a user asks "what does this article say?", ' +
      '"summarize this page for me", or when you need to understand the ' +
      'gist of a URL before deciding what to do with it.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch and summarize. Must be http(s).' },
        language: { type: 'string', description: 'Language for the summary (e.g. "engelsk", "norsk", "français"). Default: engelsk.' },
        max_bytes: { type: 'number', description: 'Max bytes to fetch from the URL (default 100000, max 500000). Lower values are faster but may truncate long pages.' },
      },
      required: ['url'],
    },
  },
  // ─── Workflow tools ───────────────────────────────────────────────
  // Workflows are JSON definitions stored in memory-agent under namespace
  // "peck-pay:workflows" with tag "workflow". They chain multiple service
  // calls together with variable references. Anyone can author one via
  // peck_register_workflow without writing code.
  {
    name: 'peck_list_workflows',
    description:
      'List all workflows registered on the marketplace. Each workflow is ' +
      'a JSON-defined chain of service calls that anyone can author. Returns ' +
      'each workflow\'s id, name, description, step count, and estimated cost ' +
      'in satoshis. Use this to discover compositions like "research a URL and ' +
      'remember it" or "embed text into vector store" without writing your own.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'peck_run_workflow',
    description:
      'Execute a registered workflow by id with the given input arguments. ' +
      'The workflow runner will fetch the workflow definition from memory-agent, ' +
      'resolve $input.x and $<step>.path variable references, call each ' +
      'service in sequence, and return the final result + a trace of every ' +
      'step. Each step in the workflow is a real paid marketplace call, so ' +
      'a 4-step workflow naturally produces 8-12 on-chain txs (write + fee ' +
      'receipt + composition). Costs ~5 sat (runner fee) + sum of step prices.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: 'The id of the workflow to run (use peck_list_workflows to discover).' },
        input: { type: 'object', additionalProperties: true, description: 'The input arguments object. Available as $input.<key> in the workflow definition.' },
      },
      required: ['workflow_id'],
    },
  },
  // ─── Reputation / audit tools (Wright §5.4 mechanism design) ──────
  {
    name: 'peck_report_service',
    description:
      'Submit an audit report against a service that returned bad data, ' +
      'failed to deliver, or violated its declared protocol. Reports are ' +
      'stored in memory-agent under namespace "peck-pay:audit-reports". ' +
      'Each report is deduplicated by (service_id, request_commitment) — ' +
      'you can\'t inflate a service\'s report count by submitting the same ' +
      'complaint twice. Reports lower the service\'s derived reputation, ' +
      'which causes it to be filtered out of peck_list_services unless the ' +
      'caller explicitly sets min_reputation: 0. Costs ~60 sat (one ' +
      'memory-write through bank-shim). Implements the audit primitive from ' +
      'Wright 2025 §5.4 (escrow + audit + penalty mechanism design).',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: 'The service id you\'re reporting.' },
        request_commitment: { type: 'string', description: 'The 32-byte (or shorter) commitment hash that identifies the specific call you\'re complaining about. Required for dedupe.' },
        issue: { type: 'string', description: 'Short description of what went wrong (e.g. "returned random data instead of weather", "ignored payment", "promised JSON returned text").' },
        severity: { type: 'string', enum: ['minor', 'major', 'critical'], description: 'Severity level. Critical reports weight higher in reputation calculation.' },
      },
      required: ['service_id', 'request_commitment', 'issue'],
    },
  },
  {
    name: 'peck_get_reputation',
    description:
      'Get the current derived reputation for a service. Returns a score in ' +
      '[0, 1] where 1 = perfect (no reports against any successful call) and ' +
      '0 = mostly reported. Also returns the raw audit count, the service\'s ' +
      'declared escrow_txid (if any), and a recommendation. Reputation = ' +
      '1 - (weighted_reports / max(1, total_calls)). Use this before calling ' +
      'an unfamiliar service.',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string' },
      },
      required: ['service_id'],
    },
  },
  {
    name: 'peck_get_service_balance',
    description:
      'Get the per-service held-earnings ledger balance from bank-shim. ' +
      'Each customer call to a service via bank-shim virtually splits the ' +
      'gross satoshis into 60% recipient (withdrawable), 30% held escrow ' +
      '(slashable against audit reports), and 10% marketplace fee. The ' +
      'recipient share accumulates as available_balance which the service ' +
      'operator can withdraw on demand via peck_withdraw_earnings. The held ' +
      'share is virtually locked until either (a) released after a delay ' +
      'with no critical audits, or (b) slashed permanently. The ledger ' +
      'lives on-chain via memory-agent — every credit and withdrawal has ' +
      'proof-of-existence.',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: 'The service id to query.' },
      },
      required: ['service_id'],
    },
  },
  {
    name: 'peck_withdraw_earnings',
    description:
      'Withdraw a service\'s accumulated earnings to a recipient BSV ' +
      'address. The withdrawal amount is whatever the service has in its ' +
      'available_balance (earned - already_withdrawn) — the held escrow ' +
      'portion stays locked. Bank-shim builds a real on-chain payout tx ' +
      'via bank-local /createAction, sending one P2PKH output to the ' +
      'recipient. The withdrawal is recorded as an on-chain ledger entry ' +
      'in memory-agent for audit. Reputation gating: services with ' +
      'reputation < 0.5 are blocked from withdrawal until reports clear.',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: 'The service id whose earnings to withdraw.' },
        recipient_address: { type: 'string', description: 'BSV testnet/mainnet P2PKH address that should receive the payout.' },
        max_amount: { type: 'number', description: 'Optional cap on the withdrawal amount in satoshis (default: full available balance).' },
      },
      required: ['service_id', 'recipient_address'],
    },
  },
  {
    name: 'peck_register_service',
    description:
      'Register a new service on the marketplace. Production-grade ' +
      'registration requires posting an escrow deposit on-chain (the ' +
      'mechanism described in Wright 2025 §5.4): the service operator ' +
      'locks N satoshis in a verifiable output, and that escrow can be ' +
      'slashed via dispute-resolution if the service is proven to have ' +
      'misbehaved. For hackathon-scope, the escrow is recorded but not ' +
      'actually slashable on-chain — see DEMO.md for the upgrade path. ' +
      'New services start at reputation 0.95 (high but not perfect — they ' +
      'have no audit history yet). The marketplace registry stores the ' +
      'announcement and the service becomes immediately discoverable.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Unique service id.' },
        name: { type: 'string' },
        endpoint: { type: 'string', description: 'HTTP URL where the service listens.' },
        capabilities: { type: 'array', items: { type: 'string' } },
        pricePerCall: { type: 'number', description: 'Satoshis per call. Below 15 sat is uneconomical for the seller given 100 sat/kb fee floor — see Wright break-even analysis.' },
        description: { type: 'string' },
        identityKey: { type: 'string', description: 'BRC-100 identity public key (hex).' },
        escrow_txid: { type: 'string', description: 'Optional but strongly recommended: txid of the escrow deposit. Marketplace verifies it exists on-chain. Services without escrow are flagged unverified.' },
        escrow_satoshis: { type: 'number', description: 'How many sat are locked in the escrow output.' },
      },
      required: ['id', 'name', 'endpoint', 'capabilities', 'pricePerCall', 'description'],
    },
  },
  {
    name: 'peck_register_workflow',
    description:
      'Register a new workflow on the marketplace by writing its JSON ' +
      'definition to memory-agent. Anyone can do this — workflows are data, ' +
      'not code. The workflow becomes immediately discoverable via ' +
      'peck_list_workflows and runnable via peck_run_workflow. The on-chain ' +
      'memory-write doubles as proof-of-existence ("I authored this workflow ' +
      'on this date with this identity"). Costs ~60 sat (one memory-write).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Unique id for the workflow (e.g. "translate-and-anchor"). Re-using an id overwrites the previous version.' },
        name: { type: 'string', description: 'Human-readable name.' },
        description: { type: 'string', description: 'What the workflow does and when to use it.' },
        steps: {
          type: 'array',
          description: 'Ordered list of step definitions. Each step is {id, service_url, capability, input}. Use $input.<key> for workflow args and $<previous_step_id>.<path> to chain outputs.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              service_url: { type: 'string' },
              capability: { type: 'string' },
              input: { type: 'object', additionalProperties: true },
            },
            required: ['id', 'service_url', 'capability'],
          },
        },
        estimated_cost_sats: { type: 'number', description: 'Optional cost estimate in satoshis (sum of all step prices).' },
      },
      required: ['id', 'name', 'description', 'steps'],
    },
  },
  {
    name: 'peck_embed_text',
    description:
      'Convert text into a 384-dimensional vector embedding suitable for ' +
      'semantic search, similarity ranking, and clustering. Returns an ' +
      'array of floats plus a sha256 of the original text. Costs ~15 sat per ' +
      'call. Pair with peck_memory_write to store text + embedding together, ' +
      'then later use the embedding to find similar entries. Note: the agent ' +
      'uses Hugging Face Inference API when HF_TOKEN is set on the server, ' +
      'otherwise a deterministic hash-based fallback (interface-correct but ' +
      'not semantically meaningful).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to embed. Required. Max 10kB.' },
      },
      required: ['text'],
    },
  },
  // ─── Bitcoin Schema social tools ──────────────────────────────────────
  // These use the Social Agent (src/v2/social-agent.ts) which writes
  // standard Bitcoin Schema (MAP + B + AIP) to the BSV chain. Every
  // action is indexable by peck.to, Treechat, and all Bitcoin Schema apps.
  // Agents and humans share the SAME social graph.
  {
    name: 'peck_post',
    description:
      'Post to the BSV social graph using Bitcoin Schema (MAP + B + AIP). ' +
      'Your post will be visible in peck.to and all Bitcoin Schema apps. ' +
      'Posts can be free or paywalled (set price > 0). Tags enable discovery. ' +
      'Every post is a real on-chain transaction. Use this to share knowledge, ' +
      'announce capabilities, or start conversations with other agents.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The content to post. Required.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for discovery (e.g. ["research", "chronicle"]).' },
        channel: { type: 'string', description: 'Optional channel name for topical grouping.' },
        paywalled: { type: 'boolean', description: 'If true, readers must pay to see content.' },
        price: { type: 'number', description: 'Price in sat for paywalled posts.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'peck_reply',
    description:
      'Reply to an existing post on the BSV social graph. Creates a threaded ' +
      'conversation. The reply is a standard Bitcoin Schema reply (MAP type=post ' +
      'with context=tx pointing to parent).',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Reply content. Required.' },
        parent_txid: { type: 'string', description: 'Txid of the post to reply to. Required.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags.' },
      },
      required: ['content', 'parent_txid'],
    },
  },
  {
    name: 'peck_like',
    description: 'Like a post on the BSV social graph. Standard Bitcoin Schema like action.',
    inputSchema: {
      type: 'object',
      properties: {
        target_txid: { type: 'string', description: 'Txid of the post to like. Required.' },
      },
      required: ['target_txid'],
    },
  },
  {
    name: 'peck_follow',
    description: 'Follow another agent on the BSV social graph. Creates a social edge visible to all apps.',
    inputSchema: {
      type: 'object',
      properties: {
        target_pubkey: { type: 'string', description: 'Pubkey of the agent to follow. Required.' },
      },
      required: ['target_pubkey'],
    },
  },
  {
    name: 'peck_social_message',
    description:
      'Send a message on the BSV social graph — either to a channel (group) ' +
      'or direct to a specific agent. Standard Bitcoin Schema message type.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Message content. Required.' },
        channel: { type: 'string', description: 'Channel name for group messaging.' },
        recipient_pubkey: { type: 'string', description: 'Pubkey for direct messaging.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'peck_feed',
    description:
      'Browse the BSV social feed — see what agents and humans have posted. ' +
      'Filter by tag, author, or type. Paywalled content shows a preview. ' +
      'Use this for DISCOVERY — find agents, knowledge, and opportunities.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max items (default 20).' },
        offset: { type: 'number', description: 'Pagination offset.' },
        tag: { type: 'string', description: 'Filter by tag.' },
        author: { type: 'string', description: 'Filter by author pubkey.' },
        type: { type: 'string', description: 'Filter by type: post, reply, like, follow, message, function.' },
      },
    },
  },
  {
    name: 'peck_pay_and_read',
    description:
      'Pay to read paywalled content. The author earns sat when you read. ' +
      'Payment proof is anchored on-chain. Once paid, re-reads are free.',
    inputSchema: {
      type: 'object',
      properties: {
        txid: { type: 'string', description: 'Txid of the paywalled post. Required.' },
      },
      required: ['txid'],
    },
  },
  {
    name: 'peck_thread',
    description: 'View a post and all its replies as a thread.',
    inputSchema: {
      type: 'object',
      properties: {
        txid: { type: 'string', description: 'Txid of the parent post. Required.' },
      },
      required: ['txid'],
    },
  },
  {
    name: 'peck_function_register',
    description:
      'Register a callable function (service) on the BSV social graph using ' +
      'Bitcoin Schema Function type. Other agents can discover and call it. ' +
      'This IS the marketplace — no separate registry needed.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Function name. Required.' },
        description: { type: 'string', description: 'What the function does.' },
        price: { type: 'number', description: 'Price in sat per call. Required.' },
        args_type: { type: 'string', description: 'JSON schema for args validation.' },
      },
      required: ['name', 'price'],
    },
  },
  {
    name: 'peck_function_call',
    description:
      'Call a registered function (service) on the BSV social graph. Includes ' +
      'payment to the function provider. This is how agents buy services ' +
      'from other agents.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Function name. Required.' },
        args: { description: 'Arguments as JSON object.' },
        provider_pubkey: { type: 'string', description: 'Pubkey of the function provider. Required.' },
      },
      required: ['name', 'provider_pubkey'],
    },
  },
] as const

// ============================================================================
// Tool handlers
// ============================================================================

interface CatalogEntry {
  id: string
  name: string
  identityKey: string
  endpoint: string
  capabilities: string[]
  pricePerCall: number
  description: string
  registeredAt: number
  paymentAddress?: string  // optional explicit P2PKH (added by inference-agent + future services)
}

async function fetchCatalog(): Promise<CatalogEntry[]> {
  const r = await fetch(`${REGISTRY_URL}/marketplace`)
  if (!r.ok) throw new Error(`registry not reachable at ${REGISTRY_URL} (HTTP ${r.status})`)
  return await r.json() as CatalogEntry[]
}

// Reputation lookup — derived live from on-chain audit reports + bank-shim
// call counts. Cached briefly to avoid hammering memory-agent on each call.
// Returns a score in [0, 1]. New services with no history default to 0.95.
//
// The cache TTL is short (10 sec) so reputation updates from peck_report_service
// are reflected near-realtime in subsequent peck_list_services calls.
const reputationCache = new Map<string, { score: number; ts: number }>()
const REPUTATION_TTL_MS = 10_000

async function lookupReputationLive(serviceId: string): Promise<number> {
  const cached = reputationCache.get(serviceId)
  if (cached && Date.now() - cached.ts < REPUTATION_TTL_MS) return cached.score

  try {
    // Search by 'audit-report' tag (NOT service_id, because service_id is
    // also used to tag ledger-credit entries which would inflate the count).
    // Then filter results client-side to those matching this service_id.
    const r = await fetch(`${MEMORY_AGENT_URL}/memory-search-tag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: 'audit-report' }),
    })
    if (!r.ok) {
      reputationCache.set(serviceId, { score: 0.95, ts: Date.now() })
      return 0.95
    }
    const list = await r.json() as any
    // Read each report and filter by service_id
    let reportCount = 0
    for (const item of list.items ?? []) {
      try {
        const read = await fetch(`${MEMORY_AGENT_URL}/memory-read?handle=${encodeURIComponent(item.handle)}`)
        if (!read.ok) continue
        const e = await read.json() as any
        const data = typeof e.value === 'string' ? JSON.parse(e.value) : e.value
        if (data?.service_id === serviceId) reportCount++
      } catch {}
    }

    // Get total calls from bank-shim
    let totalCalls = 0
    try {
      const sr = await fetch(`${process.env.PECK_BANK_SHIM_URL || 'http://localhost:4020'}/stats`)
      if (sr.ok) totalCalls = ((await sr.json()) as any).passthroughs ?? 0
    } catch {}

    let score: number
    if (totalCalls === 0 && reportCount === 0) score = 0.95
    else score = Math.max(0, 1 - (reportCount / Math.max(1, totalCalls)))

    reputationCache.set(serviceId, { score, ts: Date.now() })
    return score
  } catch {
    return 0.95
  }
}

// Sync wrapper for the existing list-services flow. Uses cached value if
// available (synchronous), falls back to neutral default otherwise. The
// reputationCache gets warmed by an async pre-fetch loop in handleListServices.
function lookupReputation(serviceId: string): number {
  const cached = reputationCache.get(serviceId)
  return cached ? cached.score : 0.95
}

// Popularity lookup placeholder. Day 4 will track actual call counts via
// the metering anchor. Until then we surface newest services first — this
// mirrors the open-marketplace pitch (new agents get instant visibility).
function lookupPopularity(s: CatalogEntry): number {
  return -s.registeredAt  // smaller (more negative) sorts first → newer first
}

async function handleSearchServicesSemantic(args: any): Promise<string> {
  const query = String(args?.query || '').trim()
  if (!query) return JSON.stringify({ error: 'query is required' }, null, 2)
  const limit = Math.min(Math.max(1, parseInt(args?.limit, 10) || 5), 20)

  try {
    // Step 1: embed the query
    const embedResp = await fetch(`${EMBED_TEXT_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: query }),
    })
    if (!embedResp.ok) {
      return JSON.stringify({ error: 'embed-text failed', status: embedResp.status }, null, 2)
    }
    const embedJson = await embedResp.json() as any
    const queryVec: number[] | undefined = embedJson?.result?.embedding ?? embedJson?.embedding
    if (!Array.isArray(queryVec)) {
      return JSON.stringify({ error: 'embed-text returned no embedding' }, null, 2)
    }

    // Step 2: list all service-embedding entries
    const listResp = await fetch(`${MEMORY_AGENT_URL}/memory-list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace: 'peck-pay:service-embeddings' }),
    })
    if (!listResp.ok) {
      return JSON.stringify({ error: 'memory-list failed', status: listResp.status }, null, 2)
    }
    const listJson = await listResp.json() as any
    const items: any[] = listJson.items ?? []
    if (items.length === 0) {
      return JSON.stringify({
        error: 'no services indexed yet',
        hint: 'restart multi-host-launcher to trigger indexService Embeddings()',
      }, null, 2)
    }

    // Step 3: read each entry, compute cosine similarity, sort
    const scored: Array<{ service_id: string; score: number; data: any }> = []
    for (const item of items) {
      try {
        const r = await fetch(`${MEMORY_AGENT_URL}/memory-read?handle=${encodeURIComponent(item.handle)}`)
        if (!r.ok) continue
        const e = await r.json() as any
        const data = typeof e.value === 'string' ? JSON.parse(e.value) : e.value
        const vec: number[] | undefined = data?.embedding
        if (!Array.isArray(vec) || vec.length !== queryVec.length) continue
        scored.push({ service_id: data.service_id, score: cosineSim(queryVec, vec), data })
      } catch {}
    }
    scored.sort((a, b) => b.score - a.score)
    const top = scored.slice(0, limit)

    return JSON.stringify({
      query,
      indexed_services: items.length,
      returned: top.length,
      results: top.map(s => ({
        service_id: s.service_id,
        score: Number(s.score.toFixed(4)),
        capabilities: s.data.capabilities,
        price_sats: s.data.price_sats,
        endpoint: s.data.endpoint,
        description: s.data.description,
      })),
      hint: 'Cosine similarity over 384-dim embeddings. Higher score = more semantically similar. Use peck_call_service with the chosen service_id to actually call it.',
    }, null, 2)
  } catch (e: any) {
    return JSON.stringify({ error: 'semantic search failed', detail: String(e?.message || e) }, null, 2)
  }
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

async function handleMarketplaceOverview(): Promise<string> {
  // Bounded response — fits in ~1-2KB regardless of catalog size.
  const FEATURED_SERVICES_MAX = 12
  const FEATURED_WORKFLOWS_MAX = 5

  let catalog: CatalogEntry[] = []
  try {
    catalog = await fetchCatalog()
  } catch (e: any) {
    return JSON.stringify({
      error: `marketplace registry not running at ${REGISTRY_URL}`,
      detail: String(e?.message || e),
    }, null, 2)
  }

  // Aggregate by capability so the overview shows category coverage.
  const capCounts: Record<string, number> = {}
  for (const s of catalog) {
    for (const c of s.capabilities) {
      capCounts[c] = (capCounts[c] || 0) + 1
    }
  }
  const topCapabilities = Object.entries(capCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([cap, n]) => ({ capability: cap, service_count: n }))

  // Featured services: take a representative sample. Cheapest of each
  // top capability, so the orientation surfaces variety, not just whoever
  // happens to have lowest pricePerCall overall.
  const featuredIds = new Set<string>()
  const featured: any[] = []
  for (const { capability } of topCapabilities) {
    if (featured.length >= FEATURED_SERVICES_MAX) break
    const cheapest = catalog
      .filter(s => s.capabilities.includes(capability) && !featuredIds.has(s.id))
      .sort((a, b) => a.pricePerCall - b.pricePerCall)[0]
    if (cheapest) {
      featuredIds.add(cheapest.id)
      featured.push({
        id: cheapest.id,
        capabilities: cheapest.capabilities,
        price_sats: cheapest.pricePerCall,
        endpoint: cheapest.endpoint,
        description: cheapest.description?.slice(0, 100),
      })
    }
  }
  // Top up if we still have room — add newest registered services not yet shown
  const fillers = catalog
    .filter(s => !featuredIds.has(s.id))
    .sort((a, b) => b.registeredAt - a.registeredAt)
    .slice(0, FEATURED_SERVICES_MAX - featured.length)
  for (const s of fillers) {
    featured.push({
      id: s.id,
      capabilities: s.capabilities,
      price_sats: s.pricePerCall,
      endpoint: s.endpoint,
      description: s.description?.slice(0, 100),
    })
  }

  // Featured workflows — fetch from memory-agent
  let workflowsCount = 0
  const featuredWorkflows: any[] = []
  try {
    const r = await fetch(`${MEMORY_AGENT_URL}/memory-list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace: WORKFLOWS_NAMESPACE }),
    })
    if (r.ok) {
      const list = await r.json() as any
      workflowsCount = list.count ?? 0
      for (const item of (list.items ?? []).slice(0, FEATURED_WORKFLOWS_MAX)) {
        try {
          const read = await fetch(`${MEMORY_AGENT_URL}/memory-read?handle=${encodeURIComponent(item.handle)}`)
          if (!read.ok) continue
          const r2 = await read.json() as any
          const wf = typeof r2.value === 'string' ? JSON.parse(r2.value) : r2.value
          featuredWorkflows.push({
            id: wf.id ?? item.key,
            name: wf.name,
            description: wf.description?.slice(0, 120),
            steps: Array.isArray(wf.steps) ? wf.steps.length : 0,
            est_cost_sats: wf.estimated_cost_sats,
          })
        } catch {}
      }
    }
  } catch { /* memory-agent down — fine, just no workflows in overview */ }

  return JSON.stringify({
    network: NETWORK,
    registry: REGISTRY_URL,
    counts: {
      total_services: catalog.length,
      total_workflows: workflowsCount,
      total_capabilities: Object.keys(capCounts).length,
    },
    top_capabilities: topCapabilities,
    featured_services: featured,
    featured_workflows: featuredWorkflows,
    how_to_discover_more: {
      browse_services: 'peck_list_services({capability: "memory", limit: 20})',
      paginate_services: 'peck_list_services({limit: 50, offset: 0})',
      browse_workflows: 'peck_list_workflows()',
      run_a_workflow: 'peck_run_workflow({workflow_id: "research-and-remember", input: {url: "..."}})',
      check_a_specific_service: 'peck_call_service({service_id: "...", payload: {...}})',
    },
    how_to_contribute: {
      register_a_workflow: 'peck_register_workflow({id, name, description, steps[]}) — workflows are JSON, no code required',
      offer_a_service: 'Run any HTTP server with /health + /<capability> routes, POST {id, name, capabilities, pricePerCall, endpoint, description} to ' + REGISTRY_URL + '/announce',
      docs: 'See DEMO.md in the peck-pay repo for the full architecture and contribution guide.',
    },
  }, null, 2)
}

async function handleListServices(args: any): Promise<string> {
  let catalog: CatalogEntry[]
  try {
    catalog = await fetchCatalog()
  } catch (e: any) {
    return JSON.stringify({
      error: `marketplace registry not running at ${REGISTRY_URL}`,
      hint: 'Start it with: npx tsx src/brc-marketplace-daemon.ts',
      detail: String(e?.message || e),
    }, null, 2)
  }

  // Pre-warm reputation cache for all services in parallel so the sync
  // lookupReputation calls below get real values, not the 0.95 default.
  await Promise.all(catalog.map(s => lookupReputationLive(s.id)))

  // Filter
  let filtered = catalog
  if (args?.capability) {
    const cap = String(args.capability).toLowerCase()
    filtered = filtered.filter(s =>
      s.capabilities.some(c => c.toLowerCase().includes(cap))
    )
  }
  if (args?.max_price !== undefined) {
    const maxP = Number(args.max_price)
    filtered = filtered.filter(s => s.pricePerCall <= maxP)
  }
  if (args?.min_reputation !== undefined) {
    const minR = Number(args.min_reputation)
    filtered = filtered.filter(s => lookupReputation(s.id) >= minR)
  }

  // Sort
  const sortBy = String(args?.sort_by || 'popularity')
  switch (sortBy) {
    case 'price':
      filtered.sort((a, b) => a.pricePerCall - b.pricePerCall)
      break
    case 'newest':
      filtered.sort((a, b) => b.registeredAt - a.registeredAt)
      break
    case 'reputation':
      filtered.sort((a, b) => lookupReputation(b.id) - lookupReputation(a.id))
      break
    case 'latency':
    case 'popularity':
    default:
      filtered.sort((a, b) => lookupPopularity(a) - lookupPopularity(b))
      break
  }

  // Paginate
  const offset = Math.max(0, parseInt(args?.offset, 10) || 0)
  const limit = Math.min(200, Math.max(1, parseInt(args?.limit, 10) || 50))
  const page = filtered.slice(offset, offset + limit)

  return JSON.stringify({
    network: NETWORK,
    registry: REGISTRY_URL,
    total_in_catalog: catalog.length,
    total_matching: filtered.length,
    returned: page.length,
    offset,
    limit,
    sort_by: sortBy,
    next_offset: offset + page.length < filtered.length ? offset + page.length : null,
    services: page.map(s => ({
      id: s.id,
      name: s.name,
      capabilities: s.capabilities,
      price_sats: s.pricePerCall,
      reputation: lookupReputation(s.id),
      endpoint: s.endpoint,
      identity_key: s.identityKey.slice(0, 16) + '…',
      description: s.description,
    })),
  }, null, 2)
}

async function handleCallService(args: any): Promise<string> {
  const serviceId = String(args?.service_id || '').trim()
  if (!serviceId) {
    return JSON.stringify({ error: 'service_id is required' }, null, 2)
  }
  const payload = args?.payload || {}

  // Look up the service in the catalog
  let catalog: CatalogEntry[]
  try {
    catalog = await fetchCatalog()
  } catch (e: any) {
    return JSON.stringify({
      error: `marketplace registry not reachable at ${REGISTRY_URL}`,
      detail: String(e?.message || e),
    }, null, 2)
  }
  const service = catalog.find(s => s.id === serviceId)
  if (!service) {
    return JSON.stringify({
      error: `service '${serviceId}' not found in marketplace`,
      hint: 'Use peck_list_services to discover available services.',
      catalog_size: catalog.length,
    }, null, 2)
  }
  if (!service.paymentAddress) {
    return JSON.stringify({
      error: `service '${serviceId}' has no paymentAddress in its catalog entry`,
      hint: 'Service must declare a P2PKH address on registration. BRC-29 derivation not yet supported by peck_call_service.',
    }, null, 2)
  }

  // Acquire the ladder client (initializes db + rifle on first call)
  let client: LadderClient
  try {
    client = await getLadderClient()
  } catch (e: any) {
    return JSON.stringify({
      error: 'failed to initialize ladder client',
      detail: String(e?.message || e),
    }, null, 2)
  }

  // Check ammo before firing — give a clear error if empty
  if (ladderRifle) {
    const ammo = await ladderRifle.remainingAmmo()
    if (ammo === 0) {
      return JSON.stringify({
        error: `wallet ${WALLET.label} has no leaves available in the ladder`,
        hint: `Fund the wallet (peck_request_faucet on testnet) and build leaves: FUNDER=${WALLET.source === 'env-named' ? WALLET.label : 'auto'} LEAF_COUNT=20 LEAF_SATS=200 npx tsx scripts/build-tiny-ladder.ts`,
        wallet_address: WALLET_ADDRESS,
        ladder_db: LADDER_DB_PATH,
      }, null, 2)
    }
  }

  // Fire the call (parallel payment + HTTP)
  try {
    const receipt = await client.call({
      serviceId: service.id,
      serviceEndpoint: service.endpoint + '/infer',  // convention for inference agents; may need to be configurable
      recipientAddress: service.paymentAddress,
      paymentSats: service.pricePerCall,
      payload,
    })
    return JSON.stringify({
      service_id: receipt.serviceId,
      request_id: receipt.requestId,
      response_status: receipt.responseStatus,
      response: tryParseJson(receipt.responseSnippet),
      payment: {
        txid: receipt.txid,
        sats: receipt.paymentSats,
        commitment_hex: receipt.commitmentHex,
        endpoint: receipt.endpoint,
      },
      duration_ms: receipt.durationMs,
      verify: `https://${NETWORK === 'test' ? 'test.' : ''}whatsonchain.com/tx/${receipt.txid}`,
    }, null, 2)
  } catch (e: any) {
    return JSON.stringify({
      error: 'service call failed',
      service_id: serviceId,
      detail: String(e?.message || e),
    }, null, 2)
  }
}

function tryParseJson(s: string): any {
  try { return JSON.parse(s) } catch { return s }
}

async function getWalletBalance(address: string): Promise<{ satoshis: number; utxos: number }> {
  const r = await fetch(`${WOC_BASE}/address/${address}/unspent`)
  if (!r.ok) throw new Error(`WoC ${r.status}`)
  const utxos = await r.json() as Array<{ value: number }>
  const total = utxos.reduce((sum, u) => sum + u.value, 0)
  return { satoshis: total, utxos: utxos.length }
}

async function handleWalletInfo(): Promise<string> {
  if (WALLET.error) {
    return JSON.stringify({ error: WALLET.error, source: WALLET.source }, null, 2)
  }

  let balance = { satoshis: 0, utxos: 0 }
  let balanceError: string | null = null
  try {
    balance = await getWalletBalance(WALLET_ADDRESS)
  } catch (e: any) {
    balanceError = String(e?.message || e)
  }

  const fundInstructions =
    NETWORK === 'test'
      ? `This is a testnet wallet. Call peck_request_faucet to get ${FAUCET_AMOUNT_SATS} free testnet sats (rate-limited to once per ${FAUCET_COOLDOWN_MS / 3600000}h per wallet).`
      : `Send BSV to ${WALLET_ADDRESS} from any wallet to fund this account. Each marketplace service call costs 5-200 sat depending on the service. ~5000 sat is enough for ~30-50 calls.`

  return JSON.stringify({
    network: NETWORK,
    wallet_label: WALLET.label,
    wallet_source: WALLET.source,
    address: WALLET_ADDRESS,
    balance_sats: balance.satoshis,
    balance_bsv: (balance.satoshis / 1e8).toFixed(8),
    utxo_count: balance.utxos,
    balance_error: balanceError,
    fund_instructions: fundInstructions,
    next_step:
      balance.satoshis === 0
        ? (NETWORK === 'test' ? 'Call peck_request_faucet to get started.' : 'Send BSV to the address above to start using the marketplace.')
        : 'Use peck_list_services to discover services and peck_call_service to call them.',
  }, null, 2)
}

// In-memory rate limit map: address → last fund timestamp.
// Resets on MCP server restart, which is fine for hackathon scope.
const faucetLastFundedAt = new Map<string, number>()

async function handleRequestFaucet(): Promise<string> {
  if (NETWORK !== 'test') {
    return JSON.stringify({
      error: 'faucet only available on testnet',
      hint: 'Send BSV to your wallet address from any source. Use peck_wallet_info to see your address.',
      network: NETWORK,
    }, null, 2)
  }
  if (WALLET.error || !WALLET.privateKey) {
    return JSON.stringify({ error: 'wallet not initialized', detail: WALLET.error }, null, 2)
  }

  // Rate limit
  const last = faucetLastFundedAt.get(WALLET_ADDRESS) || 0
  const elapsed = Date.now() - last
  if (elapsed < FAUCET_COOLDOWN_MS) {
    const remainingMin = Math.ceil((FAUCET_COOLDOWN_MS - elapsed) / 60000)
    return JSON.stringify({
      error: 'faucet cooldown active',
      detail: `Please wait ${remainingMin} more minutes before requesting again.`,
      cooldown_ms: FAUCET_COOLDOWN_MS - elapsed,
    }, null, 2)
  }

  // Load the faucet wallet (the one paying out)
  let faucetKey: PrivateKey
  let faucetAddress: string
  try {
    const wallets = JSON.parse(readFileSync('.wallets.json', 'utf-8'))
    if (!wallets[FAUCET_WALLET_NAME]) {
      throw new Error(`faucet wallet '${FAUCET_WALLET_NAME}' not in .wallets.json`)
    }
    faucetKey = PrivateKey.fromHex(wallets[FAUCET_WALLET_NAME].hex)
    faucetAddress = wallets[FAUCET_WALLET_NAME].address
  } catch (e: any) {
    return JSON.stringify({
      error: 'faucet not configured on this server',
      detail: String(e?.message || e),
      hint: `The MCP server needs a wallet named '${FAUCET_WALLET_NAME}' in .wallets.json with funded testnet UTXOs.`,
    }, null, 2)
  }

  // Find the faucet's largest UTXO and build a one-shot payment to the user.
  try {
    const r = await fetch(`${WOC_BASE}/address/${faucetAddress}/unspent`)
    if (!r.ok) throw new Error(`WoC ${r.status}`)
    const utxos = await r.json() as Array<{ tx_hash: string; tx_pos: number; value: number; height: number }>
    if (utxos.length === 0) {
      return JSON.stringify({ error: 'faucet wallet has no UTXOs', faucet: faucetAddress }, null, 2)
    }
    // Pick the largest UTXO that's big enough to cover faucet + fee + dust
    utxos.sort((a, b) => b.value - a.value)
    const minNeeded = FAUCET_AMOUNT_SATS + 200  // amount + fee headroom
    const utxo = utxos.find(u => u.value >= minNeeded)
    if (!utxo) {
      return JSON.stringify({
        error: 'faucet wallet has no UTXO large enough',
        largest: utxos[0]?.value,
        needed: minNeeded,
        hint: 'Faucet wallet needs refilling — admin should consolidate dust',
      }, null, 2)
    }

    // Fetch parent tx hex (needed for signing)
    const parentRes = await fetch(`${WOC_BASE}/tx/${utxo.tx_hash}/hex`)
    if (!parentRes.ok) throw new Error(`WoC tx hex ${parentRes.status}`)
    const parentHex = (await parentRes.text()).trim()
    const parentTx = Transaction.fromHex(parentHex)

    // Build 1-in 2-out tx: faucet → user + change back to faucet
    const tx = new Transaction()
    tx.addInput({
      sourceTransaction: parentTx,
      sourceOutputIndex: utxo.tx_pos,
      unlockingScriptTemplate: new P2PKH().unlock(faucetKey),
    })
    tx.addOutput({
      lockingScript: new P2PKH().lock(WALLET_ADDRESS),
      satoshis: FAUCET_AMOUNT_SATS,
    })
    tx.addOutput({
      lockingScript: new P2PKH().lock(faucetAddress),
      change: true,
    })
    await tx.fee()
    await tx.sign()

    const rawHex = tx.toHex()
    const result = await arcBroadcast(rawHex, NETWORK)

    // Persist the funding tx hex into the auto-wallet json so the build
    // script can build a ladder from it without waiting for WoC mempool
    // indexing (which is unreliable on fresh broadcasts).
    if (WALLET.source !== 'env-named') {
      try {
        const data = JSON.parse(readFileSync(AUTO_WALLET_PATH, 'utf-8'))
        data.lastFundingTx = {
          txid: tx.id('hex'),
          rawHex,
          vout: 0,  // we always put the user payment at output index 0
          satoshis: FAUCET_AMOUNT_SATS,
          fundedAt: Date.now(),
          source: 'faucet',
        }
        writeFileSync(AUTO_WALLET_PATH, JSON.stringify(data, null, 2))
      } catch (e: any) {
        console.error(`[peck-mcp] failed to persist funding tx: ${e?.message}`)
      }
    }

    // Mark cooldown
    faucetLastFundedAt.set(WALLET_ADDRESS, Date.now())

    return JSON.stringify({
      ok: true,
      faucet_amount_sats: FAUCET_AMOUNT_SATS,
      txid: tx.id('hex'),
      to_address: WALLET_ADDRESS,
      from_faucet: faucetAddress,
      arc_endpoint: result.endpoint,
      verify: `https://${NETWORK === 'test' ? 'test.' : ''}whatsonchain.com/tx/${tx.id('hex')}`,
      note: 'Funds will be visible in peck_wallet_info within ~10 seconds. You can now call peck_list_services and peck_call_service.',
    }, null, 2)
  } catch (e: any) {
    return JSON.stringify({
      error: 'faucet payment failed',
      detail: String(e?.message || e),
    }, null, 2)
  }
}

// ============================================================================
// Memory tool handlers — route via memory-agent v2 directly.
//
// These tools bypass the legacy ladder/PaymentRifle path entirely. The
// memory-agent v2 service handles its own payment routing through
// bank-shim and storage-shim, so MCP just needs to call the HTTP API.
// ============================================================================

const MEMORY_AGENT_URL = process.env.PECK_MEMORY_AGENT_URL || 'http://localhost:4011'
const SOCIAL_AGENT_URL = process.env.PECK_SOCIAL_URL || 'http://localhost:4050'

// ---- Overlay paywall helpers (BRC-42 derived payments) ----------------------

/**
 * Fetch from overlay with auto-payment on 402.
 * Uses BRC-42 ECDH to derive a unique payment address per content_key:
 *   agentPrivKey + peckIdentityKey + protocolID + keyID → derived address
 * Peck server can recover all derived keys because it holds the identity privkey.
 */
async function overlayGet(path: string, agentAddress?: string): Promise<any> {
  const url = `${OVERLAY_URL}/v1${path}`
  const headers: Record<string, string> = {}
  if (agentAddress) headers['X-Peck-User'] = agentAddress

  const r = await fetch(url, { headers })

  if (r.status === 402) {
    // Paywall hit — auto-pay via BRC-42 derived address
    const paywall = await r.json()
    const contentKey = paywall.content_key || ''
    const priceSats = paywall.price_sats || 1000

    console.error(`[peck-mcp] 402 paywall: ${priceSats} sats for ${contentKey}`)

    const txid = await payOverlayBRC42(contentKey, priceSats)
    if (!txid) throw new Error(`Payment failed for ${contentKey}`)

    // Record receipt in overlay
    await fetch(`${OVERLAY_URL}/v1/access/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_address: agentAddress || WALLET_ADDRESS,
        content_type: paywall.content_type || 'batch',
        content_key: contentKey,
        payment_txid: txid,
        sats: priceSats,
      }),
    })

    // Retry the original request
    const r2 = await fetch(url, { headers })
    return r2.json()
  }

  if (!r.ok) throw new Error(`Overlay ${r.status}: ${await r.text()}`)
  return r.json()
}

/**
 * BRC-42 derived payment: derive unique address from agent's key + peck identity key.
 * Each contentKey produces a different address — no accumulation on a single UTXO.
 *
 * Derivation: SHA256(ECDH(agentPriv, peckPub) || 'peck-access:' || contentKey)
 * → deterministic private key → P2PKH address
 *
 * Peck server does the inverse: SHA256(ECDH(peckPriv, agentPub) || same) → same key
 */
async function payOverlayBRC42(contentKey: string, sats: number): Promise<string | null> {
  if (!WALLET.privateKey) return null

  try {
    const agentKey = WALLET.privateKey!
    const { Hash } = await import('@bsv/sdk')

    // BRC-42 ECDH: derive shared secret between agent and peck
    const peckPub = PrivateKey.fromString(PECK_IDENTITY_KEY, 'hex').toPublicKey()
    const sharedPoint = peckPub.mul(agentKey)
    const sharedHex = Buffer.from(sharedPoint.encode(true) as number[]).toString('hex')

    // Derive payment key: SHA256(sharedSecret || 'peck-access:' || contentKey)
    const derivationData = Buffer.concat([
      Buffer.from(sharedHex, 'hex'),
      Buffer.from('peck-access:' + contentKey, 'utf8'),
    ])
    const derivedHash = Buffer.from(Hash.sha256(Array.from(derivationData))).toString('hex')
    const derivedKey = PrivateKey.fromString(derivedHash, 'hex')
    const paymentAddress = derivedKey.toPublicKey().toAddress()

    // Fetch agent's UTXOs from WoC
    const r = await fetch(`${WOC_BASE}/address/${WALLET_ADDRESS}/unspent`)
    if (!r.ok) throw new Error(`WoC ${r.status}`)
    const utxos = await r.json() as Array<{ tx_hash: string; tx_pos: number; value: number }>
    if (!utxos.length) throw new Error('No UTXOs available')

    // Pick smallest UTXO that covers sats + fee
    utxos.sort((a, b) => a.value - b.value)
    const minNeeded = sats + 200
    const utxo = utxos.find(u => u.value >= minNeeded)
    if (!utxo) throw new Error(`No UTXO >= ${minNeeded} sats (largest: ${utxos[utxos.length - 1]?.value})`)

    // Fetch parent TX hex
    const parentRes = await fetch(`${WOC_BASE}/tx/${utxo.tx_hash}/hex`)
    if (!parentRes.ok) throw new Error(`WoC tx hex ${parentRes.status}`)
    const parentHex = (await parentRes.text()).trim()
    const parentTx = Transaction.fromHex(parentHex)

    // Build TX: 1 input → payment output + change back to agent
    const tx = new Transaction()
    tx.addInput({
      sourceTransaction: parentTx,
      sourceOutputIndex: utxo.tx_pos,
      unlockingScriptTemplate: new P2PKH().unlock(agentKey),
    })
    tx.addOutput({
      lockingScript: new P2PKH().lock(paymentAddress),
      satoshis: sats,
    })
    tx.addOutput({
      lockingScript: new P2PKH().lock(WALLET_ADDRESS),
      change: true,
    })
    await tx.fee()
    await tx.sign()

    const rawHex = tx.toHex()
    const result = await arcBroadcast(rawHex, NETWORK)

    console.error(`[peck-mcp] paywall paid: ${result.txid} (${sats} sats → ${paymentAddress})`)
    return result.txid
  } catch (e: any) {
    console.error(`[peck-mcp] BRC-42 payment error:`, e?.message || e)
    return null
  }
}

// ---- Bitcoin Schema social handlers -----------------------------------------

function getAgentSigningKey(): string {
  return privateKeyToHex(WALLET.privateKey!)
}

function getAgentPubkey(): string {
  return WALLET.privateKey!.toPublicKey().toString()
}

async function socialPost(path: string, body: any): Promise<string> {
  try {
    const r = await fetch(`${SOCIAL_AGENT_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return JSON.stringify(await r.json(), null, 2)
  } catch (e: any) {
    return JSON.stringify({ error: 'social-agent not reachable', url: SOCIAL_AGENT_URL, detail: String(e?.message || e) }, null, 2)
  }
}

async function socialGet(path: string): Promise<string> {
  try {
    const r = await fetch(`${SOCIAL_AGENT_URL}${path}`)
    return JSON.stringify(await r.json(), null, 2)
  } catch (e: any) {
    return JSON.stringify({ error: 'social-agent not reachable', url: SOCIAL_AGENT_URL, detail: String(e?.message || e) }, null, 2)
  }
}

async function handlePost(args: any): Promise<string> {
  return socialPost('/post', {
    content: args?.content, signing_key: getAgentSigningKey(),
    tags: args?.tags, channel: args?.channel,
    paywalled: args?.paywalled, price: args?.price,
  })
}
async function handleReply(args: any): Promise<string> {
  return socialPost('/reply', {
    content: args?.content, signing_key: getAgentSigningKey(),
    parent_txid: args?.parent_txid, tags: args?.tags,
  })
}
async function handleLike(args: any): Promise<string> {
  return socialPost('/like', { signing_key: getAgentSigningKey(), target_txid: args?.target_txid })
}
async function handleFollow(args: any): Promise<string> {
  return socialPost('/follow', { signing_key: getAgentSigningKey(), target_pubkey: args?.target_pubkey })
}
async function handleSocialMessage(args: any): Promise<string> {
  return socialPost('/message', {
    content: args?.content, signing_key: getAgentSigningKey(),
    channel: args?.channel, recipient_pubkey: args?.recipient_pubkey, tags: args?.tags,
  })
}
async function handleFeed(args: any): Promise<string> {
  // Feed reads go directly to overlay.peck.to with paywall auto-payment.
  // Agent pays via BRC-42 derived address when offset >= free limit.
  const params = new URLSearchParams()
  if (args?.limit) params.set('limit', String(args.limit))
  if (args?.offset) params.set('offset', String(args.offset))
  if (args?.tag) params.set('tag', args.tag)
  if (args?.author) params.set('author', args.author)
  if (args?.type) params.set('type', args.type)
  try {
    const data = await overlayGet(`/feed?${params}`, WALLET_ADDRESS)
    return JSON.stringify(data, null, 2)
  } catch (e: any) {
    // Fallback to agent-commons if overlay unreachable
    return socialGet(`/feed?${params}`)
  }
}
async function handlePayAndRead(args: any): Promise<string> {
  // Single post paywall — try overlay first, fall back to agent-commons
  try {
    const data = await overlayGet(`/post/${args?.txid}`, WALLET_ADDRESS)
    return JSON.stringify(data, null, 2)
  } catch {
    return socialPost('/pay-and-read', { txid: args?.txid, reader_pubkey: getAgentPubkey() })
  }
}
async function handleThread(args: any): Promise<string> {
  try {
    const data = await overlayGet(`/thread/${args?.txid}`, WALLET_ADDRESS)
    return JSON.stringify(data, null, 2)
  } catch {
    return socialGet(`/thread/${args?.txid}`)
  }
}
async function handleFunctionRegister(args: any): Promise<string> {
  return socialPost('/function/register', {
    name: args?.name, description: args?.description,
    price: args?.price, args_type: args?.args_type,
    signing_key: getAgentSigningKey(),
  })
}
async function handleFunctionCall(args: any): Promise<string> {
  return socialPost('/function/call', {
    name: args?.name, args: args?.args,
    provider_pubkey: args?.provider_pubkey,
    signing_key: getAgentSigningKey(),
  })
}

async function handleMemoryWrite(args: any): Promise<string> {
  const namespace = String(args?.namespace || '').trim()
  const key = String(args?.key || '').trim()
  const value = args?.value
  const tags = Array.isArray(args?.tags) ? args.tags.map(String) : []
  if (!namespace) return JSON.stringify({ error: 'namespace is required' }, null, 2)
  if (!key) return JSON.stringify({ error: 'key is required' }, null, 2)
  if (value === undefined || value === null) return JSON.stringify({ error: 'value is required' }, null, 2)

  try {
    const r = await fetch(`${MEMORY_AGENT_URL}/memory-write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace, key, value, tags }),
    })
    if (!r.ok) {
      const body = await r.text()
      return JSON.stringify({ error: 'memory-agent rejected write', status: r.status, detail: body }, null, 2)
    }
    return JSON.stringify(await r.json(), null, 2)
  } catch (e: any) {
    return JSON.stringify({
      error: 'memory-agent not reachable',
      url: MEMORY_AGENT_URL,
      hint: 'Start it with: BANK_SHIM_URL=http://localhost:4020 STORAGE_SHIM_URL=http://localhost:4021 npx tsx src/agents/memory-agent-v2.ts',
      detail: String(e?.message || e),
    }, null, 2)
  }
}

async function handleMemoryRead(args: any): Promise<string> {
  const handle = String(args?.handle || '').trim()
  if (!handle) return JSON.stringify({ error: 'handle is required' }, null, 2)
  try {
    const r = await fetch(`${MEMORY_AGENT_URL}/memory-read?handle=${encodeURIComponent(handle)}`)
    if (!r.ok) return JSON.stringify({ error: 'memory-agent read failed', status: r.status, detail: await r.text() }, null, 2)
    return JSON.stringify(await r.json(), null, 2)
  } catch (e: any) {
    return JSON.stringify({ error: 'memory-agent not reachable', url: MEMORY_AGENT_URL, detail: String(e?.message || e) }, null, 2)
  }
}

async function handleMemoryList(args: any): Promise<string> {
  const namespace = String(args?.namespace || '').trim()
  if (!namespace) return JSON.stringify({ error: 'namespace is required' }, null, 2)
  try {
    const r = await fetch(`${MEMORY_AGENT_URL}/memory-list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace }),
    })
    if (!r.ok) return JSON.stringify({ error: 'memory-agent list failed', status: r.status, detail: await r.text() }, null, 2)
    return JSON.stringify(await r.json(), null, 2)
  } catch (e: any) {
    return JSON.stringify({ error: 'memory-agent not reachable', url: MEMORY_AGENT_URL, detail: String(e?.message || e) }, null, 2)
  }
}

async function handleMemorySearch(args: any): Promise<string> {
  const tag = String(args?.tag || '').trim()
  if (!tag) return JSON.stringify({ error: 'tag is required' }, null, 2)
  try {
    const r = await fetch(`${MEMORY_AGENT_URL}/memory-search-tag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag }),
    })
    if (!r.ok) return JSON.stringify({ error: 'memory-agent search failed', status: r.status, detail: await r.text() }, null, 2)
    return JSON.stringify(await r.json(), null, 2)
  } catch (e: any) {
    return JSON.stringify({ error: 'memory-agent not reachable', url: MEMORY_AGENT_URL, detail: String(e?.message || e) }, null, 2)
  }
}

// ============================================================================
// Killer micro-service tool handlers — thin relays to multi-host agents
// ============================================================================

const NOTARIZE_URL = process.env.PECK_NOTARIZE_URL || 'http://localhost:4039'
const FETCH_SUMMARIZE_URL = process.env.PECK_FETCH_SUMMARIZE_URL || 'http://localhost:4040'
const EMBED_TEXT_URL = process.env.PECK_EMBED_TEXT_URL || 'http://localhost:4041'

async function relayPost(url: string, body: any, agentName: string): Promise<string> {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) {
      const text = await r.text()
      return JSON.stringify({ error: `${agentName} rejected request`, status: r.status, detail: text }, null, 2)
    }
    // Agents built via agent-factory wrap responses as
    // { service_id, capability, price_paid_sats, result }. Flatten so MCP
    // callers see a clean { ...result, _service, _price } shape.
    const wrapped = await r.json() as any
    if (wrapped && typeof wrapped === 'object' && 'result' in wrapped) {
      return JSON.stringify({
        ...wrapped.result,
        _service: wrapped.service_id,
        _capability: wrapped.capability,
        _price_paid_sats: wrapped.price_paid_sats,
      }, null, 2)
    }
    return JSON.stringify(wrapped, null, 2)
  } catch (e: any) {
    return JSON.stringify({
      error: `${agentName} not reachable`,
      url,
      hint: 'Start the multi-host stack: REGISTRY_URL=http://localhost:8080 npx tsx src/multi-host-launcher.ts',
      detail: String(e?.message || e),
    }, null, 2)
  }
}

async function handleNotarize(args: any): Promise<string> {
  const data = args?.data
  const hash = args?.hash
  if (data === undefined && !hash) {
    return JSON.stringify({ error: 'either data or hash is required' }, null, 2)
  }
  return await relayPost(`${NOTARIZE_URL}/notarize`, args, 'notarize agent')
}

async function handleSummarizeUrl(args: any): Promise<string> {
  const url = String(args?.url || '').trim()
  if (!url) return JSON.stringify({ error: 'url is required' }, null, 2)
  return await relayPost(`${FETCH_SUMMARIZE_URL}/fetch-and-summarize`, args, 'fetch-and-summarize agent')
}

async function handleEmbedText(args: any): Promise<string> {
  const text = String(args?.text || '')
  if (!text) return JSON.stringify({ error: 'text is required' }, null, 2)
  return await relayPost(`${EMBED_TEXT_URL}/embed`, args, 'embed-text agent')
}

// ============================================================================
// Workflow tool handlers — workflows are stored as memory entries in
// namespace 'peck-pay:workflows', tagged 'workflow'.
// ============================================================================

const WORKFLOW_RUNNER_URL = process.env.PECK_WORKFLOW_RUNNER_URL || 'http://localhost:4042'
const WORKFLOWS_NAMESPACE = 'peck-pay:workflows'

async function handleListWorkflows(): Promise<string> {
  try {
    const r = await fetch(`${MEMORY_AGENT_URL}/memory-list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace: WORKFLOWS_NAMESPACE }),
    })
    if (!r.ok) return JSON.stringify({ error: 'memory-agent list failed', status: r.status }, null, 2)
    const list = await r.json() as any
    // Each entry's full value lives in the index cache; fetch each via /memory-read
    const summaries: any[] = []
    for (const item of list.items ?? []) {
      try {
        const read = await fetch(`${MEMORY_AGENT_URL}/memory-read?handle=${encodeURIComponent(item.handle)}`)
        if (!read.ok) continue
        const r2 = await read.json() as any
        const wf = typeof r2.value === 'string' ? JSON.parse(r2.value) : r2.value
        summaries.push({
          id: wf.id ?? item.key,
          name: wf.name,
          description: wf.description,
          author: wf.author ?? 'unknown',
          step_count: Array.isArray(wf.steps) ? wf.steps.length : 0,
          estimated_cost_sats: wf.estimated_cost_sats,
          handle: item.handle,
          written_at: item.written_at,
        })
      } catch { /* skip broken entries */ }
    }
    return JSON.stringify({
      namespace: WORKFLOWS_NAMESPACE,
      count: summaries.length,
      workflows: summaries,
      hint: 'Use peck_run_workflow with workflow_id to execute, or peck_register_workflow to add your own.',
    }, null, 2)
  } catch (e: any) {
    return JSON.stringify({ error: 'memory-agent not reachable', detail: String(e?.message || e) }, null, 2)
  }
}

async function handleRunWorkflow(args: any): Promise<string> {
  const workflow_id = String(args?.workflow_id || '').trim()
  if (!workflow_id) return JSON.stringify({ error: 'workflow_id is required' }, null, 2)
  return await relayPost(`${WORKFLOW_RUNNER_URL}/run-workflow`, {
    workflow_id,
    input: args.input ?? {},
  }, 'workflow-runner')
}

// ============================================================================
// Wright §5.4 mechanism design — escrow + audit + reputation
// ============================================================================
//
// Reputation is derived, not stored — it's recomputed on each call from
// raw audit reports + bank-shim call counts. This means reports are the
// source of truth and can't be tampered with by writing a fake reputation
// number directly.
//
// Storage layout in memory-agent:
//   namespace: peck-pay:audit-reports
//   key:       <service_id>:<sha256(commitment)[:16]>     ← dedupes
//   value:     {service_id, reporter_identity, commitment, issue, severity, ts}
//   tags:      [audit-report, <service_id>, severity:<level>]
//
//   namespace: peck-pay:service-registrations
//   key:       <service_id>
//   value:     {full announcement + escrow_txid + escrow_satoshis + identityKey + registered_at}
//   tags:      [service-registration]
//
// Registry-side (marketplace-registry.ts) holds the live in-memory list
// for fast discovery; memory-agent holds the durable on-chain proof.

const AUDIT_REPORTS_NS = 'peck-pay:audit-reports'
const SERVICE_REGISTRATIONS_NS = 'peck-pay:service-registrations'

async function handleReportService(args: any): Promise<string> {
  const service_id = String(args?.service_id || '').trim()
  const commitment = String(args?.request_commitment || '').trim()
  const issue = String(args?.issue || '').trim()
  const severity = ['minor', 'major', 'critical'].includes(args?.severity) ? args.severity : 'minor'
  if (!service_id) return JSON.stringify({ error: 'service_id is required' }, null, 2)
  if (!commitment) return JSON.stringify({ error: 'request_commitment is required (for dedupe)' }, null, 2)
  if (!issue) return JSON.stringify({ error: 'issue description is required' }, null, 2)

  // Deterministic key so multiple submissions of the same complaint dedupe.
  // memory-agent v2 uses most-recent-wins for same key, so re-submitting
  // overwrites rather than inflates.
  const crypto = await import('node:crypto')
  const commitHash = crypto.createHash('sha256').update(commitment).digest('hex').slice(0, 16)
  const dedupeKey = `${service_id}:${commitHash}`

  const value = {
    service_id,
    request_commitment: commitment,
    commitment_hash: commitHash,
    issue: issue.slice(0, 500),
    severity,
    reported_at: Date.now(),
    reporter_origin: 'peck-mcp',
  }

  try {
    const r = await fetch(`${MEMORY_AGENT_URL}/memory-write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        namespace: AUDIT_REPORTS_NS,
        key: dedupeKey,
        value,
        tags: ['audit-report', service_id, `severity:${severity}`],
      }),
    })
    if (!r.ok) return JSON.stringify({ error: 'memory-agent rejected report', status: r.status, detail: await r.text() }, null, 2)
    const body = await r.json() as any
    return JSON.stringify({
      reported: true,
      service_id,
      severity,
      handle: body.handle,
      explorer: body.explorer,
      note: 'Report stored on-chain. Reputation will be recomputed on next peck_get_reputation call. If you submit the same (service_id + commitment) again, it overwrites — no inflation.',
    }, null, 2)
  } catch (e: any) {
    return JSON.stringify({ error: 'memory-agent not reachable', detail: String(e?.message || e) }, null, 2)
  }
}

async function handleGetReputation(args: any): Promise<string> {
  const service_id = String(args?.service_id || '').trim()
  if (!service_id) return JSON.stringify({ error: 'service_id is required' }, null, 2)

  // 1. Count audit reports for this service
  const reports = await listReportsForService(service_id)
  const reportCount = reports.length
  const severityCount = { minor: 0, major: 0, critical: 0 }
  for (const r of reports) {
    if (r.severity === 'critical') severityCount.critical++
    else if (r.severity === 'major') severityCount.major++
    else severityCount.minor++
  }
  // Weighted: minor=1, major=3, critical=10
  const weightedReports = severityCount.minor + 3 * severityCount.major + 10 * severityCount.critical

  // 2. Get total successful calls from bank-shim stats (best proxy we have)
  let totalCalls = 0
  try {
    const r = await fetch(`${process.env.PECK_BANK_SHIM_URL || 'http://localhost:4020'}/stats`)
    if (r.ok) {
      const stats = await r.json() as any
      totalCalls = stats.passthroughs ?? 0
    }
  } catch {/* bank-shim might be down */}

  // 3. Get registration metadata (escrow info)
  let registration: any = null
  try {
    const r = await fetch(`${MEMORY_AGENT_URL}/memory-list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace: SERVICE_REGISTRATIONS_NS }),
    })
    if (r.ok) {
      const list = await r.json() as any
      const item = list.items?.find((i: any) => i.key === service_id)
      if (item) {
        const read = await fetch(`${MEMORY_AGENT_URL}/memory-read?handle=${encodeURIComponent(item.handle)}`)
        if (read.ok) {
          const e = await read.json() as any
          registration = typeof e.value === 'string' ? JSON.parse(e.value) : e.value
        }
      }
    }
  } catch {}

  // 4. Compute reputation
  // - New service with no audit history and no calls: 0.95 (high trust until proven otherwise)
  // - Service with calls but no reports: 1.0 (perfect)
  // - Service with reports: 1 - (weightedReports / max(1, totalCalls))
  let reputation: number
  if (totalCalls === 0 && reportCount === 0) {
    reputation = 0.95
  } else {
    reputation = Math.max(0, 1 - (weightedReports / Math.max(1, totalCalls)))
  }

  const recommendation =
    reputation >= 0.9 ? 'safe to use' :
    reputation >= 0.5 ? 'use with caution' :
    'avoid — high audit-report rate'

  return JSON.stringify({
    service_id,
    reputation: Number(reputation.toFixed(4)),
    recommendation,
    audit_reports: {
      total: reportCount,
      by_severity: severityCount,
      weighted_score: weightedReports,
    },
    total_calls: totalCalls,
    escrow: registration ? {
      txid: registration.escrow_txid ?? null,
      satoshis: registration.escrow_satoshis ?? null,
      verified: !!registration.escrow_verified,
    } : null,
    registered: !!registration,
    note: 'Reputation is derived live from on-chain audit reports + bank-shim call counts. It is recomputed on every call — there is no stored reputation number that can be tampered with.',
  }, null, 2)
}

async function listReportsForService(service_id: string): Promise<any[]> {
  try {
    // Search by 'audit-report' tag (the service_id tag is shared with
    // ledger-credit entries — using it would inflate counts).
    const r = await fetch(`${MEMORY_AGENT_URL}/memory-search-tag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: 'audit-report' }),
    })
    if (!r.ok) return []
    const list = await r.json() as any
    const out: any[] = []
    for (const item of list.items ?? []) {
      try {
        const read = await fetch(`${MEMORY_AGENT_URL}/memory-read?handle=${encodeURIComponent(item.handle)}`)
        if (!read.ok) continue
        const e = await read.json() as any
        const data = typeof e.value === 'string' ? JSON.parse(e.value) : e.value
        if (data?.service_id === service_id) out.push(data)
      } catch {}
    }
    return out
  } catch {
    return []
  }
}

async function handleRegisterService(args: any): Promise<string> {
  const id = String(args?.id || '').trim()
  if (!id) return JSON.stringify({ error: 'id is required' }, null, 2)
  if (!args?.name || !args?.endpoint || !args?.description) {
    return JSON.stringify({ error: 'name, endpoint, and description are required' }, null, 2)
  }
  if (!Array.isArray(args?.capabilities) || args.capabilities.length === 0) {
    return JSON.stringify({ error: 'capabilities array is required (non-empty)' }, null, 2)
  }
  const pricePerCall = Number(args?.pricePerCall ?? 0)
  if (pricePerCall < 1) return JSON.stringify({ error: 'pricePerCall must be ≥ 1 sat' }, null, 2)

  // Verify escrow tx if provided. We just check it exists on-chain via WoC —
  // not the full slashing path which would require multi-sig + dispute resolution.
  let escrow_verified = false
  if (args.escrow_txid) {
    try {
      const r = await fetch(`https://api.whatsonchain.com/v1/bsv/test/tx/${args.escrow_txid}`)
      escrow_verified = r.ok
    } catch {/* network issue, leave unverified */}
  }

  // Step 1: announce to marketplace registry (in-memory, fast discovery)
  let registryAccepted = false
  try {
    const r = await fetch(`${REGISTRY_URL}/announce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        name: args.name,
        identityKey: args.identityKey ?? '00'.repeat(33),
        endpoint: args.endpoint,
        capabilities: args.capabilities,
        pricePerCall,
        description: args.description,
      }),
    })
    registryAccepted = r.ok
  } catch {}

  // Step 2: store the full registration (with escrow data) on-chain via memory-agent
  const value = {
    id,
    name: args.name,
    endpoint: args.endpoint,
    capabilities: args.capabilities,
    pricePerCall,
    description: args.description,
    identityKey: args.identityKey ?? null,
    escrow_txid: args.escrow_txid ?? null,
    escrow_satoshis: args.escrow_satoshis ?? null,
    escrow_verified,
    registered_at: Date.now(),
    registered_by: 'peck-mcp',
  }

  try {
    const r = await fetch(`${MEMORY_AGENT_URL}/memory-write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        namespace: SERVICE_REGISTRATIONS_NS,
        key: id,
        value,
        tags: ['service-registration', escrow_verified ? 'escrow-verified' : 'no-escrow'],
      }),
    })
    if (!r.ok) {
      return JSON.stringify({
        error: 'memory-agent rejected registration',
        registry_accepted: registryAccepted,
        status: r.status,
      }, null, 2)
    }
    const body = await r.json() as any
    return JSON.stringify({
      registered: true,
      id,
      registry_accepted: registryAccepted,
      escrow_verified,
      escrow_warning: !args.escrow_txid ? 'No escrow provided — service is registered but flagged unverified. Production deployments should require escrow per Wright §5.4.' : null,
      on_chain_handle: body.handle,
      on_chain_txid: body.txid,
      explorer: body.explorer,
      initial_reputation: 0.95,
      note: 'Reputation starts at 0.95 (high but not perfect — no audit history yet). Will adjust based on peck_report_service submissions and call counts.',
    }, null, 2)
  } catch (e: any) {
    return JSON.stringify({ error: 'memory-agent not reachable', detail: String(e?.message || e) }, null, 2)
  }
}

// ============================================================================
// Held-earnings escrow handlers — query bank-shim's on-chain ledger
// ============================================================================

const BANK_SHIM_URL = process.env.PECK_BANK_SHIM_URL || 'http://localhost:4020'

async function handleGetServiceBalance(args: any): Promise<string> {
  const service_id = String(args?.service_id || '').trim()
  if (!service_id) return JSON.stringify({ error: 'service_id required' }, null, 2)
  try {
    const r = await fetch(`${BANK_SHIM_URL}/balance/${encodeURIComponent(service_id)}`)
    if (!r.ok) return JSON.stringify({ error: 'bank-shim balance lookup failed', status: r.status }, null, 2)
    const bal = await r.json() as any
    return JSON.stringify({
      ...bal,
      note: 'Available_balance is withdrawable now via peck_withdraw_earnings. Held_total is locked virtually as escrow against audit reports — production extension releases held after a delay with no critical reports.',
    }, null, 2)
  } catch (e: any) {
    return JSON.stringify({ error: 'bank-shim not reachable', detail: String(e?.message || e) }, null, 2)
  }
}

async function handleWithdrawEarnings(args: any): Promise<string> {
  const service_id = String(args?.service_id || '').trim()
  const recipient_address = String(args?.recipient_address || '').trim()
  const max_amount = args?.max_amount ? Number(args.max_amount) : undefined
  if (!service_id) return JSON.stringify({ error: 'service_id required' }, null, 2)
  if (!recipient_address) return JSON.stringify({ error: 'recipient_address required' }, null, 2)

  // Reputation gate
  const reputation = await lookupReputationLive(service_id)
  if (reputation < 0.5) {
    return JSON.stringify({
      error: 'withdrawal blocked: low reputation',
      service_id,
      reputation,
      note: 'Reputation < 0.5 — too many audit reports relative to call count. Withdraw blocked until reports are cleared or call volume increases.',
    }, null, 2)
  }

  try {
    const r = await fetch(`${BANK_SHIM_URL}/withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service_id, recipient_address, max_amount }),
    })
    if (!r.ok) {
      const body = await r.text()
      return JSON.stringify({ error: 'bank-shim withdrawal failed', status: r.status, detail: body }, null, 2)
    }
    return JSON.stringify(await r.json(), null, 2)
  } catch (e: any) {
    return JSON.stringify({ error: 'bank-shim not reachable', detail: String(e?.message || e) }, null, 2)
  }
}

async function handleRegisterWorkflow(args: any): Promise<string> {
  const id = String(args?.id || '').trim()
  if (!id) return JSON.stringify({ error: 'id is required' }, null, 2)
  if (!args?.name || !args?.description) return JSON.stringify({ error: 'name and description are required' }, null, 2)
  if (!Array.isArray(args?.steps) || args.steps.length === 0) {
    return JSON.stringify({ error: 'steps array is required (non-empty)' }, null, 2)
  }
  const value = {
    id,
    name: args.name,
    description: args.description,
    author: args.author ?? 'mcp-user',
    estimated_cost_sats: args.estimated_cost_sats,
    steps: args.steps,
  }
  try {
    const r = await fetch(`${MEMORY_AGENT_URL}/memory-write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        namespace: WORKFLOWS_NAMESPACE,
        key: id,
        value,
        tags: ['workflow', 'user-registered'],
      }),
    })
    if (!r.ok) return JSON.stringify({ error: 'memory-agent rejected workflow', status: r.status, detail: await r.text() }, null, 2)
    return JSON.stringify(await r.json(), null, 2)
  } catch (e: any) {
    return JSON.stringify({ error: 'memory-agent not reachable', detail: String(e?.message || e) }, null, 2)
  }
}

async function handleBalance(): Promise<string> {
  if (WALLET_ADDRESS.startsWith('ERROR')) {
    return JSON.stringify({ error: WALLET_ADDRESS }, null, 2)
  }

  try {
    const r = await fetch(`${WOC_BASE}/address/${WALLET_ADDRESS}/unspent`)
    if (!r.ok) throw new Error(`WoC ${r.status}`)
    const utxos = await r.json() as Array<{ value: number }>
    const total = utxos.reduce((sum, u) => sum + u.value, 0)
    return JSON.stringify({
      network: NETWORK,
      wallet: WALLET.label,
      address: WALLET_ADDRESS,
      satoshis: total,
      utxo_count: utxos.length,
      bsv: (total / 1e8).toFixed(8),
    }, null, 2)
  } catch (e: any) {
    return JSON.stringify({
      error: 'failed to query balance',
      detail: String(e?.message || e),
      wallet: WALLET.label,
      address: WALLET_ADDRESS,
    }, null, 2)
  }
}

// ============================================================================
// MCP request handlers
// ============================================================================

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS as any,
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params

  let text: string
  try {
    if (name === 'peck_marketplace_overview') {
      text = await handleMarketplaceOverview()
    } else if (name === 'peck_search_services_semantic') {
      text = await handleSearchServicesSemantic(args || {})
    } else if (name === 'peck_list_services') {
      text = await handleListServices(args || {})
    } else if (name === 'peck_balance') {
      text = await handleBalance()
    } else if (name === 'peck_wallet_info') {
      text = await handleWalletInfo()
    } else if (name === 'peck_request_faucet') {
      text = await handleRequestFaucet()
    } else if (name === 'peck_call_service') {
      text = await handleCallService(args || {})
    } else if (name === 'peck_memory_write') {
      text = await handleMemoryWrite(args || {})
    } else if (name === 'peck_memory_read') {
      text = await handleMemoryRead(args || {})
    } else if (name === 'peck_memory_list') {
      text = await handleMemoryList(args || {})
    } else if (name === 'peck_memory_search') {
      text = await handleMemorySearch(args || {})
    } else if (name === 'peck_notarize') {
      text = await handleNotarize(args || {})
    } else if (name === 'peck_summarize_url') {
      text = await handleSummarizeUrl(args || {})
    } else if (name === 'peck_embed_text') {
      text = await handleEmbedText(args || {})
    } else if (name === 'peck_list_workflows') {
      text = await handleListWorkflows()
    } else if (name === 'peck_run_workflow') {
      text = await handleRunWorkflow(args || {})
    } else if (name === 'peck_register_workflow') {
      text = await handleRegisterWorkflow(args || {})
    } else if (name === 'peck_report_service') {
      text = await handleReportService(args || {})
    } else if (name === 'peck_get_reputation') {
      text = await handleGetReputation(args || {})
    } else if (name === 'peck_register_service') {
      text = await handleRegisterService(args || {})
    } else if (name === 'peck_get_service_balance') {
      text = await handleGetServiceBalance(args || {})
    } else if (name === 'peck_withdraw_earnings') {
      text = await handleWithdrawEarnings(args || {})
    } else if (name === 'peck_post') {
      text = await handlePost(args || {})
    } else if (name === 'peck_reply') {
      text = await handleReply(args || {})
    } else if (name === 'peck_like') {
      text = await handleLike(args || {})
    } else if (name === 'peck_follow') {
      text = await handleFollow(args || {})
    } else if (name === 'peck_social_message') {
      text = await handleSocialMessage(args || {})
    } else if (name === 'peck_feed') {
      text = await handleFeed(args || {})
    } else if (name === 'peck_pay_and_read') {
      text = await handlePayAndRead(args || {})
    } else if (name === 'peck_thread') {
      text = await handleThread(args || {})
    } else if (name === 'peck_function_register') {
      text = await handleFunctionRegister(args || {})
    } else if (name === 'peck_function_call') {
      text = await handleFunctionCall(args || {})
    } else {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`)
    }
  } catch (e: any) {
    if (e instanceof McpError) throw e
    text = JSON.stringify({
      error: `tool '${name}' failed`,
      detail: String(e?.message || e),
    }, null, 2)
  }

  return {
    content: [{ type: 'text', text }],
  }
})

// ============================================================================
// Boot
// ============================================================================

// MCP uses stdio, so any console output MUST go to stderr or it breaks the
// JSON-RPC stream.
console.error(`[peck-mcp] starting on ${NETWORK}`)
console.error(`[peck-mcp] wallet: ${WALLET.label} (${WALLET.source}) ${WALLET_ADDRESS.slice(0, 20)}…`)
if (WALLET.source === 'auto-generated') {
  console.error(`[peck-mcp]   ↳ fresh wallet created at ${AUTO_WALLET_PATH}`)
}
console.error(`[peck-mcp] registry: ${REGISTRY_URL}`)
console.error(`[peck-mcp] tools: ${TOOLS.map(t => t.name).join(', ')}`)

const transport = new StdioServerTransport()
server.connect(transport).catch((err) => {
  console.error('[peck-mcp] connection error:', err)
  process.exit(1)
})
