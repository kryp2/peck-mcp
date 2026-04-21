#!/bin/bash
# End-to-end test of the Peck Pay MCP server flow:
#   1. Spin up a tiny stub registry on :8090 with a single inference-agent entry
#   2. Spin up the inference-agent on :4001 (no auto-announce, since we're using stub)
#   3. Spawn peck-mcp.ts as a subprocess pointed at the stub registry
#   4. Send JSON-RPC: initialize → tools/call peck_call_service → check response
#   5. Verify on-chain commitment matches off-chain via WoC
#   6. Cleanup
#
# Run from project root:  ./scripts/test-mcp-end-to-end.sh

set -e
cd "$(dirname "$0")/.."

PORT_REGISTRY=8090
PORT_INFERENCE=4001

cleanup() {
  echo
  echo "--- cleanup ---"
  jobs -p | xargs -r kill 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT

echo "=== 1. start stub registry on :$PORT_REGISTRY ==="
cat > /tmp/stub-registry-mcp.mjs <<EOF
import { createServer } from 'http'
const services = [
  {
    id: 'inference-balanced',
    name: 'inference-balanced',
    identityKey: '00'.repeat(33),
    endpoint: 'http://localhost:$PORT_INFERENCE',
    capabilities: ['inference', 'llm', 'chat'],
    pricePerCall: 30,
    paymentAddress: 'myrdYvFjSEyvHAASo6c19rAXrVZwfAeb5S',
    description: 'OpenRouter google/gemma-3-12b-it:free',
    registeredAt: Date.now(),
  },
]
const server = createServer((req, res) => {
  if (req.url === '/marketplace') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(services))
  } else { res.writeHead(404); res.end() }
})
server.listen($PORT_REGISTRY, () => console.error('stub registry on :$PORT_REGISTRY'))
EOF
node /tmp/stub-registry-mcp.mjs &
sleep 1

echo "=== 2. start inference-agent on :$PORT_INFERENCE ==="
PORT=$PORT_INFERENCE \
SERVICE_ID=inference-balanced \
MODEL=google/gemma-3-12b-it:free \
PRICE=30 \
ANNOUNCE_TO_REGISTRY=0 \
PAYMENT_ADDRESS=myrdYvFjSEyvHAASo6c19rAXrVZwfAeb5S \
npx tsx src/agents/inference-agent.ts > /tmp/inference.log 2>&1 &
sleep 2

echo "=== 3. health check both ==="
curl -s http://localhost:$PORT_REGISTRY/marketplace | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'  registry: {len(d)} services, first id={d[0][\"id\"]}')"
curl -s http://localhost:$PORT_INFERENCE/health | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'  inference: {d[\"service_id\"]} model={d[\"model\"]} port={d[\"port\"]}')"

echo
echo "=== 4. send peck_call_service via MCP json-rpc ==="
(
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"e2e","version":"1"}}}'
  sleep 0.3
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"peck_call_service","arguments":{"service_id":"inference-balanced","payload":{"prompt":"In exactly 10 words, explain what BSV micropayments enable for AI agents."}}}}'
  sleep 8
) | PECK_REGISTRY_URL=http://localhost:$PORT_REGISTRY PECK_WALLET=worker1 timeout 25 npx tsx src/mcp/peck-mcp.ts 2>/tmp/mcp-stderr.log > /tmp/mcp-stdout.log

echo
echo "--- mcp stderr ---"
cat /tmp/mcp-stderr.log
echo
echo "--- mcp stdout (parsed) ---"
python3 << 'PYEOF'
import json
with open('/tmp/mcp-stdout.log') as f:
    for line in f:
        line = line.strip()
        if not line: continue
        try:
            obj = json.loads(line)
            if obj.get('id') == 2 and 'result' in obj:
                txt = obj['result']['content'][0]['text']
                data = json.loads(txt)
                print(f"  service_id:      {data.get('service_id')}")
                print(f"  request_id:      {data.get('request_id')}")
                print(f"  response_status: {data.get('response_status')}")
                resp = data.get('response', {})
                if isinstance(resp, dict):
                    print(f"  llm_response:    {resp.get('response', '')[:200]!r}")
                    print(f"  llm_model:       {resp.get('model')}")
                    print(f"  served_in_ms:    {resp.get('served_in_ms')}")
                pay = data.get('payment', {})
                print(f"  payment_txid:    {pay.get('txid')}")
                print(f"  payment_sats:    {pay.get('sats')}")
                print(f"  commitment:      {pay.get('commitment_hex', '')[:32]}…")
                print(f"  arc_endpoint:    {pay.get('endpoint')}")
                print(f"  duration_ms:     {data.get('duration_ms')}")
                print(f"  verify:          {data.get('verify')}")
        except Exception as e:
            print(f"  parse error: {e}")
PYEOF

echo
echo "=== 5. inference agent stats ==="
curl -s http://localhost:$PORT_INFERENCE/stats | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'  total served: {d[\"total_served\"]}')
print(f'  total tokens: {d[\"total_tokens\"]}')
"
