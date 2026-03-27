/**
 * Agent B — Compute Worker
 *
 * Runs AI inference tasks and gets paid per job via BSV micropayments.
 * Monitors Arcade SSE stream to verify payments from Gateway.
 * Circuit breaker: stops accepting work if Gateway doesn't pay.
 *
 * Backend options:
 *   - Gemini API (cheapest, good for demo)
 *   - Ollama (local, truly decentralized)
 *   - OpenAI / Claude (expensive, high quality)
 */

import { PrivateKey } from '@bsv/sdk'
import { createServer, IncomingMessage, ServerResponse } from 'http'

// --- Types ---

type BackendType = 'gemini' | 'ollama' | 'echo'

interface WorkerConfig {
  name: string
  key: PrivateKey
  port: number
  backend: BackendType
  pricePerJob: number     // satoshis we charge
  geminiApiKey?: string
  ollamaUrl?: string
}

// --- AI Backends ---

async function inferGemini(prompt: string, apiKey: string): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 100 },
      }),
    }
  )
  const data = await res.json() as any
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? 'no response'
}

async function inferOllama(prompt: string, url: string): Promise<string> {
  const res = await fetch(`${url}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'llama3.2:1b', prompt, stream: false }),
  })
  const data = await res.json() as any
  return data?.response ?? 'no response'
}

function inferEcho(prompt: string): string {
  // Free "AI" for testing — just echoes back with a twist
  return `[echo] ${prompt.slice(0, 200)} | ts=${Date.now()}`
}

// --- Compute Worker ---

class ComputeWorker {
  private config: WorkerConfig
  private stats = {
    jobsCompleted: 0,
    totalEarned: 0,
    unpaidJobs: 0,
    gatewayTrusted: true,
  }

  constructor(config: WorkerConfig) {
    this.config = config
  }

  /**
   * Run inference using configured backend
   */
  async infer(prompt: string): Promise<string> {
    switch (this.config.backend) {
      case 'gemini':
        if (!this.config.geminiApiKey) throw new Error('GEMINI_API_KEY required')
        return inferGemini(prompt, this.config.geminiApiKey)
      case 'ollama':
        return inferOllama(prompt, this.config.ollamaUrl || 'http://localhost:11434')
      case 'echo':
        return inferEcho(prompt)
    }
  }

  /**
   * Monitor Arcade SSE for payment confirmations from Gateway
   *
   * TODO: Implement actual SSE listener when Arcade is live
   * For now this is a placeholder that tracks expected payments
   */
  async monitorPayments(): Promise<void> {
    // TODO: Connect to Arcade SSE endpoint
    // const eventSource = new EventSource(`${arcadeUrl}/v1/tx/stream?address=${address}`)
    // eventSource.onmessage = (event) => {
    //   const tx = JSON.parse(event.data)
    //   if (tx.status === 'MINED') {
    //     this.stats.unpaidJobs--
    //     this.stats.totalEarned += tx.amount
    //   }
    // }

    // Circuit breaker check every 10 seconds
    setInterval(() => {
      if (this.stats.unpaidJobs > 50) {
        console.log(`[${this.config.name}] Circuit breaker! ${this.stats.unpaidJobs} unpaid jobs. Blocking gateway.`)
        this.stats.gatewayTrusted = false
      }
    }, 10000)
  }

  /**
   * Start HTTP server that accepts inference requests from Gateway
   */
  start(): void {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.writeHead(200)
        res.end()
        return
      }

      // Health check
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          name: this.config.name,
          address: this.config.key.toAddress(),
          price: this.config.pricePerJob,
          backend: this.config.backend,
          ...this.stats,
        }))
        return
      }

      // Inference endpoint
      if (req.method === 'POST') {
        // Circuit breaker — refuse work if not being paid
        if (!this.stats.gatewayTrusted) {
          res.writeHead(402, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'payment required — gateway untrusted' }))
          return
        }

        let body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', async () => {
          try {
            const { prompt } = JSON.parse(body)
            const response = await this.infer(prompt)

            this.stats.jobsCompleted++
            this.stats.unpaidJobs++ // Will be decremented when payment confirmed via SSE

            if (this.stats.jobsCompleted % 100 === 0) {
              console.log(`[${this.config.name}] Job #${this.stats.jobsCompleted} | Earned: ${this.stats.totalEarned} sat | Unpaid: ${this.stats.unpaidJobs}`)
            }

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ response }))
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: String(err) }))
          }
        })
        return
      }

      res.writeHead(404)
      res.end()
    })

    server.listen(this.config.port, () => {
      console.log(`[${this.config.name}] Compute worker on http://localhost:${this.config.port}`)
      console.log(`[${this.config.name}] Backend: ${this.config.backend}`)
      console.log(`[${this.config.name}] Price: ${this.config.pricePerJob} sat/job`)
      console.log(`[${this.config.name}] Address: ${this.config.key.toAddress()}`)
    })

    this.monitorPayments()
  }
}

export { ComputeWorker, WorkerConfig }
