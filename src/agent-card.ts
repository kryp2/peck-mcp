import * as http from 'http';

export interface AgentCard {
  name: string
  capabilities: string[]
  pricing: Record<string, number>
  endpoint: string
  identity: string // BRC-103 txid or pubkey
  protocols: string[]
}

export class AgentCardManager {
  private card: AgentCard
  private server: http.Server | null = null

  constructor(card: AgentCard) {
    this.card = card
  }

  getCard(): AgentCard {
    return this.card
  }

  // Publishes to MessageBox overlay (A2A discovery network)
  async publishToOverlay(): Promise<void> {
    console.log(`[AgentCard] Publishing card for ${this.card.name} to MessageBox overlay...`)
    // In a real implementation, this broadcasts a transaction or HTTP payload to the overlay network
  }

  // Returns JSON for /.well-known/agent.json endpoint
  getWellKnownJson(): string {
    return JSON.stringify(this.card, null, 2)
  }

  startServer(port: number = 8080): void {
    if (this.server) return;

    this.server = http.createServer((req, res) => {
      // CORS headers for broad discovery
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'GET' && req.url === '/.well-known/agent.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(this.getWellKnownJson());
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    });

    this.server.listen(port, () => {
      console.log(`[AgentCard] HTTP server for ${this.card.name} listening on port ${port} (serving /.well-known/agent.json)`);
    });
  }

  stopServer(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}
