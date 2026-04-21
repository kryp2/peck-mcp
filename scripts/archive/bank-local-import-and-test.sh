#!/usr/bin/env bash
# Wait for the bank-local funding tx to confirm, import it, then run an
# end-to-end test of memory-agent v2 against bank-local.
#
# Usage:
#   FUNDING_TXID=fbadbec0... ./scripts/bank-local-import-and-test.sh
set -euo pipefail

FUNDING_TXID="${FUNDING_TXID:?set FUNDING_TXID to the funding txid}"
BANK_URL="${BANK_LOCAL_URL:-http://localhost:8088}"
MEM_PORT="${MEM_PORT:-4011}"

echo "[bank-local-test] waiting for $FUNDING_TXID to confirm…"
for i in $(seq 1 60); do
  C=$(curl -s "https://api.whatsonchain.com/v1/bsv/test/tx/$FUNDING_TXID" < /dev/null \
        | python3 -c 'import json,sys; print(json.load(sys.stdin).get("confirmations",0))' 2>/dev/null || echo 0)
  if [ "$C" -gt 0 ]; then
    echo "[bank-local-test] confirmed (${C} confirmations)"
    break
  fi
  echo "[bank-local-test]  attempt $i: 0 confirmations, sleeping 30s"
  sleep 30
done

echo "[bank-local-test] importing into bank-local…"
curl -s -X POST "$BANK_URL/importUtxo" \
  -H 'Content-Type: application/json' \
  -d "{\"txid\":\"$FUNDING_TXID\"}" < /dev/null
echo
echo "[bank-local-test] new bank-local balance:"
curl -s "$BANK_URL/balance" < /dev/null
echo

echo "[bank-local-test] starting memory-agent v2…"
PORT="$MEM_PORT" ANNOUNCE_TO_REGISTRY=0 npx tsx src/agents/memory-agent-v2.ts > /tmp/memv2.log 2>&1 &
AGENT_PID=$!
sleep 4

cleanup() { kill "$AGENT_PID" 2>/dev/null || true; }
trap cleanup EXIT

echo "[bank-local-test] /health:"
curl -s "http://localhost:$MEM_PORT/health" < /dev/null
echo
echo "[bank-local-test] write 1:"
curl -s -X POST "http://localhost:$MEM_PORT/memory-write" \
  -H 'Content-Type: application/json' \
  -d '{"namespace":"agent-claude","key":"goal","value":"book a flight to Oslo","tags":["travel","todo"]}' < /dev/null
echo
echo "[bank-local-test] write 2:"
curl -s -X POST "http://localhost:$MEM_PORT/memory-write" \
  -H 'Content-Type: application/json' \
  -d '{"namespace":"agent-claude","key":"budget","value":"500 USD","tags":["travel"]}' < /dev/null
echo
echo "[bank-local-test] list:"
curl -s -X POST "http://localhost:$MEM_PORT/memory-list" \
  -H 'Content-Type: application/json' \
  -d '{"namespace":"agent-claude"}' < /dev/null
echo
echo "[bank-local-test] search-tag:"
curl -s -X POST "http://localhost:$MEM_PORT/memory-search-tag" \
  -H 'Content-Type: application/json' \
  -d '{"tag":"travel"}' < /dev/null
echo
echo "[bank-local-test] memory-agent log tail:"
tail -20 /tmp/memv2.log
