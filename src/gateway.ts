/**
 * Agent A — Gateway / Orchestrator
 *
 * Receives AI inference requests, selects the best compute worker,
 * forwards the job, and pays the worker asynchronously via BSV.
 *
 * Architecture: "Serve First, Settle Later"
 *   1. Receive request
 *   2. Select cheapest/fastest worker from registry
 *   3. Forward job to worker → get result immediately
 *   4. Return result to caller
 *   5. Background: sign TX, pay worker, log proof-of-compute
 *
 * The gateway NEVER blocks on TX signing. Payment happens async.
 */

import { PrivateKey, Transaction, P2PKH, ARC, Hash } from '@bsv/sdk'
import { createServer, IncomingMessage, ServerResponse } from 'http'

// --- Types ---

interface WorkerInfo {
  id: string
  name: string
  publicKey: string
  address: string
  endpoint: string        // HTTP endpoint for compute
  pricePerJob: number     // satoshis
  avgLatencyMs: number
  failCount: number
  lastSeen: number
}

interface JobResult {
  workerId: string
  request: string
  response: string
  responseHash: string    // SHA-256 of response — goes into OP_RETURN
  latencyMs: number
  priceCharged: number
}

interface PendingPayment {
  workerId: string
  amount: number
  proofHash: string       // proof-of-compute hash
  timestamp: number
}

// --- Gateway Agent ---

class Gateway {
  private key: PrivateKey
  private workers: Map<string, WorkerInfo> = new Map()
  private paymentQueue: PendingPayment[] = []
  private stats = { jobsCompleted: 0, totalPaid: 0, txBroadcast: 0 }
  private arcEndpoint: string

  constructor(key: PrivateKey, arcEndpoint: string) {
    this.key = key
    this.arcEndpoint = arcEndpoint
  }

  /**
   * Register a compute worker
   */
  registerWorker(worker: WorkerInfo): void {
    this.workers.set(worker.id, worker)
    console.log(`[Gateway] Worker registered: ${worker.name} @ ${worker.pricePerJob} sat/job`)
  }

  /**
   * Select best worker based on price and reliability
   */
  selectWorker(): WorkerInfo | null {
    let best: WorkerInfo | null = null
    let bestScore = Infinity

    for (const w of this.workers.values()) {
      // Skip workers that have failed too much
      if (w.failCount > 10) continue
      // Score: lower is better (price + latency penalty)
      const score = w.pricePerJob + (w.avgLatencyMs / 100)
      if (score < bestScore) {
        bestScore = score
        best = w
      }
    }
    return best
  }

  /**
   * Forward a job to a compute worker
   */
  async forwardJob(prompt: string): Promise<JobResult | null> {
    const worker = this.selectWorker()
    if (!worker) {
      console.log('[Gateway] No workers available')
      return null
    }

    const start = Date.now()

    try {
      const res = await fetch(worker.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
        signal: AbortSignal.timeout(30000),
      })

      if (!res.ok) throw new Error(`Worker returned ${res.status}`)

      const data = await res.json() as { response: string }
      const latency = Date.now() - start

      // Update worker stats
      worker.avgLatencyMs = (worker.avgLatencyMs * 0.9) + (latency * 0.1)
      worker.lastSeen = Date.now()

      // Hash the response — this is our proof-of-compute
      const responseHash = Hash.sha256(
        Array.from(new TextEncoder().encode(data.response))
      )
      const hashHex = Array.from(responseHash).map(b => b.toString(16).padStart(2, '0')).join('')

      const result: JobResult = {
        workerId: worker.id,
        request: prompt.slice(0, 100),
        response: data.response,
        responseHash: hashHex,
        latencyMs: latency,
        priceCharged: worker.pricePerJob,
      }

      // Queue async payment — DO NOT BLOCK
      this.paymentQueue.push({
        workerId: worker.id,
        amount: worker.pricePerJob,
        proofHash: hashHex,
        timestamp: Date.now(),
      })

      this.stats.jobsCompleted++
      this.stats.totalPaid += worker.pricePerJob

      return result

    } catch (err) {
      worker.failCount++
      console.log(`[Gateway] Worker ${worker.name} failed: ${err}`)
      // Circuit breaker: if too many fails, worker gets dropped
      if (worker.failCount > 10) {
        console.log(`[Gateway] Circuit breaker: dropping ${worker.name}`)
      }
      return null
    }
  }

  /**
   * Background payment processor — runs async, never blocks the hot path
   *
   * This is where TX signing happens (176ms in TS, but we don't care
   * because the user already got their response).
   *
   * TODO: Implement actual UTXO management and TX building
   * For hackathon, we need to:
   *   1. Track UTXOs from our funded wallet
   *   2. Build TX: payment to worker + OP_RETURN with proof hash
   *   3. Sign and broadcast via Arcade
   *   4. Listen for confirmation via SSE
   */
  async processPayments(): Promise<void> {
    while (this.paymentQueue.length > 0) {
      const payment = this.paymentQueue.shift()!

      try {
        // TODO: Build real transaction here
        // const tx = new Transaction()
        // tx.addOutput({ lockingScript: P2PKH.lock(workerAddress), satoshis: payment.amount })
        // tx.addOutput({ lockingScript: Script.buildDataOut(payment.proofHash), satoshis: 0 })
        // await tx.sign()
        // await tx.broadcast(new ARC(this.arcEndpoint))

        this.stats.txBroadcast++

        if (this.stats.txBroadcast % 1000 === 0) {
          console.log(`[Gateway] TX #${this.stats.txBroadcast} | Jobs: ${this.stats.jobsCompleted} | Paid: ${this.stats.totalPaid} sat`)
        }
      } catch (err) {
        console.error(`[Gateway] Payment failed for worker ${payment.workerId}: ${err}`)
        // Re-queue failed payment
        this.paymentQueue.push(payment)
      }
    }
  }

  /**
   * Start background payment loop
   */
  startPaymentProcessor(): void {
    setInterval(() => this.processPayments(), 50) // Process queue every 50ms
    console.log('[Gateway] Background payment processor started')
  }

  /**
   * Start HTTP API server
   */
  startServer(port: number): void {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      // CORS
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

      if (req.method === 'OPTIONS') {
        res.writeHead(200)
        res.end()
        return
      }

      // GET /stats — dashboard data
      if (req.method === 'GET' && req.url === '/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          ...this.stats,
          workers: Array.from(this.workers.values()).map(w => ({
            id: w.id, name: w.name, price: w.pricePerJob,
            latency: Math.round(w.avgLatencyMs), fails: w.failCount,
          })),
          paymentQueueSize: this.paymentQueue.length,
          gatewayAddress: this.key.toAddress(),
        }))
        return
      }

      // POST /infer — submit AI job
      if (req.method === 'POST' && req.url === '/infer') {
        let body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', async () => {
          try {
            const { prompt } = JSON.parse(body)
            if (!prompt) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'prompt required' }))
              return
            }

            const result = await this.forwardJob(prompt)
            if (!result) {
              res.writeHead(503, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'no workers available' }))
              return
            }

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              response: result.response,
              proof: result.responseHash,
              worker: result.workerId,
              price: result.priceCharged,
              latency: result.latencyMs,
              jobNumber: this.stats.jobsCompleted,
            }))
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: String(err) }))
          }
        })
        return
      }

      res.writeHead(404)
      res.end('Not found')
    })

    server.listen(port, () => {
      console.log(`[Gateway] API server on http://localhost:${port}`)
      console.log(`[Gateway] POST /infer  — submit AI job`)
      console.log(`[Gateway] GET  /stats  — dashboard data`)
    })
  }

  /**
   * Boot the gateway
   */
  async start(port = 3000): Promise<void> {
    console.log(`[Gateway] Address: ${this.key.toAddress()}`)
    console.log(`[Gateway] Workers: ${this.workers.size}`)

    this.startPaymentProcessor()
    this.startServer(port)
  }
}

export { Gateway, WorkerInfo, JobResult }
