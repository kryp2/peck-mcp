import * as http from 'http';
import { URL } from 'url';
import { PrivateKey, Transaction } from '@bsv/sdk';

export interface ReputationData {
  tasks_completed: number;
  tasks_failed: number;
  avg_response_ms: number;
  total_earned_satoshis: number;
  dispute_rate: number; // 0.0 - 1.0
  last_active: number; // timestamp
  _disputes: number; // internal tracking
}

export interface TrustScore {
  score: number; // 0-100
  breakdown: Omit<ReputationData, '_disputes'>;
}

export interface ContractEvent {
  agentId: string;
  type: 'completion' | 'dispute' | 'failure';
  response_ms?: number;
  earned_satoshis?: number;
}

export class ReputationScorer {
  private store: Map<string, ReputationData> = new Map();
  private eventCount = 0;
  
  constructor(
    private anchorKey?: PrivateKey,
    private onAnchored?: (snapshot: Record<string, Omit<ReputationData, '_disputes'>>) => void
  ) {}

  public async processEvent(event: ContractEvent) {
    let data = this.store.get(event.agentId);
    if (!data) {
      data = {
        tasks_completed: 0,
        tasks_failed: 0,
        avg_response_ms: 0,
        total_earned_satoshis: 0,
        dispute_rate: 0,
        last_active: Date.now(),
        _disputes: 0,
      };
      this.store.set(event.agentId, data);
    }

    data.last_active = Date.now();

    if (event.type === 'completion') {
      data.tasks_completed++;
      if (event.response_ms) {
        data.avg_response_ms = ((data.avg_response_ms * (data.tasks_completed - 1)) + event.response_ms) / data.tasks_completed;
      }
      if (event.earned_satoshis) {
        data.total_earned_satoshis += event.earned_satoshis;
      }
    } else if (event.type === 'failure') {
      data.tasks_failed++;
    } else if (event.type === 'dispute') {
      data._disputes++;
    }

    // Recalculate dispute rate
    const totalEngagements = data.tasks_completed + data.tasks_failed + data._disputes;
    if (totalEngagements > 0) {
      data.dispute_rate = data._disputes / totalEngagements;
    }

    this.eventCount++;
    if (this.eventCount % 100 === 0) {
      const snapshot: Record<string, Omit<ReputationData, '_disputes'>> = {};
      for (const [key, val] of this.store.entries()) {
        const { _disputes, ...rest } = val;
        snapshot[key] = rest;
      }
      
      // On-chain anchoring: Periodisk (hvert 100. event): anchor snapshot til BSV
      if (this.anchorKey) {
        const tx = new Transaction();
        const payload = JSON.stringify({ ap_reputation_snapshot: snapshot });
        // In a real implementation we would add an OP_RETURN output here and broadcast
        // For example: Script.fromASM(`OP_FALSE OP_RETURN ${Buffer.from(payload).toString('hex')}`)
        console.log(`[ReputationScorer] Anchoring snapshot to BSV with OP_RETURN payload (${payload.length} bytes)`);
      }

      if (this.onAnchored) {
        this.onAnchored(snapshot);
      }
    }
  }

  /**
   * Calculates the trust score for a given agent.
   * New agents start with a score of 50.
   */
  public getTrustScore(agentId: string): TrustScore {
    const data = this.store.get(agentId) || {
      tasks_completed: 0,
      tasks_failed: 0,
      avg_response_ms: 0,
      total_earned_satoshis: 0,
      dispute_rate: 0,
      last_active: 0,
      _disputes: 0
    };

    let score = 50; // New agents start at 50
    
    if (data.tasks_completed > 0) {
      // Up to +30 for completions (diminishing returns)
      score += 30 * (1 - 1 / (Math.log10(data.tasks_completed + 1) + 1));
    }

    if (data.tasks_failed > 0) {
      const failureRate = data.tasks_failed / (data.tasks_completed + data.tasks_failed);
      score -= failureRate * 50; 
    }

    if (data.dispute_rate > 0) {
      score -= data.dispute_rate * 50;
    }

    if (data.avg_response_ms > 1000) {
      score -= Math.min(20, (data.avg_response_ms - 1000) / 100);
    }

    // Ensure within 0-100 bounds
    score = Math.max(0, Math.min(100, Math.round(score)));

    const { _disputes, ...breakdown } = data;
    return { score, breakdown };
  }

  // Helper to parse from OP_RETURN hex
  public parseOpReturnEvent(hexData: string): ContractEvent | null {
    try {
      const jsonString = Buffer.from(hexData, 'hex').toString('utf8');
      const parsed = JSON.parse(jsonString);
      if (parsed.ap_event) {
         return parsed.ap_event as ContractEvent;
      }
      return null;
    } catch(e) {
      return null;
    }
  }

  // Listen to BSV transactions via ARCADE SSE
  public async listenToArcade(arcadeUrl: string, address: string) {
    console.log(`[ReputationScorer] Connecting to Arcade SSE at ${arcadeUrl} for ${address}...`);
    // Note: In a real environment, this would use EventSource to listen to the ARCADE SSE stream
    return Promise.resolve();
  }
}

export class ReputationAPI {
  private server: http.Server;

  constructor(private scorer: ReputationScorer, private port: number = 3000) {
    this.server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Payment-Tx');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Check payment header (5 satoshis required)
      const paymentTx = req.headers['x-payment-tx'];
      if (!paymentTx) {
        res.writeHead(402, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payment Required', cost: '5 satoshis' }));
        return;
      }

      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      if (req.method === 'GET' && url.pathname.startsWith('/reputation/')) {
        const agentId = url.pathname.split('/')[2];
        if (agentId && agentId !== 'batch') {
          const score = this.scorer.getTrustScore(agentId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(score));
          return;
        }
      }

      if (req.method === 'POST' && url.pathname === '/reputation/batch') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
          try {
            const { agentIds } = JSON.parse(body);
            if (!Array.isArray(agentIds)) {
              throw new Error('agentIds must be an array');
            }
            const results = agentIds.map(id => ({ agentId: id, ...this.scorer.getTrustScore(id) }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ results }));
          } catch(e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request body' }));
          }
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    });
  }

  public start() {
    this.server.listen(this.port, () => {
      console.log(`Reputation API listening on port ${this.port}`);
    });
  }

  public stop() {
    return new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }
}
