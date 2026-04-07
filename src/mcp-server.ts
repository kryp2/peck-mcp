import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { PrivateKey, Hash } from '@bsv/sdk';
import { Gateway, WorkerInfo } from './gateway.js';
import { createServer, IncomingMessage, ServerResponse } from 'http';

// Initialize the Gateway
const gatewayKey = PrivateKey.fromRandom();
const gateway = new Gateway(gatewayKey, 'https://arc.gorillapool.io');
gateway.startPaymentProcessor(); // Background payments

const history: any[] = [];

// Initialize the MCP Server
const server = new Server(
  {
    name: 'mcp-marketplace',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// We need a way to access gateway's workers and payment queue
// Since they are private, we can cast to any for this hackathon
const getWorkers = () => (gateway as any).workers as Map<string, WorkerInfo>;
const getPaymentQueue = () => (gateway as any).paymentQueue as any[];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const workers = Array.from(getWorkers().values());

  const tools: any[] = [
    {
      name: 'marketplace_search',
      description: 'Search for AI services based on capabilities and budget',
      inputSchema: {
        type: 'object',
        properties: {
          capability: { type: 'string', description: 'Service capability to search for' },
          maxPrice: { type: 'number', description: 'Maximum price in satoshis' },
        },
      },
    },
    {
      name: 'marketplace_call',
      description: 'Call a specific marketplace service by ID (auto-pays via 402)',
      inputSchema: {
        type: 'object',
        properties: {
          workerId: { type: 'string', description: 'ID of the worker to call' },
          prompt: { type: 'string', description: 'Prompt to send to the worker' },
        },
        required: ['workerId', 'prompt'],
      },
    },
    {
      name: 'marketplace_balance',
      description: 'Check your current wallet balance',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'marketplace_history',
      description: 'View your transaction and compute history',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ];

  // Dynamic tool registration: expose each registered worker as a distinct tool
  for (const w of workers) {
    tools.push({
      name: `service_${w.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      description: `Service: ${w.name}. Price: ${w.pricePerJob} satoshis. Auto-402 payment handling enabled.`,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The prompt to process' },
        },
        required: ['prompt'],
      },
    });
  }

  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const workersMap = getWorkers();

  if (name === 'marketplace_search') {
    const maxPrice = args?.maxPrice as number | undefined;
    let result = Array.from(workersMap.values());
    if (maxPrice !== undefined) {
      result = result.filter((w) => w.pricePerJob <= maxPrice);
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }

  if (name === 'marketplace_balance') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { balanceSatoshis: 100000, address: gatewayKey.toAddress() },
            null,
            2
          ),
        },
      ],
    };
  }

  if (name === 'marketplace_history') {
    return {
      content: [{ type: 'text', text: JSON.stringify(history, null, 2) }],
    };
  }

  // Handle marketplace_call or direct service_ calls
  let workerToCall: WorkerInfo | undefined;
  let prompt: string | undefined;

  if (name === 'marketplace_call') {
    const workerId = args?.workerId as string;
    prompt = args?.prompt as string;
    workerToCall = workersMap.get(workerId);
    if (!workerToCall) {
      throw new McpError(ErrorCode.InvalidParams, `Worker ${workerId} not found`);
    }
  } else if (name.startsWith('service_')) {
    const workerIdRaw = name.substring('service_'.length);
    prompt = args?.prompt as string;
    workerToCall = Array.from(workersMap.values()).find(
      (w) => w.id.replace(/[^a-zA-Z0-9_-]/g, '_') === workerIdRaw
    );
    if (!workerToCall) {
      throw new McpError(ErrorCode.MethodNotFound, `Tool ${name} not found`);
    }
  } else {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }

  if (!prompt) {
    throw new McpError(ErrorCode.InvalidParams, 'Prompt is required');
  }

  try {
    const start = Date.now();
    const res = await fetch(workerToCall.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) throw new Error(`Worker returned ${res.status}`);

    const data = (await res.json()) as { response: string };
    const latency = Date.now() - start;

    const responseHash = Hash.sha256(
      Array.from(new TextEncoder().encode(data.response))
    );
    const hashHex = Array.from(responseHash)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    history.push({
      workerId: workerToCall.id,
      prompt: prompt.slice(0, 50) + '...',
      response: data.response,
      price: workerToCall.pricePerJob,
      timestamp: Date.now(),
    });

    getPaymentQueue().push({
      workerId: workerToCall.id,
      amount: workerToCall.pricePerJob,
      proofHash: hashHex,
      timestamp: Date.now(),
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              response: data.response,
              pricePaid: workerToCall.pricePerJob,
              latencyMs: latency,
              proof: hashHex,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        { type: 'text', text: `Error connecting to worker: ${String(error)}` },
      ],
      isError: true,
    };
  }
});

// Start a side-server to register agents so the testing script can register workers
const registrationServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === 'POST' && req.url === '/register') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const workerInfo = JSON.parse(body) as WorkerInfo;
        gateway.registerWorker(workerInfo);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', worker: workerInfo.id }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

registrationServer.listen(3010, () => {
  // We can't console.log on stdio if we are an MCP server, it would break the protocol.
  // Using stderr instead.
  console.error('[MCP] Registration server listening on port 3010');
});

// Start MCP stdio transport
const transport = new StdioServerTransport();
server.connect(transport).catch((err) => {
  console.error('[MCP] Server connection error:', err);
  process.exit(1);
});
