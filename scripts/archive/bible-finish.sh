#!/bin/bash
# bible-finish.sh — launch targeted he_wlc + grc_nt scribes to complete the bible
cd /home/thomas/Documents/peck-to/peck-mcp
mkdir -p /tmp/bible-logs

# Get usable wallets (>5000 sat)
WALLETS=()
for f in .agent-wallets/ranger-*.json .agent-wallets/agent-*.json .agent-wallets/psalm-*.json .agent-wallets/scribe-*.json; do
  [ -f "$f" ] || continue
  name=$(basename "$f" .json)
  sats=$(python3 -c "import json; print(sum(u['satoshis'] for u in json.load(open('$f')).get('utxos', [])))" 2>/dev/null)
  if [ "${sats:-0}" -gt 5000 ]; then
    WALLETS+=("$name")
  fi
done

echo "Usable wallets: ${#WALLETS[@]}"

# Split: first 50 → grc_nt, rest → he_wlc
# grc_nt ranges (27 books): 0-6, 7-13, 14-20, 21-26
# he_wlc ranges (39 books): 0-9, 10-19, 20-29, 30-38

GRC_RANGES=("0 7" "7 14" "14 21" "21 27")
HEB_RANGES=("0 10" "10 20" "20 30" "30 39")

SPAWNED=0

# First 50 → grc_nt
for i in $(seq 0 49); do
  [ -z "${WALLETS[$i]}" ] && break
  name=${WALLETS[$i]}
  range_idx=$((i % 4))
  r=${GRC_RANGES[$range_idx]}
  nohup npx tsx scripts/bible-poster.ts "$name" grc_nt $r > "/tmp/bible-logs/finish-${name}.log" 2>&1 &
  SPAWNED=$((SPAWNED+1))
  sleep 0.2
done

echo "grc_nt: $SPAWNED agents launched"
GRC_COUNT=$SPAWNED

# Rest → he_wlc
for i in $(seq 50 $((${#WALLETS[@]}-1))); do
  [ -z "${WALLETS[$i]}" ] && break
  name=${WALLETS[$i]}
  range_idx=$(( (i-50) % 4 ))
  r=${HEB_RANGES[$range_idx]}
  nohup npx tsx scripts/bible-poster.ts "$name" he_wlc $r > "/tmp/bible-logs/finish-${name}.log" 2>&1 &
  SPAWNED=$((SPAWNED+1))
  sleep 0.2
done

HEB_COUNT=$((SPAWNED - GRC_COUNT))
echo "he_wlc: $HEB_COUNT agents launched"
echo "Total: $SPAWNED agents"
echo ""
free -h | head -2
