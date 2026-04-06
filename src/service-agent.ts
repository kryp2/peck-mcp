import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { randomUUID, createHash } from 'crypto';

export interface ServiceAgentOptions {
  name: string;
  description: string;
  pricePerCall: number;
  capabilities: string[];
}

export class ServiceAgent {
  private options: ServiceAgentOptions;
  private handlers: Map<string, (req: any) => Promise<any>> = new Map();
  private identity: string;
  private status: string = 'online';
  private port: number = 0;
  private server: Server | null = null;

  constructor(options: ServiceAgentOptions) {
    this.options = options;
    // Generate a simulated BRC-103 Identity for demo purposes
    this.identity = `1Agent${randomUUID().replace(/-/g, '').substring(0, 20)}`;
  }

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
        
        // Logging
        console.log(`[REQ] request_id=${requestId.substring(0, 8)} caller_identity=${callerIdentity} ` +
                    `amount_paid=${amountPaid} duration_ms=${durationMs}`);

        // On-chain receipt: OP_RETURN med service_id + request_hash
        const requestHash = createHash('sha256').update(bodyStr).digest('hex');
        console.log(`[OP_RETURN] Logging receipt -> service_id:${this.options.name} request_hash:${requestHash}`);

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
