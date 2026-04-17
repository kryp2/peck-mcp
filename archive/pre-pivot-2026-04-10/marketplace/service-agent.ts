import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { randomUUID, createHash } from 'crypto';
import { metering } from './metering.js';

export interface ServiceAgentOptions {
  name: string;
  description: string;
  pricePerCall: number;
  capabilities: string[];
  /** Real BSV testnet address that receives payments. If omitted, a fake demo identity is used. */
  walletAddress?: string;
  /** Real BSV public key (hex) for BRC-100 capability advert. */
  walletPubkey?: string;
}

export class ServiceAgent {
  private options: ServiceAgentOptions;
  private handlers: Map<string, (req: any) => Promise<any>> = new Map();
  public readonly identity: string;
  public readonly walletAddress: string | undefined;
  public readonly walletPubkey: string | undefined;
  private status: string = 'online';
  private port: number = 0;
  private server: Server | null = null;

  constructor(options: ServiceAgentOptions) {
    this.options = options;
    this.walletAddress = options.walletAddress;
    this.walletPubkey = options.walletPubkey;
    // Use real BSV address as identity if provided, otherwise fake demo identity
    this.identity = options.walletAddress
      || `1Agent${randomUUID().replace(/-/g, '').substring(0, 20)}`;
  }

  public get name(): string { return this.options.name; }
  public get pricePerCall(): number { return this.options.pricePerCall; }
  public get capabilities(): string[] { return this.options.capabilities; }
  public get description(): string { return this.options.description; }
  public get endpoint(): string { return `http://localhost:${this.port}`; }

  public handle(capability: string, handler: (req: any) => Promise<any>) {
    this.handlers.set(capability, handler);
  }

  public updatePrice(newPrice: number) {
    this.options.pricePerCall = newPrice;
    this.publishDiscovery();
  }

  public updateStatus(newStatus: string) {
    this.status = newStatus;
    this.publishDiscovery();
  }

  private publishDiscovery() {
    if (!this.port) return; // Wait until started to publish with endpoint

    // Format: { name, description, price, endpoint, capabilities[], identity }
    const metadata = {
      name: this.options.name,
      description: this.options.description,
      price: this.options.pricePerCall,
      endpoint: `http://localhost:${this.port}`,
      capabilities: this.options.capabilities,
      identity: this.identity,
      status: this.status
    };
    
    console.log(`\n[BRC-103 MessageBox Overlay] Publishing Service Metadata:`);
    console.log(JSON.stringify(metadata, null, 2));
  }

  public start(config: { port: number }) {
    this.port = config.port;
    this.publishDiscovery();

    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const startTime = Date.now();
      const requestId = randomUUID();
      let callerIdentity = req.headers['x-caller-identity'] as string || 'anonymous';
      let amountPaid = 0;

      // Enable CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-payment-tx, x-caller-identity');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Check capability / route
      const capability = (req.url || '/').substring(1);
      const handler = this.handlers.get(capability);

      if (!handler) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Capability '${capability}' not found` }));
        return;
      }

      // 402 Payment Required Check
      const paymentTx = req.headers['x-payment-tx'] as string;
      if (!paymentTx && this.options.pricePerCall > 0) {
        res.writeHead(402, { 
          'Content-Type': 'application/json',
          'X-Price': this.options.pricePerCall.toString(),
          'X-Payment-Address': this.identity
        });
        res.end(JSON.stringify({ 
          error: 'Payment Required', 
          price: this.options.pricePerCall,
          address: this.identity
        }));
        return;
      }

      if (paymentTx) {
        // Trust payment header for demo. In production, verify TX on-chain.
        amountPaid = this.options.pricePerCall;
      }

      // Read Body
      let bodyStr = '';
      for await (const chunk of req) {
        bodyStr += chunk;
      }

      let parsedReq: any = {};
      if (bodyStr) {
        try {
          parsedReq = JSON.parse(bodyStr);
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
          return;
        }
      }

      try {
        const result = await handler(parsedReq);
        const durationMs = Date.now() - startTime;

        const requestHash = createHash('sha256').update(bodyStr).digest('hex');
        const responseHash = createHash('sha256').update(JSON.stringify(result)).digest('hex');

        // Record into the in-process metering engine — this is what
        // the metering-agent /recent endpoint exposes for auditors.
        // The metering-agent itself calls this for its own requests too;
        // that's intentional (full self-accounting).
        if (this.options.name !== 'metering-agent' || capability !== 'recent') {
          metering.record({
            service: this.options.name,
            capability,
            caller: callerIdentity,
            amount_sat: amountPaid,
            request_hash: requestHash,
            response_hash: responseHash,
          });
        }

        console.log(`[REQ] ${this.options.name}/${capability} caller=${callerIdentity.slice(0, 12)} sat=${amountPaid} ms=${durationMs}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Internal Server Error' }));
      }
    });

    this.server.listen(this.port, () => {
      console.log(`[ServiceAgent] ${this.options.name} listening on port ${this.port}\n`);
    });
  }
}
