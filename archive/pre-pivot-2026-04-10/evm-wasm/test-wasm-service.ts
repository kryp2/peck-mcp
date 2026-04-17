/**
 * AP6B smoke test: run WASM modules through the wasm-compute-agent
 * and verify cache hit on second invocation.
 */
import './agents/wasm-compute.js'  // boots ServiceAgent on 3011
import { WASM_ADD, WASM_MUL } from './wasm-runtime.js'

const HEADERS = {
  'Content-Type': 'application/json',
  'X-Payment-Tx': 'demo-bypass',
}

async function call(capability: string, body: any) {
  const r = await fetch(`http://localhost:3011/${capability}`, {
    method: 'POST', headers: HEADERS, body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return await r.json() as any
}

function toB64(u8: Uint8Array): string {
  return Buffer.from(u8).toString('base64')
}

async function main() {
  await new Promise(r => setTimeout(r, 600))
  console.log('=== AP6B — WASM micro-compute agent ===\n')

  // 1) Execute add(2, 3) - first call (compile + run)
  console.log('▶ add(2, 3) — cold (compile + execute)')
  const r1 = await call('execute', {
    wasm_base64: toB64(WASM_ADD),
    function_name: 'add',
    args: [2, 3],
  })
  console.log(`  result: ${r1.result}`)
  console.log(`  module_hash: ${r1.module_hash.slice(0, 16)}…`)
  console.log(`  cache_hit: ${r1.cache_hit}`)
  console.log(`  execution_ms: ${r1.execution_ms}`)

  if (r1.result !== 5) throw new Error(`expected 5, got ${r1.result}`)

  // 2) Execute add(100, 250) - hash known, send only hash (cache hit)
  console.log('\n▶ add(100, 250) — warm (cache hit by hash)')
  const r2 = await call('execute', {
    wasm_hash: r1.module_hash,
    function_name: 'add',
    args: [100, 250],
  })
  console.log(`  result: ${r2.result}`)
  console.log(`  cache_hit: ${r2.cache_hit}`)
  console.log(`  execution_ms: ${r2.execution_ms}`)

  if (r2.result !== 350) throw new Error(`expected 350, got ${r2.result}`)
  if (!r2.cache_hit) throw new Error('expected cache hit on second call')

  // 3) Different module
  console.log('\n▶ mul(7, 6)')
  const r3 = await call('execute', {
    wasm_base64: toB64(WASM_MUL),
    function_name: 'mul',
    args: [7, 6],
  })
  console.log(`  result: ${r3.result}`)
  if (r3.result !== 42) throw new Error(`expected 42, got ${r3.result}`)

  // 4) Cache stats
  const stats = await call('cache-stats', {})
  console.log(`\n▶ cache stats: ${JSON.stringify(stats)}`)

  // 5) Throughput burst
  console.log('\n▶ Burst: 1000 cached add() calls')
  const t0 = Date.now()
  for (let i = 0; i < 1000; i++) {
    await call('execute', {
      wasm_hash: r1.module_hash,
      function_name: 'add',
      args: [i, i],
    })
  }
  const ms = Date.now() - t0
  const tps = 1000 / (ms / 1000)
  console.log(`  ${ms}ms total → ${tps.toFixed(0)} executions/sec via HTTP`)

  console.log('\n=== AP6B SUCCESS — WASM compute marketplace ready ===')
  process.exit(0)
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })
