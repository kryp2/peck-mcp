---
priority: 2
complexity: high
model: sonnet
depends_on: [ap2a_scrypt_contract]
verify: true
test_cmd: "npx tsx src/test-channel.ts"
---

# AP2B: Channel Lifecycle Management

## Kontekst
Med sCrypt-kontrakten paa plass (AP2A), bygg komplett lifecycle:
open → update (off-chain) → close (on-chain).

## Oppgaver

### 1. ChannelManager klasse
- `openChannel(gateway, worker, capacity)` — laasfond i sCrypt output
- `updateChannel(channelId, amount)` — off-chain state increment
- `closeChannel(channelId)` — cooperative close, siste state on-chain
- `forceClose(channelId)` — unilateral close etter timeout

### 2. State management
- Lokal JSON-fil per aktiv channel
- State: channelId, fundingTxId, capacity, spent, lastUpdate, signatures
- Atomic state updates (write-then-rename)

### 3. Reconnect/recovery
- Ved restart: les aktive channels fra disk
- Verifiser funding TX fortsatt er unspent (WoC check)
- Resume fra siste kjente state

### 4. Multi-channel support
- Gateway kan ha channels til flere workers samtidig
- Channel-pool: gjenbruk aapne channels, aapne nye ved behov
- Auto-close idle channels etter konfigurerbar timeout

## Filer
- `src/channel-manager.ts` — ny fil
- `src/test-channel.ts` — utvid tester
- `data/channels/` — channel state directory

## Viktig
- Off-chain updates = bare signatur-utveksling, ingen TX broadcast
- Kun siste state broadcastes ved close
- Timeout-mekanisme via nLockTime
