# Morning report — natt 8→9 april 2026

God morgen ☕ Her er hva som skjedde i kveld før du sov.

## TL;DR

I går kveld (8. april) bygde vi **både dag 1 og dag 2** av 9-dagers planen
i én session, pluss en bonus-utvidelse av MCP-laget. Du landet på den store
strategiske innsikten på slutten: **Peck Pay MCP er ikke en hackathon-stunt
— det er BSVs første reelle agentic onboarding-flate, og 1.5M tx kommer
naturlig fra modest organisk adopsjon (3000 aktive brukere).**

Alt er pushed til main. Working tree er clean. Du kan starte presis der vi
slapp ved å lese STATUS.md → PLAN.md → denne fila.

## Det største bevegelsene

### 1. Pre-built UTXO ladder (dag 1, ferdig)
Hele `src/ladder/`-modulen + scripts. Bevist 38 TPS sustained på testnet,
0% feilrate, 60 parallelle rifler, single endpoint. Headroom 2.2× over
hackathon-kravet.

### 2. Meaningful tx via OP_RETURN commitments (dag 1)
`src/ladder/client.ts` (LadderClient) binder hver shot til en spesifikk
service-call via 32-byte SHA256 commitment i OP_RETURN. Verifiserbart
on-chain ved å re-hashe et off-chain receipt. Selektiv åpenhet — privat
default, offentlig revelering på forespørsel.

### 3. MCP-server med skalerbart verktøysett (dag 1+2)
`src/mcp/peck-mcp.ts`. 5 tools live:
- `peck_list_services` — filter, sort, paginate (skalerer til 1000+ services)
- `peck_balance`
- `peck_wallet_info`
- `peck_request_faucet` (testnet only)
- `peck_call_service`

Designvalget: meta-tools, ikke per-agent-tools. MCP klient-toolset forblir
~7 uavhengig av hvor mange agenter som er i markedet.

### 4. Auto-wallet + faucet (bonus, kveld)
Anyone som installerer peck-mcp i Claude Desktop / Cursor får automatisk
en BSV-wallet generert ved første start, persisted i `.peck-state/wallet.json`.
Faucet-tool sender 800-1500 testnet sat fra worker1/worker2 til den nye
walleten. Cached funding tx hex skrives inn i wallet-fila så `build-tiny-ladder.ts`
kan bygge en stige uten å gå gjennom WoC mempool indeksering (som er upålitelig).

### 5. Første reelle LLM-selger (dag 2)
`src/agents/inference-agent.ts` — wrapper én OpenRouter-modell som en
betalt service. Spinnable som N instanser med forskjellige MODEL/PORT/PRICE.
4 free-tier modeller utvalgt: gemma-3-4b, gemma-3-12b, qwen3-coder, gpt-oss-120b.
$0 cost via OpenRouter free tier.

### 6. End-to-end demo (kveld)
`scripts/demo-bedtime.sh` — komplett narrativ walkthrough fra fresh install
til verifisert on-chain payment. Verified live: tx
[`44fcbba0…`](https://test.whatsonchain.com/tx/44fcbba031a7cdf0771fecbb6487b086cd277e24d85acaf3765550a01db83239)
inneholder commitment som binder den til en gpt-oss-20b inference call.
Total tid fra fresh install til on-chain proof: ~30 sekunder.

## Bugs vi traff (alle fikset)

1. **`alreadyKnown` ARC false-positive** — matchet "input already spent"
   som suksess → silent double-spend-aksept. Fikset til å kun matche
   "already in mempool/mined/known".

2. **Bash `${var:-{}}` parser bug** — bash legger til en ekstra `}` ved
   parameter-expansion med `{}` som default. Fikset til eksplisitt
   `if [ -z ]`-sjekk i `mcp_call`-helpers.

3. **WoC mempool indexing race** — `/unspent` og `/tx/{id}/hex` er
   upålitelige på fresh tx. Workaround: cached funding tx hex i auto-wallet
   json så build-script bypasser WoC.

4. **Owner_agent overlap** — alle auto-wallets brukte samme `'auto'`-label,
   så rifle plukket gamle leaves låst med tidligere keys → OP_EQUALVERIFY
   feil. Fikset ved å scope label til `auto-{address-suffix}`.

5. **Wallet leak** — committet `.peck-state/wallet.json` ved et uhell
   (auto-genererert testnet, ~2000 sat). Fikset med `git rm --cached` +
   gitignored `.peck-state/`. Den ene addressen `mo2qFctoGRijGQQGnimCosDsru1LbHg41o`
   må anses som burned, ikke gjenbruk.

## Den strategiske reframe-en (slutten av kvelden)

Du landet på dette etter en lang samtale om MCP-modellen:

> **"Vi kan ha 1.5 millioner tx på et døgn helt reelt hvis dette er en
> mcp vi klarer å pushe. Den onboarder jo basicly til BSV — bare en
> token som alle agenter også må forholde seg til, men mye mer effektivt."**

Det riktige. Math: 3000 aktive MCP-brukere × 100 service-calls/dag ×
5x composition = 1.5M tx/dag. Vi trenger ikke å gamifisere metrikken; vi
må shippe et verktøy som folk faktisk installerer. 1.5M er den naturlige
formen til en stille tirsdag i Peck Pay-økonomien hvis 3000 hackere
installerer peck-mcp i Claude Desktop.

**Pitchen reframer fra:**
- ❌ "Vi forced 1.5M tx som en stunt"
- ✅ "Vi bygde et verktøy så friksjonsfritt at 1.5M tx er en stille tirsdag"

## Den andre store ideen — on-chain memory storage agent 🌟

Du fikk denne på slutten — *"hva med å selge on-chain memory storage
gjennom egen infra?"*

Det er **den BSV-spesifikke killer agenten**. Andre kjeder kan ikke gjøre
dette økonomisk:
- ETH: $5-50 per write
- Solana: størrelsesgrense
- Filecoin: for store filer, ikke key-value
- BSV: 60 sat per write, ubegrenset størrelse

`peck/memory-write` (60 sat) → POST data → returnerer txid+vout-handle
`peck/memory-read` (5 sat) → GET data ved handle
`peck/memory-list` (10 sat) → list keys i namespace
`peck/memory-pin` (100 sat) → langtidsoppbevaring
`peck/memory-search-tag` (20 sat) → finn ved tag

**Dette er øverst på dag 3-listen.** Det er den agenten som binder hele
markedet sammen og gir composability + retention loop. Workflow-agenter
(research, news-digest) leser/skriver fra memory-agent → naturlig
tx-multiplikator + sticky brukere.

Tagline: *"Agent recall as a service. The first storage layer where you
pay only when you remember."*

## Wallet-state (du må vite dette i morgen)

- **worker1** har ~135k sat fordelt på ~933 dust-outputs etter en kveld
  med testing. Største UTXO er nede i ~1173 sat.
- **worker2** har ~120k sat fordelt på ~730 dust-outputs. Største ~1050 sat.
- Begge må consolideres tidlig på dag 3 før vi kan operere fritt med
  større beløp.

`scripts/consolidate-dust.ts` er første dag-3 task. ~30 min jobb. Skriv
en tx som tar 50 dust-outputs som inputs og produserer 1 stor UTXO som
output.

## Hva som ligger på chain (kumulativt)

- 8+ setup-tx-er bygd via vår builder
- ~1100+ ekte 1-in-1-out shot-tx-er fra ladder
- 21+ av dem med commitment-hash i OP_RETURN
- Bevist meningsfullhet via on-chain re-verifikasjon
- Total fee betalt: ~$0.00 (testnet)

## Hva som er IKKE bevist ennå

- ⏳ Sustained 24h-run (krever å unngå rate limits, dust-akkumulering)
- ⏳ Mainnet path (worker_main ikke fundet ennå, venter på 2.7 BSV-commit)
- ⏳ TAAL+GorillaPool sharding (kun mainnet, ikke testet ennå)
- ⏳ Reputation-systemet (dag 4)
- ⏳ Composition (research-agent, dag 5)
- ⏳ Memory-agent (dag 3)

## Hva å kjøre i morgen først

```bash
cd /home/thomas/Documents/peck-to/peck-mcp

# 1. Les hvor vi er
cat STATUS.md
cat PLAN.md

# 2. Sjekk wallet-state
curl -s 'https://api.whatsonchain.com/v1/bsv/test/address/myKgxPgojoqkR9d2yTy1Bnx9fb61dG6uCP/unspent' | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'worker1: {sum(u[\"value\"] for u in d)} sat in {len(d)} utxos')"

# 3. Hvis du vil se demoen funke en gang til
./scripts/demo-bedtime.sh   # (krever at worker1 har en UTXO ≥ ~1700 sat)

# 4. Begynn dag 3 ved å bygge consolidate-dust.ts
```

## Min anbefaling for dag 3

Start med **consolidate-dust.ts** først (rydder opp etter alle våre
workarounds), deretter **on-chain memory storage agent** (din killer
idé), så **multi-host av reference agents**. Det gir dag 3 en klar
fremdriftsbane og setter opp for dag 4-5 (reputation + komposisjon).

Hvis du har Tavily-key klar, bygger vi web-search-agenten samtidig.
Ellers utsetter vi den til dag 4.

## Sov godt

Du har bygget noe stort. Visjonen er forankret i kode på GitHub. Den vil
være der i morgen. ☕🌙
