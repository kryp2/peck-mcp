/**
 * BRC-100 Service Agent.
 *
 * A service-agent that:
 *   - Has its own BRC-100 wallet (loaded via peckpay-wallet factory)
 *   - Implements the BRC-29 P2P payment protocol over HTTP 402
 *   - Verifies incoming payments OFFLINE via wallet.internalizeAction(BEEF)
 *   - Executes the requested capability and returns the result
 *
 * Wire flow:
 *
 *   Client → POST /<capability>     body=<json>
 *   Server → 402 Payment Required
 *      headers: X-BSV-Price, X-BSV-Identity, X-BSV-Derivation-Prefix, X-BSV-Derivation-Suffix
 *      body: { error, price, identityKey, derivationPrefix, derivationSuffix }
 *
 *   Client → wallet.createAction({outputs:[{lockingScript: P2PKH(derived), satoshis: price}]})
 *   Client → POST /<capability>     body=<json>
 *      headers: X-BSV-Payment-Beef (base64 BEEF)
 *               X-BSV-Derivation-Prefix
 *               X-BSV-Derivation-Suffix
 *               X-BSV-Sender-Identity
 *
 *   Server → wallet.internalizeAction({tx: BEEF, outputs:[{outputIndex:0, protocol:'wallet payment',
 *               paymentRemittance:{prefix, suffix, senderIdentityKey}}]})
 *   Server → execute capability handler
 *   Server → 200 OK with result
 */
import { createServer, IncomingMessage, ServerResponse, Server } from 'http'
import { randomUUID, createHash } from 'crypto'
import { Random, Utils } from '@bsv/sdk'
import { metering } from './metering.js'
import { getWallet } from './peckpay-wallet.js'
import type { SetupWalletKnex } from '@bsv/wallet-toolbox'

export interface BrcServiceAgentOptions {
  /** Logical name (e.g. "weather-agent") */
  name: string
  /** Wallet identity name in .brc-identities.json (e.g. "weather") */
  walletName: string
  description: string
  pricePerCall: number
  capabilities: string[]
  port: number
}

interface PendingPayment {
  derivationPrefix: string
  derivationSuffix: string
  capability: string
  ts: number
}

const PAYMENT_TTL_MS = 5 * 60 * 1000  // 5 minutes

export class BrcServiceAgent {
  // Process-wide registry URL — all agents POST announce + events here
  private static registryUrl: string | null = null
  static setRegistryUrl(url: string | null): void { BrcServiceAgent.registryUrl = url }

  private options: BrcServiceAgentOptions
  private handlers: Map<string, (req: any) => Promise<any>> = new Map()
  private setup: SetupWalletKnex | null = null
  private server: Server | null = null
  private status: string = 'online'

  // Track derivations we've issued so we can validate echoed values
  private pendingPayments: Map<string, PendingPayment> = new Map()

  constructor(options: BrcServiceAgentOptions) {
    this.options = options
  }

  get name(): string { return this.options.name }
  get walletName(): string { return this.options.walletName }
  get pricePerCall(): number { return this.options.pricePerCall }
  get capabilities(): string[] { return this.options.capabilities }
  get description(): string { return this.options.description }
  get port(): number { return this.options.port }
  get endpoint(): string { return `http://localhost:${this.options.port}` }
  get identityKey(): string { return this.setup?.identityKey || '' }

  handle(capability: string, handler: (req: any) => Promise<any>): void {
    this.handlers.set(capability, handler)
  }

  async start(): Promise<void> {
    // Lazy-load the BRC wallet (one per process; reused across calls)
    this.setup = await getWallet(this.options.walletName)

    this.server = createServer((req, res) => this.handleRequest(req, res))
    await new Promise<void>((resolve) => {
      this.server!.listen(this.options.port, () => {
        console.log(`[${this.name}] BRC-100 service on :${this.options.port}  identity=${this.identityKey.slice(0, 18)}…`)
        resolve()
      })
    })

    // Auto-announce to registry if configured
    if (BrcServiceAgent.registryUrl) {
      try {
        await fetch(`${BrcServiceAgent.registryUrl}/announce`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: this.options.walletName,
            name: this.options.name,
            identityKey: this.identityKey,
            endpoint: this.endpoint,
            capabilities: this.capabilities,
            pricePerCall: this.pricePerCall,
            description: this.description,
          }),
        })
      } catch (e) {
        console.warn(`[${this.name}] failed to announce to registry: ${e}`)
      }
    }
  }

  private async reportEvent(event: any): Promise<void> {
    if (!BrcServiceAgent.registryUrl) return
    try {
      await fetch(`${BrcServiceAgent.registryUrl}/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...event, ts: Date.now() }),
      })
    } catch { /* ignore */ }
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>(r => this.server!.close(() => r()))
  }

  private gcPending(): void {
    const now = Date.now()
    for (const [k, v] of this.pendingPayments) {
      if (now - v.ts > PAYMENT_TTL_MS) this.pendingPayments.delete(k)
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startTime = Date.now()

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-BSV-Payment-Beef, X-BSV-Derivation-Prefix, X-BSV-Derivation-Suffix, X-BSV-Sender-Identity')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    // Healthcheck / catalog
    if (req.method === 'GET' && req.url === '/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        name: this.name,
        identityKey: this.identityKey,
        pricePerCall: this.pricePerCall,
        capabilities: this.capabilities,
        description: this.description,
        status: this.status,
      }))
      return
    }

    const capability = (req.url || '/').replace(/^\//, '').split('?')[0]
    const handler = this.handlers.get(capability)
    if (!handler) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `unknown capability: ${capability}` }))
      return
    }

    // Read body once
    let bodyStr = ''
    for await (const chunk of req) bodyStr += chunk
    let parsedReq: any = {}
    if (bodyStr) {
      try { parsedReq = JSON.parse(bodyStr) }
      catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"invalid JSON"}'); return }
    }

    // Payment metadata is sent in the request body under `_payment` (BEEF
    // can be 5–50 KB which exceeds HTTP header limits). The actual call
    // arguments live under `_args`.
    const payment = parsedReq?._payment as undefined | {
      beef: string             // base64 atomic BEEF
      txid: string             // payment txid (echoed for telemetry)
      derivationPrefix: string
      derivationSuffix: string
      senderIdentityKey: string
    }
    const callArgs = parsedReq?._args ?? parsedReq  // fallback for clients that don't wrap

    const beefHeader = payment?.beef
    const senderIdentity = payment?.senderIdentityKey
    const echoedPrefix = payment?.derivationPrefix
    const echoedSuffix = payment?.derivationSuffix
    const paymentTxid = payment?.txid

    // === Step 1: no BEEF → respond 402 with fresh derivation ===
    if (!beefHeader) {
      this.gcPending()
      const derivationPrefix = Utils.toBase64(Random(8))
      const derivationSuffix = Utils.toBase64(Random(8))
      const sessionKey = `${derivationPrefix}:${derivationSuffix}`
      this.pendingPayments.set(sessionKey, {
        derivationPrefix, derivationSuffix, capability, ts: Date.now(),
      })

      const payload = {
        error: 'Payment Required',
        price: this.pricePerCall,
        currency: 'satoshis',
        protocol: 'BRC-29',
        identityKey: this.identityKey,
        derivationPrefix,
        derivationSuffix,
        retryWith: {
          headers: {
            'X-BSV-Payment-Beef': '<base64 atomic BEEF from createAction>',
            'X-BSV-Derivation-Prefix': derivationPrefix,
            'X-BSV-Derivation-Suffix': derivationSuffix,
            'X-BSV-Sender-Identity': '<your wallet identityKey>',
          },
        },
      }

      res.writeHead(402, {
        'Content-Type': 'application/json',
        'X-BSV-Price': this.pricePerCall.toString(),
        'X-BSV-Identity': this.identityKey,
        'X-BSV-Derivation-Prefix': derivationPrefix,
        'X-BSV-Derivation-Suffix': derivationSuffix,
        'X-BSV-Protocol': 'BRC-29',
      })
      res.end(JSON.stringify(payload))
      return
    }

    // === Step 2: have BEEF → validate + internalize + execute ===
    if (!echoedPrefix || !echoedSuffix || !senderIdentity) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'X-BSV-Derivation-Prefix, X-BSV-Derivation-Suffix, X-BSV-Sender-Identity required when X-BSV-Payment-Beef is present' }))
      return
    }

    const sessionKey = `${echoedPrefix}:${echoedSuffix}`
    const session = this.pendingPayments.get(sessionKey)
    if (!session) {
      res.writeHead(409, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unknown or expired payment session — request a fresh 402 first' }))
      return
    }
    if (session.capability !== capability) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `Payment session was issued for capability "${session.capability}", not "${capability}"` }))
      return
    }

    // Decode BEEF and internalize
    let beefBytes: number[]
    try { beefBytes = Utils.toArray(beefHeader, 'base64') }
    catch { res.writeHead(400); res.end('{"error":"BEEF base64 decode failed"}'); return }

    try {
      const result = await this.setup!.wallet.internalizeAction({
        tx: beefBytes,
        outputs: [{
          outputIndex: 0,
          protocol: 'wallet payment',
          paymentRemittance: {
            derivationPrefix: session.derivationPrefix,
            derivationSuffix: session.derivationSuffix,
            senderIdentityKey: senderIdentity,
          },
        }],
        description: `Pay for ${capability}`.slice(0, 50),
        seekPermission: false,
      })
      if (!result.accepted) {
        res.writeHead(402); res.end('{"error":"internalizeAction did not accept BEEF"}'); return
      }
    } catch (e: any) {
      res.writeHead(402, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Payment verification failed', detail: String(e.message || e).slice(0, 200) }))
      return
    }

    // Consume the session — single-use
    this.pendingPayments.delete(sessionKey)

    // Execute capability — pass only the user args (not the payment envelope)
    try {
      const result = await handler(callArgs)
      const durationMs = Date.now() - startTime
      const requestHash = createHash('sha256').update(bodyStr).digest('hex')
      const responseHash = createHash('sha256').update(JSON.stringify(result)).digest('hex')

      // Record metering
      if (this.name !== 'metering-agent' || capability !== 'recent') {
        metering.record({
          service: this.name,
          capability,
          caller: senderIdentity,
          amount_sat: this.pricePerCall,
          request_hash: requestHash,
          response_hash: responseHash,
        })
      }

      console.log(`[${this.name}/${capability}] payer=${senderIdentity.slice(0, 16)}… ${this.pricePerCall} sat ${durationMs}ms`)

      // Fire-and-forget report to registry — txid was echoed by client
      this.reportEvent({
        type: 'paid',
        service: this.options.walletName,
        capability,
        payer: senderIdentity,
        amount: this.pricePerCall,
        ms: durationMs,
        txid: paymentTxid,
      }).catch(() => {})

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: e.message || 'Service handler failed' }))
    }
  }
}
