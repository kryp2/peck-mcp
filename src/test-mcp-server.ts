import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PrivateKey } from '@bsv/sdk';
import { ComputeWorker } from './worker.js';

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('Starting MCP Marketplace Server test...');

  // 1. Start a Compute Worker locally
  const workerKey = PrivateKey.fromRandom();
  const worker = new ComputeWorker({
    name: 'Test-Worker-MCP',
    key: workerKey,
    port: 3005,
    backend: 'echo',
    pricePerJob: 5,
  });
  worker.start();
  await sleep(1000); // Give worker time to start

  // 2. Start MCP server via StdioClientTransport
  // The transport spawns the server as a child process.
  // The server starts both the MCP stdio interface and the HTTP registration endpoint on port 3010.
  console.log('Spawning MCP Server and connecting via stdio...');
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['--loader', 'ts-node/esm', 'src/mcp-server.ts'],
  });

  const client = new Client(
    {
      name: 'test-client',
      version: '1.0.0',
    },
    {
      capabilities: {},
    }
  );

  await client.connect(transport);
  console.log('MCP Client connected.');
  
  await sleep(1000); // Give HTTP server in the child process a moment to bind to 3010

  // 3. Register the worker dynamically via the HTTP endpoint exposed by mcp-server.ts
  console.log('Registering worker via HTTP side-channel...');
  const registerRes = await fetch('http://localhost:3010/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'test-worker-1',
      name: 'Test-Worker-MCP',
      publicKey: workerKey.toPublicKey().toString(),
      address: workerKey.toAddress(),
      endpoint: 'http://localhost:3005',
      pricePerJob: 5,
      avgLatencyMs: 10,
      failCount: 0,
      lastSeen: Date.now(),
    }),
  });

  if (!registerRes.ok) {
    console.error('Failed to register worker. Registration HTTP status:', registerRes.status);
    process.exit(1);
  }
  console.log('Worker registered successfully.');

  // 4. Test tool discovery (ListTools)
  console.log('Fetching available tools from MCP server...');
  const toolsRes = await client.listTools();
  console.log(`Found ${toolsRes.tools.length} tools:`);
  toolsRes.tools.forEach((t) => console.log(`  - ${t.name}`));

  // Ensure our dynamically registered worker is in the list
  const workerTool = toolsRes.tools.find((t) => t.name === 'service_test-worker-1');
  if (!workerTool) {
    console.error('Dynamic tool service_test-worker-1 not found!');
    process.exit(1);
  }

  // 5. Test invoking the dynamic service tool
  console.log('\nInvoking dynamic tool "service_test-worker-1"...');
  const callRes1 = await client.callTool({
    name: 'service_test-worker-1',
    arguments: {
      prompt: 'Hello from MCP Client (Dynamic Tool)',
    },
  });
  console.log('Response:', JSON.stringify(callRes1, null, 2));

  // 6. Test invoking via generic marketplace_call tool
  console.log('\nInvoking generic tool "marketplace_call"...');
  const callRes2 = await client.callTool({
    name: 'marketplace_call',
    arguments: {
      workerId: 'test-worker-1',
      prompt: 'Hello from MCP Client (Generic Tool)',
    },
  });
  console.log('Response:', JSON.stringify(callRes2, null, 2));

  // 7. Check history
  console.log('\nFetching transaction history...');
  const historyRes = await client.callTool({
    name: 'marketplace_history',
    arguments: {},
  });
  console.log('History:', JSON.stringify(historyRes, null, 2));

  console.log('\nAll tests passed successfully!');
  
  // Cleanup
  await transport.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
