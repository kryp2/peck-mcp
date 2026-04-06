import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PrivateKey } from '@bsv/sdk';
import { ComputeWorker } from './worker.js';

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('--- Starting Agentic Pay MCP Test ---');

  // 1. Start a real worker for the MCP server to call
  const workerKey = PrivateKey.fromRandom();
  const worker = new ComputeWorker({
    name: 'Echo-Worker',
    key: workerKey,
    port: 3001,
    backend: 'echo',
    pricePerJob: 2,
  });
  worker.start();
  await sleep(1000); // give it time to start

  // 2. Set up the MCP Client Transport (spawns the MCP server)
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/mcp-server.ts'],
    env: {
      ...process.env,
      WORKER_ENDPOINT: 'http://localhost:3001/infer'
    }
  });

  const client = new Client(
    {
      name: "test-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    }
  );

  console.log('Connecting to MCP Server...');
  await client.connect(transport);
  console.log('Connected!');

  // 3. Test tool discovery (List Tools)
  console.log('\n--- Listing Tools ---');
  const tools = await client.listTools();
  console.log(JSON.stringify(tools.tools.map(t => t.name), null, 2));

  // 4. Test marketplace_search
  console.log('\n--- Searching Marketplace ---');
  const searchResult = await client.callTool({
    name: 'marketplace_search',
    arguments: { query: 'echo' }
  });
  console.log(JSON.stringify(searchResult.content, null, 2));

  // 5. Test dynamic tool (service_worker-1)
  console.log('\n--- Calling Dynamic Tool (service_worker-1) ---');
  try {
    const callResult = await client.callTool({
      name: 'service_worker-1',
      arguments: { prompt: 'Hello from MCP!' }
    });
    console.log(JSON.stringify(callResult.content, null, 2));
  } catch (err) {
    console.error('Error calling dynamic tool:', err);
  }

  // 6. Test marketplace_balance
  console.log('\n--- Checking Gateway Balance ---');
  const balanceResult = await client.callTool({
    name: 'marketplace_balance',
    arguments: {}
  });
  console.log(JSON.stringify(balanceResult.content, null, 2));

  console.log('\n--- Test Complete ---');
  
  // Clean up
  await client.close();
  process.exit(0);
}

main().catch(console.error);
