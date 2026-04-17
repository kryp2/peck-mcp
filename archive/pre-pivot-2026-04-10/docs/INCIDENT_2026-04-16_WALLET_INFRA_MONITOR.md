# Incident 2026-04-16 — 355M sats "missing", locked behind dormant Monitor

**When:** 2026-04-15 14:03 → 2026-04-16 11:46 UTC (~22h before detection)
**Severity:** Critical — agent fleet funding blocked, UI reported `insufficient funds` with ~355M sats apparently vanished
**Resolved:** 2026-04-16 11:46 UTC via manual DB flip + Cloud Run pod wake
**Identity affected:** `03acce7a...c78b2d` (userId 33 on `bank.peck.to`)

## Symptom chain

1. Legacy payment of 3.533 BSV (`c773f1dad6...`) imported via peck-desktop
   LegacyBridge, status `completed`.
2. Subsequent agent funding sends built and broadcast (36b2bf, f90f2f8b,
   02251d3c on-chain; b74528f0 and 9f5feaee never made it to chain).
3. All 5 outbound txs ended in `transactions.status = 'nosend'` in
   wallet-infra PG — their change outputs (355.168.682 sats total, incl.
   the 352.303.346-sat P2PKH at `1649ff...`) had `spendable=true,
   change=true, basket='default'` in `outputs`, but UTXO-selector filters
   by parent-tx status and excluded them all.
4. Any new `createAction` saw "insufficient funds" despite UI balance
   displaying 356M. 90-agent fleet funding broke hard.

## Root cause (two layers)

### L1 — `nosend` without ever becoming `completed`
The 5 reqs entered `nosend` status during a ~10h window 2026-04-15.
`proven_tx_reqs.history` shows only `unknown → nosend`; none of them
walked the normal `unsent → unmined → completed` path. Likely triggered
by a createAction with `options.noSend=true` somewhere in the fleet
pipeline (batched funding), then the batch's `sendWith` callback never
arrived to flip state. 3 of 5 txs got broadcast anyway (chain observed
57–122 confirmations), wallet-infra never caught up.

### L2 — `TaskCheckForProofs` only runs on new-block events AND Monitor is dead between blocks
`wallet-toolbox/src/monitor/tasks/TaskCheckForProofs.ts:40-46`:

```ts
trigger(nowMsecsSinceEpoch: number): { run: boolean } {
  return {
    run: TaskCheckForProofs.checkNow
    // Check only when checkNow flag is set.
    // || (this.triggerMsecs > 0 && nowMsecsSinceEpoch - this.lastRunMsecsSinceEpoch > this.triggerMsecs)
  }
}
```

The interval-based trigger is **commented out**. The task ONLY runs when
`checkNow=true` is set externally — and that only happens when
`TaskNewHeader.processNewBlockHeader` is called, which requires the new
header to have been stable for a full `TaskNewHeader.triggerMsecs` cycle
(~1 minute, anti-reorg).

Combined with **Cloud Run scale-to-zero** (no `min-instances` on
`peck-wallet-infra`), the pod terminated between requests. Monitor is a
background in-process loop — when the container dies, Monitor dies. Next
request cold-starts the pod, Monitor re-inits, but only picks up proofs
once the next block arrives + 1 min queue delay. With infrequent request
traffic, Monitor effectively only ran during user-driven bursts.

Net effect: 3 txs mined at heights 944920, 944973, 944983 (2026-04-15
timeframe) sat with `proven_tx_reqs.status='nosend'` indefinitely because
no Monitor cycle ever touched them.

## Resolution (2026-04-16 11:32–11:46)

### Step 1 — Flip the 3 confirmed txs to proof-eligible state
```sql
UPDATE proven_tx_reqs
SET status = 'unmined', updated_at = NOW()
WHERE "txid" IN (
  'f90f2f8bd142610f8b98dd996d346c7503aa626e25efd33f8c58357377dacae9',
  '02251d3ca77c874571706c03a092ae3e9c78ba327df22fa9601dcb3259a45d00',
  '36b2bf14a303643f90b873d44cd6523b3076c941b3408310dd36882ccea170c0'
);
UPDATE transactions
SET status = 'unproven', updated_at = NOW()
WHERE "userId" = 33
  AND "txid" IN ('f90f2f8b...', '02251d3c...', '36b2bf14...');
COMMIT;
```

### Step 2 — Wake the Cloud Run pod
```bash
curl https://bank.peck.to/health
curl https://bank.peck.to/health
```
Cold start took 3.6s. Logs showed:

```
11:45:53  wallet-toolbox StorageServer v1.3.30 started
11:45:54  TaskNewHeader first header: 945043
11:46:01  TaskNewHeader process header: 945043 delayed 7.7 secs
11:46:46  TaskCheckForProofs 3 reqs with status 'callback','unmined'...
11:46:20  getMerklePathSuccess name:`WoCTsc` status:200
```

All 3 transitioned to `completed` within the same Monitor cycle. 355M
sats became spendable immediately.

## Followups (do before running the fleet again)

1. **[REQUIRED] Set `min-instances=1` on `peck-wallet-infra`:**
   ```bash
   gcloud run services update peck-wallet-infra \
     --region=europe-west1 \
     --project=gen-lang-client-0447933194 \
     --min-instances=1
   ```
   Cost: ~$7–15/mo extra. Without this, Monitor dies between bursts and
   the whole class of bugs returns.

2. **[Upstream PR candidate]** Reenable the interval trigger in
   `TaskCheckForProofs.trigger` — uncomment the `triggerMsecs` branch.
   Even with `min-instances=1` this is a safety net for stuck reqs that
   missed a block event.

3. **[Investigation]** The 2 missing txs (`b74528f0`, `9f5feaee`) are in
   `nosend` but never broadcast. Change-output satoshis locked:
   1.379.264 + 56 = 1.379.320 sat. If batch-broadcast was intended but
   failed silently, identify the caller path. Decision pending: mark
   `failed` and release inputs, or attempt re-broadcast from `rawTx`
   blob.

4. **[Process]** Monitor Cloud Run pod health + `proven_tx_reqs` stuck-
   states as part of the hackathon runbook. Alert on any `nosend` older
   than 30 min.

## Files touched

- None in code — all SQL + ops. Resolution is purely state-repair.

## Related memory

- `feedback_no_woc_in_loop.md` — WoC forbidden in hot path. Note:
  wallet-toolbox Monitor uses WoC for `getMerklePath` once per unproven
  tx at block-event time. Sparse enough to not violate the rule, but
  worth flagging if scaled.
- `project_upstream_contributions_after_hackathon.md` — add this as bug
  #12.

## Credit / trail

Diagnosed by walking from peck-desktop symptom ("balance shows, signing
fails") → local SQLite (sync stale since 2026-04-11) → remote
active-storage (`bank.peck.to`) → Cloud SQL `transactions.status='nosend'`
→ `proven_tx_reqs` history gap → wallet-toolbox source → Cloud Run
lifecycle. Total time from report to resolution: ~2 hours.
