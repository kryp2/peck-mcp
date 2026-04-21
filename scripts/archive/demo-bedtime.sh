#!/bin/bash
# Bedtime demo: a polished walk through the full Peck Pay flow as
# experienced by a fresh MCP client.
#
# What it shows, in narrative order:
#   1. Fresh wallet auto-generated on first MCP boot
#   2. Faucet deposits free testnet sats
#   3. Pre-built UTXO ladder built from the faucet UTXO
#   4. peck_list_services shows the marketplace catalog
#   5. peck_call_service: real LLM call paid by the new wallet, with
#      32-byte commitment binding the on-chain tx to the request

set -e
cd "$(dirname "$0")/.."

PORT_REGISTRY=8090
PORT_INFERENCE=4003
MODEL="openai/gpt-oss-20b:free"
SERVICE_ID="inference-balanced"
PRICE=30

C_RESET=$'\033[0m'
C_BOLD=$'\033[1m'
C_DIM=$'\033[2m'
C_GREEN=$'\033[32m'
C_YELLOW=$'\033[33m'
C_BLUE=$'\033[34m'
C_MAGENTA=$'\033[35m'
C_CYAN=$'\033[36m'

step() {
  echo
  echo "${C_BOLD}${C_BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RESET}"
  echo "${C_BOLD}${C_BLUE}▶ $1${C_RESET}"
  echo "${C_BOLD}${C_BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RESET}"
}

cleanup() {
  jobs -p | xargs -r kill 2>/dev/null
  wait 2>/dev/null || true
}
trap cleanup EXIT

mcp_call() {
  local id="$1" tool="$2" args="$3"
  if [ -z "$args" ]; then args='{}'; fi
  printf '{"jsonrpc":"2.0","id":%s,"method":"tools/call","params":{"name":"%s","arguments":%s}}\n' "$id" "$tool" "$args"
}

mcp_session() {
  local script_input="$1"
  local hold="${2:-8}"
  (
    printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"demo","version":"1"}}}\n'
    sleep 0.3
    printf '%s\n' "$script_input"
    sleep "$hold"
  ) | PECK_REGISTRY_URL=http://localhost:$PORT_REGISTRY \
      PECK_FAUCET_WALLET=worker1 \
      PECK_FAUCET_AMOUNT=800 \
      timeout 60 npx tsx src/mcp/peck-mcp.ts 2>>/tmp/demo-mcp-err.log
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

clear
echo "${C_BOLD}${C_MAGENTA}"
cat <<'BANNER'
   ┌─────────────────────────────────────────────────────────────┐
   │                                                             │
   │                  🌙  PECK PAY — BEDTIME DEMO                │
   │                                                             │
   │     Zero-friction onboarding to an agentic BSV marketplace  │
   │     Walking the full path: install → fund → call → verify   │
   │                                                             │
   └─────────────────────────────────────────────────────────────┘
BANNER
echo "${C_RESET}"
sleep 1

step "Step 0 — wipe any existing state, like a fresh install"
rm -f .peck-state/wallet.json
echo "  ${C_DIM}rm .peck-state/wallet.json${C_RESET}  → ${C_GREEN}done${C_RESET}"
# Also wipe stale 'auto' leaves from previous wallet generations so they
# don't get re-used under the new (unrelated) key.
sqlite3 .ladder-state/leaves.db "DELETE FROM leaves WHERE owner_agent LIKE 'auto%';" 2>/dev/null && echo "  ${C_DIM}cleared stale auto-* leaves from ladder db${C_RESET}  → ${C_GREEN}done${C_RESET}" || true

step "Step 1 — start the marketplace registry (single inference service)"
cat > /tmp/demo-stub.mjs <<EOF
import { createServer } from 'http'
const services = [{
  id: '$SERVICE_ID',
  name: '$SERVICE_ID',
  identityKey: '00'.repeat(33),
  endpoint: 'http://localhost:$PORT_INFERENCE',
  capabilities: ['inference', 'llm', 'chat'],
  pricePerCall: $PRICE,
  paymentAddress: 'myrdYvFjSEyvHAASo6c19rAXrVZwfAeb5S',
  description: 'OpenRouter $MODEL — premium free LLM',
  registeredAt: Date.now(),
}]
createServer((req, res) => {
  if (req.url === '/marketplace') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(services))
  } else { res.writeHead(404); res.end() }
}).listen($PORT_REGISTRY, () => console.error('stub registry on $PORT_REGISTRY'))
EOF
node /tmp/demo-stub.mjs > /dev/null 2>&1 &
sleep 1
echo "  ${C_GREEN}✓${C_RESET} marketplace registry alive on :$PORT_REGISTRY"

step "Step 2 — start the inference-agent (wraps $MODEL)"
PORT=$PORT_INFERENCE \
SERVICE_ID=$SERVICE_ID \
MODEL=$MODEL \
PRICE=$PRICE \
ANNOUNCE_TO_REGISTRY=0 \
PAYMENT_ADDRESS=myrdYvFjSEyvHAASo6c19rAXrVZwfAeb5S \
npx tsx src/agents/inference-agent.ts > /tmp/demo-inf.log 2>&1 &
sleep 2
echo "  ${C_GREEN}✓${C_RESET} inference-agent live on :$PORT_INFERENCE"
echo "  ${C_DIM}model: $MODEL${C_RESET}"

step "Step 3 — first MCP connect → auto-generated hot wallet"
echo "  ${C_DIM}calling peck_wallet_info on a fresh server...${C_RESET}"
> /tmp/demo-mcp-err.log
mcp_session "$(mcp_call 2 peck_wallet_info)" > /tmp/demo-out.log
RESULT=$(extract_text 2 < /tmp/demo-out.log)
echo "$RESULT" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print()
print(f'  ${C_BOLD}wallet address:${C_RESET} ${C_CYAN}{d[\"address\"]}${C_RESET}')
print(f'  ${C_BOLD}network:       ${C_RESET} {d[\"network\"]}')
print(f'  ${C_BOLD}source:        ${C_RESET} ${C_GREEN}{d[\"wallet_source\"]}${C_RESET}')
print(f'  ${C_BOLD}balance:       ${C_RESET} {d[\"balance_sats\"]} sat')
print(f'  ${C_DIM}{d[\"next_step\"]}${C_RESET}')
"

step "Step 4 — peck_request_faucet → 800 testnet sats sponsored"
mcp_session "$(mcp_call 2 peck_request_faucet)" 8 > /tmp/demo-out.log
RESULT=$(extract_text 2 < /tmp/demo-out.log)
FAUCET_TXID=$(echo "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('txid',''))")
echo "$RESULT" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print()
print(f'  ${C_GREEN}✓${C_RESET} faucet payment broadcast')
print(f'  ${C_BOLD}txid:${C_RESET}  ${C_CYAN}{d[\"txid\"]}${C_RESET}')
print(f'  ${C_BOLD}sats:${C_RESET}  {d[\"faucet_amount_sats\"]}')
print(f'  ${C_BOLD}via:${C_RESET}   {d[\"arc_endpoint\"]}')
print(f'  ${C_DIM}verify: {d[\"verify\"]}${C_RESET}')
"

step "Step 5 — build a 3-leaf UTXO ladder owned by the new wallet"
echo "  ${C_DIM}cached funding tx → no WoC indexing wait needed${C_RESET}"
FUNDER=auto LEAF_COUNT=3 LEAF_SATS=200 npx tsx scripts/build-tiny-ladder.ts 2>&1 | grep -E '(setup txid|leaves created|fee paid|ladder stats)' | sed 's/^/  /'

step "Step 6 — peck_list_services (the LLM discovers what's available)"
mcp_session "$(mcp_call 2 peck_list_services '{"capability":"inference","limit":5}')" > /tmp/demo-out.log
RESULT=$(extract_text 2 < /tmp/demo-out.log)
echo "$RESULT" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print()
print(f'  services matching capability=inference: {d[\"total_matching\"]}')
for s in d['services']:
    print(f'    {s[\"id\"]:<22}  {s[\"price_sats\"]:>3} sat  {s[\"description\"][:50]}')
"

step "Step 7 — peck_call_service (the magic moment)"
echo "  ${C_DIM}LLM client says: 'use peck pay to ask the agent in a poetic way${C_RESET}"
echo "  ${C_DIM}                  why micropayments matter for AI'${C_RESET}"
echo
ARGS='{"service_id":"inference-balanced","payload":{"prompt":"In one elegant sentence, why do micropayments matter for AI agents trading with each other?"}}'
mcp_session "$(mcp_call 2 peck_call_service "$ARGS")" 20 > /tmp/demo-out.log
RESULT=$(extract_text 2 < /tmp/demo-out.log)
echo "$RESULT" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('  ✓ on-chain payment + parallel HTTP call complete')
print()
print('  LLM response:')
resp = d.get('response', {})
if isinstance(resp, dict):
    text = resp.get('response', '')
    for line in text.strip().split('\n'):
        print(f'    {line}')
    print()
    print(f'  model:        {resp.get(\"model\")}')
elif isinstance(resp, str):
    print(f'    {resp}')
pay = d.get('payment', {})
print(f'  paid:         {pay.get(\"sats\")} sat')
print(f'  payment txid: {pay.get(\"txid\")}')
print(f'  commitment:   {pay.get(\"commitment_hex\",\"\")[:32]}…')
print(f'  verify:       {d.get(\"verify\")}')
print(f'  duration:     {d.get(\"duration_ms\")}ms total (sign + broadcast + LLM call)')
"

echo
echo "${C_BOLD}${C_GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RESET}"
echo "${C_BOLD}${C_GREEN}  ✓ END-TO-END DEMO COMPLETE${C_RESET}"
echo "${C_BOLD}${C_GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RESET}"
echo
echo "  ${C_DIM}Total elapsed: from a wiped install to a verified on-chain${C_RESET}"
echo "  ${C_DIM}service payment with LLM response, in one shell session.${C_RESET}"
echo
