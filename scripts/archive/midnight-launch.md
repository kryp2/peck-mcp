# Midnight Launch — Bible Corpus + Fleet

## Prerequisites checklist (must be green before running)

- [ ] Fleet-funder balance ≥ 50M sat (check: `curl ...unspent` on `1HxHKNUwPMvWwX7CwcviDMvjP5FMDcx66X`)
- [ ] `.brc-identities.json` has 79 entries (35 original + 24 scribes + 20 raters)
- [ ] `.bible-data/*.json` has 6 translations
- [ ] peck-mcp live at https://mcp.peck.to (verify with `curl -sI`)
- [ ] peck-indexer-go live (subscription to POST/REPLY/MESSAGE/TAG/LIKE)

## Step 1 — Fund 44 new agents via fan-out (single TX)

```bash
# Total: 44 × 400k = 17.6M sat. Leave margin.
AGENTS=$(for i in $(seq -w 1 24); do printf "scribe-%02d," "$i"; done)
AGENTS="${AGENTS}$(for i in $(seq -w 1 20); do printf "rater-%02d," "$i"; done)"
AGENTS="${AGENTS%,}"

npx tsx scripts/fund-p2pkh-fanout.ts 400000 "$AGENTS"
```

Verify: check one via `npx tsx scripts/test-brc100-single.ts scribe-01` (skip this — it uses bank.peck.to; use direct WoC instead).

## Step 2 — Split each of 44 new agents into 50 UTXOs

```bash
for a in $(echo "$AGENTS" | tr ',' '\n'); do
  timeout 20 npx tsx scripts/split-agent.ts $a 50 2>&1 | tail -1
  sleep 1  # avoid WoC rate-limit
done
```

~90-120 sec total (2s per split × 44).

## Step 3 — Launch bible-poster (24 scribes parallel)

Each scribe gets ~16 books of their assigned translation. 4 scribes per translation × 6 translations = 24.

```bash
# KJV (scribes 01-04)
for i in 01 02 03 04; do
  end=$((i==01 ? 17 : i==02 ? 34 : i==03 ? 50 : 66))
  start=$((i==01 ? 0 : i==02 ? 17 : i==03 ? 34 : 50))
  npx tsx scripts/bible-poster.ts scribe-$i en_kjv $start $end \
    > /tmp/bible-scribe-$i.log 2>&1 &
done

# BBE (scribes 05-08)
for i in 05 06 07 08; do
  idx=$((10#$i - 4))
  start=$(( (idx - 1) * 17 ))
  end=$(( idx == 4 ? 66 : idx * 17 ))
  npx tsx scripts/bible-poster.ts scribe-$i en_bbe $start $end \
    > /tmp/bible-scribe-$i.log 2>&1 &
done

# NVI Portuguese (09-12)
# RVR Spanish (13-16)
# Schlachter German (17-20)
# APEE French (21-24)
# ... same pattern

wait
```

Expected: ~2h for all to finish at 1 TPS/scribe across 24 parallel.

## Step 4 — Launch bible-likers (20 raters, various criteria)

```bash
# Start after ~15 min so verses have propagated to overlay indexer
sleep 900

CRITERIA=(all ot nt psalms proverbs genesis revelation wisdom love god jesus prayer covenant kingdom faith grace creation prophecy parable miracle)

for i in $(seq -w 1 20); do
  idx=$((10#$i - 1))
  crit=${CRITERIA[$idx]}
  DURATION=14400 npx tsx scripts/bible-liker.ts rater-$i $crit \
    > /tmp/bible-liker-$i.log 2>&1 &
done
wait
```

## Step 5 — Launch fleet-hybrid-v2 with existing 30 curator agents

Messenger/evangelist volume layer running alongside the Bible corpus.

```bash
AGENTS="curator-tech:tagger,curator-research:tagger"
AGENTS="$AGENTS,curator-sovereign:messenger,curator-history:messenger,curator-art:messenger,curator-finance:messenger,curator-meta:messenger,curator-long:messenger,curator-short:messenger,curator-edge:messenger,curator-core:messenger,curator-drift:messenger"
AGENTS="$AGENTS,curator-signal:liker,curator-archive:liker,curator-bridge:liker,curator-quant:liker,curator-dev:liker,curator-news:liker,curator-witness:liker,gateway:liker,weather:liker,translate:liker,summarize:liker,price:liker,geocode:liker"
AGENTS="$AGENTS,curator-ethno:evangelist,curator-prose:evangelist,curator-debate:evangelist,curator-narrative:evangelist,curator-memory:evangelist,curator-calm:evangelist"

WORKERS_PER_AGENT=3 npx tsx scripts/fleet-hybrid-v2.ts 36000 "$AGENTS" \
  > /tmp/fleet-v2.log 2>&1 &
```

10h run. Workers × agents × ~1 TPS = ~90 TPS from fleet alone.

## Step 6 — Monitor loop

```bash
# Every 60s, tally on-chain totals
while true; do
  # Bible posters progress
  for f in /tmp/bible-scribe-*.log; do
    tail -1 $f | grep -E "posted=" | head -1
  done

  # Overlay feed counts
  curl -s "https://overlay.peck.to/v1/feed?app=peck.cross&limit=1" | \
    python3 -c "import json,sys;d=json.loads(sys.stdin.read());print(f'peck.cross: total={d.get(\"total\")}')"
  curl -s "https://overlay.peck.to/v1/feed?app=peck.agents&limit=1" | \
    python3 -c "import json,sys;d=json.loads(sys.stdin.read());print(f'peck.agents: total={d.get(\"total\")}')"

  sleep 60
done
```

## Expected TX accumulation

| Hour from midnight | Bible (posts) | Bible-likers | Fleet | Total |
|---|---|---|---|---|
| T+1  | 50K   | 0   | 50K  | 100K  |
| T+2  | 150K  | 30K | 100K | 280K  |
| T+3  | 194K  | 100K| 150K | 444K  |
| T+4  | 194K  | 300K| 200K | 694K  |
| T+5  | 194K  | 600K| 250K | 1.04M |
| T+6  | 194K  | 900K| 300K | 1.39M |
| T+7  | 194K  | 1.1M| 350K | 1.64M |

Target 1.5M reached at ~T+6-7 (5-7am CEST).

## Abort / resume

Each script writes progress to `.bible-progress/*.json` or `.bible-liker-state/*.json`. Killing and restarting resumes where it left off.

## Emergency budget top-up

If an agent runs out of sats mid-run:
```bash
npx tsx scripts/fund-p2pkh-fanout.ts 200000 <agent-name>
npx tsx scripts/split-agent.ts <agent-name> 50
# then kill/restart its poster
```
