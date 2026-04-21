#!/bin/bash
# launch-bible-fleet.sh — spawn 24 parallel bible-completer processes
# with non-overlapping book ranges.
#
# Usage: ./scripts/launch-bible-fleet.sh <translation> <book_count>
#   e.g. ./scripts/launch-bible-fleet.sh he_wlc 39
#        ./scripts/launch-bible-fleet.sh grc_nt 27

set -e
TRANS="${1:?need translation}"
NBOOKS="${2:?need book count}"
cd "$(dirname "$0")/.."

mkdir -p /tmp/bible-logs
> "/tmp/bible-logs/${TRANS}-pids.txt"

# Partition NBOOKS across 24 scribes: first K scribes get 2 books each,
# rest get 1 book. K = NBOOKS - 24 if NBOOKS >= 24 else 0 (but we always have 24+ books)
DOUBLE_COUNT=$((NBOOKS - 24))
if [ $DOUBLE_COUNT -lt 0 ]; then DOUBLE_COUNT=0; fi

SINGLE_START=$((DOUBLE_COUNT * 2))

for i in $(seq 1 24); do
  sn=$(printf "scribe-%02d" $i)
  if [ $i -le $DOUBLE_COUNT ]; then
    start=$((2*(i-1)))
    end=$((start+2))
  else
    idx=$((i - DOUBLE_COUNT - 1))
    start=$((SINGLE_START + idx))
    end=$((start + 1))
    if [ $end -gt $NBOOKS ]; then end=$NBOOKS; fi
    if [ $start -ge $NBOOKS ]; then continue; fi
  fi
  # Last scribe catches any remainder
  if [ $i -eq 24 ] && [ $end -lt $NBOOKS ]; then end=$NBOOKS; fi
  nohup npx tsx scripts/bible-completer.ts "$sn" "$TRANS" $start $end > "/tmp/bible-logs/${TRANS}-${sn}.log" 2>&1 &
  echo "$sn pid=$! range=[$start,$end)" | tee -a "/tmp/bible-logs/${TRANS}-pids.txt"
  sleep 0.5
done

echo "---"
echo "launched: $(wc -l < /tmp/bible-logs/${TRANS}-pids.txt) scribes for $TRANS"
