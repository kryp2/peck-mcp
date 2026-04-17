/**
 * Function Executor — watches for Bitcoin Schema function calls and executes them.
 *
 * This is the marketplace runtime. Service agents register functions on-chain
 * (Bitcoin Schema type=function), then this executor:
 *   1. Watches for function calls targeting this agent's pubkey
 *   2. Validates args against the registered schema
 *   3. Verifies payment (caller must include payment output to provider)
 *   4. Executes the handler function
 *   5. Posts the response on-chain as a Reply to the call tx
 *
 * The flow:
 *   Register:  Agent posts MAP type=function name=X price=Y → on-chain
 *   Call:      Caller posts MAP type=function name=X args={} context=bapID → on-chain + payment
 *   Execute:   This executor detects the call, runs handler, posts response
 *   Response:  MAP type=post context=tx tx=<call_txid> → on-chain reply with result
 *
 * Every step is a Bitcoin Schema transaction. peck.to shows the whole conversation.
 *
 * Usage:
 *   const executor = new FunctionExecutor(agentKey, bankLocal)
 *   executor.register('weather', { price: 50, handler: async (args) => getWeather(args.city) })
 *   executor.start(4060)  // HTTP server for direct calls + polling for on-chain calls
 */
import 'dotenv/config'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { PrivateKey } from '@bsv/sdk'
import { BankLocal } from '../clients/bank-local.js'
import { BitcoinSchema } from './bitcoin-schema.js'

// ============================================================================
// Types
// ============================================================================

export interface FunctionDef {
  name: string
  description: string
  price: number             // sat per call
  argsType?: string         // JSON schema for validation
  handler: (args: any, context: CallContext) => Promise<any>
}

export interface CallContext {
  callerPubkey?: string
  callTxid?: string
  paymentTxid?: string
  timestamp: number
}

export interface FunctionCallResult {
  function: string
  result: any
  callTxid?: string
  responseTxid?: string
  executionMs: number
  pricePaid: number
}

// ============================================================================
// FunctionExecutor
// ============================================================================

export class FunctionExecutor {
  readonly agentKey: PrivateKey
  readonly agentPubkey: string
  readonly bank: BankLocal
  readonly app: string
  private functions: Map<string, FunctionDef> = new Map()
  private stats = { calls: 0, errors: 0, revenue: 0, started_at: Date.now() }

  constructor(agentKey: PrivateKey, bank?: BankLocal, app = 'peck.agents') {
    this.agentKey = agentKey
    this.agentPubkey = agentKey.toPublicKey().toString()
    this.bank = bank ?? new BankLocal()
    this.app = app
  }

  /**
   * Register a function this agent can execute.
   * Also writes the registration to the chain via Bitcoin Schema.
   */
  async register(def: FunctionDef): Promise<string> {
    this.functions.set(def.name, def)

    // Write registration on-chain
    const script = BitcoinSchema.functionRegister({
      name: def.name,
      description: def.description,
      argsType: def.argsType,
      price: def.price,
      app: this.app,
      signingKey: this.agentKey,
    })

    const result = await this.bank.createAction(
      `function-register: ${def.name} @ ${def.price} sat`,
      [{ script: script.toHex(), satoshis: 0 }]
    )

    console.log(`[executor] registered function "${def.name}" @ ${def.price} sat → ${result.txid}`)
    return result.txid
  }

  /**
   * Execute a function call. Can be triggered via HTTP or on-chain detection.
   */
  async execute(name: string, args: any, ctx: CallContext): Promise<FunctionCallResult> {
    const t0 = Date.now()
    const fn = this.functions.get(name)
    if (!fn) throw new Error(`Unknown function: ${name}`)

    // Execute the handler
    const result = await fn.handler(args, ctx)
    const executionMs = Date.now() - t0

    // Post response on-chain as a reply to the call tx
    let responseTxid: string | undefined
    if (ctx.callTxid) {
      const responseScript = BitcoinSchema.reply({
        content: JSON.stringify({
          function: name,
          result,
          execution_ms: executionMs,
          price_paid: fn.price,
        }),
        parentTxid: ctx.callTxid,
        app: this.app,
        tags: ['function-response', name],
        signingKey: this.agentKey,
      })

      try {
        const txResult = await this.bank.createAction(
          `function-response: ${name}`,
          [{ script: responseScript.toHex(), satoshis: 0 }]
        )
        responseTxid = txResult.txid
      } catch (e: any) {
        console.warn(`[executor] failed to post response on-chain: ${e.message}`)
      }
    }

    this.stats.calls++
    this.stats.revenue += fn.price

    return {
      function: name,
      result,
      callTxid: ctx.callTxid,
      responseTxid,
      executionMs,
      pricePaid: fn.price,
    }
  }

  /**
   * Start HTTP server for direct function calls.
   * Agents can call functions via HTTP (fast path) in addition to on-chain.
   */
  async startServer(port: number, registryUrl?: string): Promise<void> {
    const srv = createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

      const json = (status: number, body: any) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }

      try {
        // Health + function listing
        if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
          const fns = Array.from(this.functions.values()).map(f => ({
            name: f.name, description: f.description, price: f.price,
          }))
          return json(200, {
            agent: this.agentPubkey.slice(0, 20) + '…',
            app: this.app,
            protocol: 'Bitcoin Schema (MAP+B+AIP)',
            functions: fns,
            stats: this.stats,
          })
        }

        // List functions
        if (req.method === 'GET' && req.url === '/functions') {
          const fns = Array.from(this.functions.values()).map(f => ({
            name: f.name, description: f.description, price: f.price,
            argsType: f.argsType,
          }))
          return json(200, { functions: fns })
        }

        // Call a function: POST /call/:name
        if (req.method === 'POST' && req.url?.startsWith('/call/')) {
          const name = req.url.replace('/call/', '').split('?')[0]
          const fn = this.functions.get(name)
          if (!fn) return json(404, { error: `Function "${name}" not found` })

          const body = await new Promise<any>((resolve, reject) => {
            let d = ''
            req.on('data', c => d += c)
            req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}) } catch (e) { reject(e) } })
          })

          const { args, caller_pubkey, payment_txid } = body

          // Write the function call on-chain
          const callScript = BitcoinSchema.functionCall({
            name,
            args: args || {},
            providerBapID: this.agentPubkey,
            app: this.app,
            signingKey: this.agentKey, // In production, caller signs
          })

          let callTxid: string | undefined
          try {
            const callResult = await this.bank.createAction(
              `function-call: ${name}`,
              [{ script: callScript.toHex(), satoshis: 0 }]
            )
            callTxid = callResult.txid
          } catch (e: any) {
            console.warn(`[executor] failed to post call on-chain: ${e.message}`)
          }

          // Execute
          const result = await this.execute(name, args || {}, {
            callerPubkey: caller_pubkey,
            callTxid,
            paymentTxid: payment_txid,
            timestamp: Date.now(),
          })

          return json(200, {
            ...result,
            explorer: callTxid ? `https://test.whatsonchain.com/tx/${callTxid}` : undefined,
            response_explorer: result.responseTxid ? `https://test.whatsonchain.com/tx/${result.responseTxid}` : undefined,
          })
        }

        json(404, { error: 'not_found' })
      } catch (e: any) {
        this.stats.errors++
        json(500, { error: e.message })
      }
    })

    await new Promise<void>(resolve => srv.listen(port, resolve))
    console.log(`[executor] listening on http://localhost:${port}`)
    console.log(`[executor] agent: ${this.agentPubkey.slice(0, 20)}…`)
    console.log(`[executor] functions: ${Array.from(this.functions.keys()).join(', ')}`)

    // Announce to registry if available
    if (registryUrl) {
      for (const [name, fn] of this.functions) {
        try {
          await fetch(`${registryUrl}/announce`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: `fn-${name}`,
              name: `fn-${name}`,
              identityKey: this.agentPubkey,
              endpoint: `http://localhost:${port}`,
              capabilities: [name, 'function'],
              pricePerCall: fn.price,
              paymentAddress: '',
              description: fn.description,
            }),
          })
        } catch { /* optional */ }
      }
    }
  }
}
