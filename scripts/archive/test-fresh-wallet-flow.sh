#!/bin/bash
# End-to-end test of the fresh-wallet onboarding flow:
#   1. Wipe any existing auto-wallet
#   2. Start MCP → verify a fresh wallet is generated
#   3. peck_wallet_info → confirm address + 0 balance
#   4. peck_request_faucet → confirm sats received from worker1
#   5. Wait for ARC propagation, re-check balance
#   6. Build a tiny ladder owned by the auto-wallet
#   7. Spin up stub registry + inference-agent
#   8. peck_call_service → real LLM call paid for by the auto-wallet
#
# This proves anyone can install peck-mcp and immediately start using
# the marketplace without prior setup.

set -e
cd "$(dirname "$0")/.."

PORT_REGISTRY=8090
PORT_INFERENCE=4002

cleanup() {
  echo
  echo "--- cleanup ---"
  jobs -p | xargs -r kill 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT

mcp_call() {
  local id="$1"
  local tool="$2"
  local args="$3"
  if [ -z "$args" ]; then args='{}'; fi
  printf '{"jsonrpc":"2.0","id":%s,"method":"tools/call","params":{"name":"%s","arguments":%s}}\n' "$id" "$tool" "$args"
}

run_mcp_session() {
  local script_input="$1"
  local hold_open="${2:-3}"   # how many seconds to keep stdin open after the call
  # The subshell with trailing sleep keeps stdin open so the MCP server has
  # time to flush responses before EOF triggers shutdown.
  (
    printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"e2e","version":"1"}}}\n'
    sleep 0.3
    printf '%s\n' "$script_input"
    sleep "$hold_open"
  ) | PECK_REGISTRY_URL=http://localhost:$PORT_REGISTRY \
      PECK_FAUCET_WALLET=worker2 \
      PECK_FAUCET_AMOUNT=4000 \
      timeout 60 npx tsx src/mcp/peck-mcp.ts 2>>/tmp/mcp-stderr.log
}

extract_text() {
  python3 -c "
import json, sys
target_id = int(sys.argv[1])
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        obj = json.loads(line)
        if obj.get('id') == target_id and 'result' in obj:
            content = obj['result'].get('content', [])
            if content:
                print(content[0].get('text', ''))
                break
    except: pass
" "$1"
}

echo "=== 1. wipe auto-wallet ==="
rm -f .peck-state/wallet.json
ls .peck-state/wallet.json 2>&1 || echo "  ✓ no wallet file"

echo
echo "=== 2. start stub registry on :$PORT_REGISTRY ==="
cat > /tmp/stub-registry-fresh.mjs <<EOF
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
node /tmp/stub-registry-fresh.mjs &
sleep 1

echo
echo "=== 3. start inference-agent on :$PORT_INFERENCE ==="
PORT=$PORT_INFERENCE \
SERVICE_ID=inference-balanced \
MODEL=google/gemma-3-12b-it:free \
PRICE=30 \
ANNOUNCE_TO_REGISTRY=0 \
PAYMENT_ADDRESS=myrdYvFjSEyvHAASo6c19rAXrVZwfAeb5S \
npx tsx src/agents/inference-agent.ts > /tmp/inf-fresh.log 2>&1 &
sleep 2

echo
echo "=== 4. peck_wallet_info (should show fresh wallet, 0 balance) ==="
> /tmp/mcp-stderr.log
run_mcp_session "$(mcp_call 2 peck_wallet_info)" > /tmp/mcp-out.log
extract_text 2 < /tmp/mcp-out.log | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'  network: {d[\"network\"]}')
print(f'  source:  {d[\"wallet_source\"]}')
print(f'  address: {d[\"address\"]}')
print(f'  balance: {d[\"balance_sats\"]} sat')
print(f'  next:    {d[\"next_step\"]}')
"

AUTO_ADDR=$(python3 -c "import json; print(json.load(open('.peck-state/wallet.json'))['address'])")
echo
echo "  auto-wallet address persisted: $AUTO_ADDR"

echo
echo "=== 5. peck_request_faucet (sponsors from worker2) ==="
run_mcp_session "$(mcp_call 2 peck_request_faucet)" 8 > /tmp/mcp-out.log
extract_text 2 < /tmp/mcp-out.log | python3 -c "
import json, sys
d = json.load(sys.stdin)
if 'error' in d:
    print(f'  ERROR: {d[\"error\"]} — {d.get(\"detail\", \"\")}')
    sys.exit(1)
print(f'  ok:           {d[\"ok\"]}')
print(f'  faucet_sats:  {d[\"faucet_amount_sats\"]}')
print(f'  txid:         {d[\"txid\"]}')
print(f'  arc_endpoint: {d[\"arc_endpoint\"]}')
print(f'  verify:       {d[\"verify\"]}')
"

echo
echo "=== 6. wait 12s for ARC + WoC to catch up, recheck balance ==="
sleep 12
run_mcp_session "$(mcp_call 2 peck_wallet_info)" > /tmp/mcp-out.log
extract_text 2 < /tmp/mcp-out.log | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'  balance now: {d[\"balance_sats\"]} sat ({d[\"utxo_count\"]} utxos)')
"

echo
echo "=== 7. build a 10-leaf ladder owned by the auto-wallet ==="
FUNDER=auto LEAF_COUNT=10 LEAF_SATS=200 npx tsx scripts/build-tiny-ladder.ts 2>&1 | tail -10

echo
echo "=== 8. peck_call_service ==="
ARGS='{"service_id":"inference-balanced","payload":{"prompt":"In one short sentence, why is open agent payment infrastructure important?"}}'
run_mcp_session "$(mcp_call 2 peck_call_service "$ARGS")" 15 > /tmp/mcp-out.log
extract_text 2 < /tmp/mcp-out.log | python3 -c "
import json, sys
d = json.load(sys.stdin)
if 'error' in d:
    print(f'  ERROR: {d[\"error\"]}')
    sys.exit(1)
print(f'  service:      {d[\"service_id\"]}')
print(f'  request_id:   {d[\"request_id\"]}')
resp = d.get('response', {})
if isinstance(resp, dict):
    print(f'  llm_response: {resp.get(\"response\", \"\")[:200]!r}')
    print(f'  llm_model:    {resp.get(\"model\")}')
pay = d.get('payment', {})
print(f'  paid:         {pay.get(\"sats\")} sat')
print(f'  payment_tx:   {pay.get(\"txid\")}')
print(f'  commitment:   {pay.get(\"commitment_hex\", \"\")[:32]}…')
print(f'  duration:     {d.get(\"duration_ms\")}ms')
"
