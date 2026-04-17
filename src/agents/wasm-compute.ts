/**
 * WASM micro-compute agent.
 *
 * Pay per execution to run user-supplied WebAssembly modules in a
 * sandboxed Node.js runtime. Hash-based module cache — repeat
 * invocations skip compilation.
 *
 * Use cases:
 *   - Agents offload tight loops (hashing, parsing, math) without
 *     paying for cloud functions / cold starts.
 *   - Deterministic compute proofs: same wasm + args → same output.
 *
 * Pricing: 10 sat per execution (under $0.0001).
 */
import { BrcServiceAgent } from '../brc-service-agent.js'
import { executeWasm, getCacheStats } from '../wasm-runtime.js'

const agent = new BrcServiceAgent({
  name: 'wasm-compute-agent',
  walletName: 'wasm-compute',
  description: 'Sandboxed WASM execution; pay per call (~$0.000007)',
  pricePerCall: 10,
  capabilities: ['execute', 'cache-stats'],
  port: 3011,
})

agent.handle('execute', async (req) => {
  const receipt = await executeWasm({
    wasmBase64: req.wasm_base64,
    wasmHash: req.wasm_hash,
    functionName: req.function_name,
    args: req.args,
    timeoutMs: req.timeout_ms,
  })
  return receipt
})

agent.handle('cache-stats', async () => {
  return getCacheStats()
})

agent.start()
