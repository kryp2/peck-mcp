/**
 * Demo runner — starts Gateway + Worker(s) and fires test requests.
 *
 * This shows the full flow:
 *   1. Worker starts (compute node with echo/gemini/ollama backend)
 *   2. Gateway starts (orchestrator)
 *   3. Gateway discovers and registers worker
 *   4. Test requests flow through: caller → gateway → worker → response
 *   5. Payments queue up async in background
 *
 * Usage:
 *   npx ts-node --esm src/demo.ts              # echo backend (free, fast)
 *   GEMINI_API_KEY=xxx npx ts-node --esm src/demo.ts gemini  # real AI
 */

import { PrivateKey } from '@bsv/sdk'
import { Gateway } from './gateway.js'
import { ComputeWorker } from './worker.js'

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main() {
  const backend = (process.argv[2] as 'gemini' | 'ollama' | 'echo') || 'echo'

  console.log('='.repeat(60))
  console.log('  Agentic Pay — Decentralized AI Compute Marketplace')
  console.log('='.repeat(60))
  console.log()

  // --- Create agent wallets ---
  const gatewayKey = PrivateKey.fromRandom()
  const workerKey = PrivateKey.fromRandom()

  // --- Start Worker (Agent B) ---
  const worker = new ComputeWorker({
    name: 'Worker-1',
    key: workerKey,
    port: 3001,
    backend,
    pricePerJob: 2, // 2 satoshis per inference
    geminiApiKey: process.env.GEMINI_API_KEY,
  })
  worker.start()
  await sleep(500)

  // --- Start Gateway (Agent A) ---
  const gateway = new Gateway(gatewayKey, 'https://arc.gorillapool.io')

  // Register worker — in production this happens via BRC-103 discovery
  gateway.registerWorker({
    id: 'worker-1',
    name: 'Worker-1',
    publicKey: workerKey.toPublicKey().toString(),
    address: workerKey.toAddress(),
    endpoint: 'http://localhost:3001',
    pricePerJob: 2,
    avgLatencyMs: 50,
    failCount: 0,
    lastSeen: Date.now(),
  })

  await gateway.start(3000)
  await sleep(500)

  // --- Fire test requests ---
  console.log()
  console.log('--- Sending test requests ---')
  console.log()

  const prompts = [
    'What is Bitcoin?',
    'Translate "hello" to Norwegian',
    'Summarize: AI agents can trade compute power',
    'What is 2+2?',
    'Name three colors',
  ]

  for (const prompt of prompts) {
    try {
      const res = await fetch('http://localhost:3000/infer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      })
      const data = await res.json() as any
      console.log(`  Prompt: "${prompt.slice(0, 40)}..."`)
      console.log(`  Response: "${String(data.response).slice(0, 60)}..."`)
      console.log(`  Worker: ${data.worker} | Price: ${data.price} sat | Proof: ${String(data.proof).slice(0, 16)}...`)
      console.log()
    } catch (err) {
      console.error(`  Error: ${err}`)
    }
  }

  // --- Show stats ---
  await sleep(1000)
  const stats = await fetch('http://localhost:3000/stats').then(r => r.json())
  console.log('--- Gateway Stats ---')
  console.log(JSON.stringify(stats, null, 2))
  console.log()
  console.log(`Dashboard: http://localhost:3000/stats`)
  console.log()
  console.log('Press Ctrl+C to stop')
}

main().catch(console.error)
