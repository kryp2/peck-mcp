import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { PrivateKey } from '@bsv/sdk';
import { Gateway, WorkerInfo } from './gateway.js';

export class MarketplaceMCPServer {
  private server: Server;
  private gateway: Gateway;
  private history: any[] = [];
  
  constructor(gatewayKey?: PrivateKey) {
    const key = gatewayKey || PrivateKey.fromRandom();
    this.gateway = new Gateway(key, 'https://arc.gorillapool.io');
    
    this.server = new Server(
      {
        name: "AgenticPay-Marketplace",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  // Allow registering a worker and notifying MCP clients if needed
  public registerWorker(worker: WorkerInfo) {
    this.gateway.registerWorker(worker);
    // In a real implementation we might send a notification to clients about tool changes
    // using this.server.notification({ method: 'notifications/tools/list_changed' })
    try {
      this.server.notification({ method: 'notifications/tools/list_changed' }).catch(() => {
        // Ignore if no clients connected or other errors
      });
    } catch (e) {
      // Ignore sync errors
    }
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      // Static tools
      const staticTools = [
        {
          name: "marketplace_search",
          description: "Search for available AI services and agents based on capabilities",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Capability or name to search for" },
              maxPrice: { type: "number", description: "Maximum price in satoshis" }
            }
          }
        },
        {
          name: "marketplace_call",
          description: "Call a specific marketplace service by ID (Auto-pays via 402 protocol)",
          inputSchema: {
            type: "object",
            properties: {
              workerId: { type: "string", description: "ID of the worker/service" },
              prompt: { type: "string", description: "The prompt or task for the service" }
            },
            required: ["workerId", "prompt"]
          }
        },
        {
          name: "marketplace_balance",
          description: "Check the current wallet balance of the Gateway orchestrator",
          inputSchema: {
            type: "object",
            properties: {}
          }
        },
        {
          name: "marketplace_history",
          description: "View transaction and job history",
          inputSchema: {
            type: "object",
            properties: {
              limit: { type: "number", description: "Max number of records to return" }
            }
          }
        }
      ];

      // Dynamic tools from registered workers
      // Use any to access private members for hackathon speed
      const workersMap = (this.gateway as any).workers as Map<string, WorkerInfo>;
      const dynamicTools = Array.from(workersMap.values()).map(w => ({
        name: `service_${w.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        description: `Marketplace Service: ${w.name}. Price: ${w.pricePerJob} satoshis. Endpoint: ${w.endpoint}. Auto-402 payment handled by Gateway.`,
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "The task or prompt for the AI agent" }
          },
          required: ["prompt"]
        }
      }));

      return {
        tools: [...staticTools, ...dynamicTools],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        if (name === "marketplace_search") {
          const { query, maxPrice } = args as any;
          const workersMap = (this.gateway as any).workers as Map<string, WorkerInfo>;
          let results = Array.from(workersMap.values());
          
          if (maxPrice) {
            results = results.filter(w => w.pricePerJob <= maxPrice);
          }
          if (query) {
            const q = String(query).toLowerCase();
            results = results.filter(w => w.name.toLowerCase().includes(q) || w.id.toLowerCase().includes(q));
          }
          
          return {
            content: [{ type: "text", text: JSON.stringify(results, null, 2) }]
          };
        } 
        
        else if (name === "marketplace_call") {
          const { workerId, prompt } = args as any;
          const workersMap = (this.gateway as any).workers as Map<string, WorkerInfo>;
          const worker = workersMap.get(workerId);
          
          if (!worker) {
            throw new Error(`Worker ${workerId} not found`);
          }

          // Force the gateway to use this specific worker temporarily if we were modifying it,
          // but Gateway's forwardJob selects the best worker. 
          // Let's implement a specific call:
          const start = Date.now();
          const res = await fetch(worker.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt }),
            signal: AbortSignal.timeout(30000),
          });

          if (!res.ok) throw new Error(`Worker returned ${res.status}`);

          const data = await res.json() as { response: string };
          const latency = Date.now() - start;

          // Hash response
          const crypto = await import('crypto');
          const hashHex = crypto.createHash('sha256').update(data.response).digest('hex');

          // Queue payment inside gateway
          const paymentQueue = (this.gateway as any).paymentQueue;
          paymentQueue.push({
            workerId: worker.id,
            amount: worker.pricePerJob,
            proofHash: hashHex,
            timestamp: Date.now(),
          });

          const stats = (this.gateway as any).stats;
          stats.jobsCompleted++;
          stats.totalPaid += worker.pricePerJob;

          const jobResult = {
            workerId: worker.id,
            request: prompt.slice(0, 100),
            response: data.response,
            responseHash: hashHex,
            latencyMs: latency,
            priceCharged: worker.pricePerJob,
          };

          this.history.push(jobResult);

          return {
            content: [{ type: "text", text: JSON.stringify(jobResult, null, 2) }]
          };
        }
        
        else if (name === "marketplace_balance") {
          // Just return dummy data for hackathon or real if available
          const stats = (this.gateway as any).stats;
          return {
            content: [{ type: "text", text: JSON.stringify({
              address: (this.gateway as any).key.toAddress().toString(),
              jobsCompleted: stats.jobsCompleted,
              totalPaidSatoshis: stats.totalPaid,
              status: "Funded (Simulation)"
            }, null, 2) }]
          };
        }
        
        else if (name === "marketplace_history") {
          const { limit } = args as any || { limit: 10 };
          const recent = this.history.slice(-limit);
          return {
            content: [{ type: "text", text: JSON.stringify(recent, null, 2) }]
          };
        }
        
        else if (name.startsWith("service_")) {
          // Dynamic tool call
          const workerId = name.replace("service_", "");
          // Re-use marketplace_call logic
          const { prompt } = args as any;
          
          const workersMap = (this.gateway as any).workers as Map<string, WorkerInfo>;
          const worker = Array.from(workersMap.values()).find(w => w.id.replace(/[^a-zA-Z0-9_-]/g, '_') === workerId);
          
          if (!worker) {
            throw new Error(`Worker for tool ${name} not found`);
          }

          const start = Date.now();
          const res = await fetch(worker.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt }),
            signal: AbortSignal.timeout(30000),
          });

          if (!res.ok) throw new Error(`Worker returned ${res.status}`);

          const data = await res.json() as { response: string };
          const latency = Date.now() - start;

          const crypto = await import('crypto');
          const hashHex = crypto.createHash('sha256').update(data.response).digest('hex');

          const paymentQueue = (this.gateway as any).paymentQueue;
          paymentQueue.push({
            workerId: worker.id,
            amount: worker.pricePerJob,
            proofHash: hashHex,
            timestamp: Date.now(),
          });

          const stats = (this.gateway as any).stats;
          stats.jobsCompleted++;
          stats.totalPaid += worker.pricePerJob;

          const jobResult = {
            workerId: worker.id,
            request: prompt.slice(0, 100),
            response: data.response,
            responseHash: hashHex,
            latencyMs: latency,
            priceCharged: worker.pricePerJob,
          };

          this.history.push(jobResult);

          return {
            content: [{ type: "text", text: JSON.stringify(jobResult, null, 2) }]
          };
        }
        
        else {
          throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: String(error) }]
        };
      }
    });
  }

  public async start() {
    this.gateway.startPaymentProcessor();
    // Start MCP over stdio
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("[MCP Server] Marketplace MCP Server running on stdio");
    
    // Exit when the transport is closed to prevent dangling processes
    transport.onclose = async () => {
      process.exit(0);
    };
    
    // Fallback: exit when stdin is closed
    process.stdin.on('close', () => {
      process.exit(0);
    });
  }
}

// If run directly, start the server
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new MarketplaceMCPServer();
  
  // Register a dummy worker for testing if run directly
  const dummyWorker: WorkerInfo = {
    id: 'worker-1',
    name: 'Echo-Worker',
    publicKey: PrivateKey.fromRandom().toPublicKey().toString(),
    address: PrivateKey.fromRandom().toAddress().toString(),
    endpoint: process.env.WORKER_ENDPOINT || 'http://localhost:3001/infer', // Expects a worker on 3001
    pricePerJob: 2,
    avgLatencyMs: 50,
    failCount: 0,
    lastSeen: Date.now(),
  };
  server.registerWorker(dummyWorker);

  server.start().catch(console.error);
}
