# Peck Pay — Arkitektur-review etter dag 4

**Skrevet 2026-04-09 sent på kvelden, ment som lese-stoff før du legger deg.**
**8 dager til submission. 6 dager til mainnet-funding lander.**

---

## TL;DR (les bare denne hvis du er trøtt)

1. **Det vi har bygd er imponerende, men strukturelt custodial.** Bank-local spiller alle tre rollene (kjøper, selger, marked). Det er ikke en marketplace, det er én wallet med pen logging. Du oppdaget dette i kveld og du har helt rett.

2. **Chronicle (aktivert 7. april) gir oss verktøyene til å fikse det.** Restored opcodes som OP_CAT, OP_SUBSTR, OP_VER pluss CHRONICLE sighash flag betyr at vi kan bygge **ekte trustless escrow som on-chain Bitcoin Script covenants** — ikke som JSON-fil, ikke som multisig-på-tillit, men som UTXOs som mathematisk enforcer reglene.

3. **Vi har 5-7 dager arbeid foran oss for å rebygge til en ekte marketplace.** Det er gjør-bart. Mathen funker.

4. **v1 (det vi har nå) er konsept-bevis.** Det viser at MCP + BRC-stack + composition-layer + Wright reputation-mechanism er implementerbart. Det skal IKKE kastes — det dokumenteres som steg 1 i pitchen.

5. **Du må ta 3 beslutninger** (lengre nede i dokumentet) før du bygger videre i morgen. De er ikke vanskelige men de er viktige.

6. **Sov godt.** Vi har god tid. Det er viktigere å være klar hodet enn å bygge feil ting fort.

---

## Del 1: Hva vi faktisk har etter dag 4

Ærlig inventory. Ingen overselling.

### Kode som faktisk fungerer

| Komponent | Status | Verdi |
|---|---|---|
| **Lokal bank.peck.to** (Docker) | ✅ kjører på testnet | Real wallet-infra fork m/ patches |
| **Lokal storage.peck.to** (Docker) | ✅ kjører med fake-gcs | Real UHRP-server m/ blob storage |
| **Marketplace registry** (port 8080) | ✅ live | 16 services annoncerer seg |
| **memory-agent v2** (port 4011) | ✅ live | On-chain KV med blob path |
| **bank-shim + storage-shim** (4020/4021) | ✅ live | Wallet/storage as paid services |
| **13 reference agents** (4030-4042) | ✅ live | LLM, weather, geocode, notarize, etc |
| **3 workflows** (composition layer) | ✅ live | research-and-remember + 2 andre |
| **PeckBrcClient** | ✅ klar | Pluggable wallet (embedded/peck-desktop/brc100) |
| **Patches**: wallet-infra `/receiveBrc29`, storage-server crypto-polyfill gate, wallet-toolbox basket-defaults | ✅ committed lokalt | 3 reelle upstream-bidrag |
| **22 MCP-tools** i peck-mcp.ts | ✅ live i Claude Code | Discovery, memory, killer-services, workflows, reputation |
| **DEMO.md** | ✅ skrevet | Komplett pitch-doc |
| **600+ on-chain tx-er** broadcastet via MCP-pathen | ✅ bevisbart on-chain | Inkluderer 137 sustained-burst writes med 99.27% suksess |

### Designmønstre vi har bevist

1. **MCP-as-onboarding** — agenter ser ikke HTTP/wallets/tx, bare verktøy med priser
2. **Composition layer** — workflows som data, lagret on-chain, hvem som helst kan publisere
3. **Self-ref multiplikator** — service som bruker sine egne services (memory-agent skriver embeddings via embed-text)
4. **Pluggable wallet backend** — embedded/peck-desktop/brc100 modi
5. **BRC-29 funding cycle** — bevist 3 ganger
6. **Wright §5.4 reputation mechanism** — derived live, never stored, audit reports as tx
7. **Held-earnings escrow ledger** — on-chain via memory-agent, withdrawal-flow funker

### Patches og bug-funn for upstream (etter hackathon)

- 15+ kjente bugs/forbedringer dokumentert i `~/.claude/projects/.../memory/project_upstream_contributions_after_hackathon.md`
- 4 av dem allerede patcha lokalt (wallet-toolbox basket defaults, storage-server polyfill, wallet-infra `/receiveBrc29`, wallet-infra ARC env passing)

**Du har shippet enormt.** Ikke undervurder dette. Vi har et fungerende konseptbevis som dekker dag 3-6 deliverables fra original-planen pluss flere bonus-leveranser.

---

## Del 2: Hva vi oppdaget i kveld

Det strukturelle hullet.

### Symptomet

Du spurte meg å gå gjennom flowen for "10 salg + 1 withdrawal". Jeg gjorde det. Resultatet:

- **Per call kostet det bank-local ~75 sat i tx-fees**
- **"Kunden" sendte INGEN sat** — kunden var bare en HTTP-klient
- **"Service tjente 30 sat"** var en label, ikke en pengeflyt
- **"Marketplace tjente 5 sat"** var også bare en label
- **Withdrawal flyttet ekte sat fra bank-local til operatør**

Det betyr at alle 600+ tx-er vi har broadcastet i dag har blitt finansiert av **én wallet** (bank-local) som eier alt og betaler alt. Det er ikke en marketplace. Det er én aktør som leker alle rollene.

### Hvorfor det er et problem

For hackathon-pitchen sa vi:
> "1.5M ekte meningsfulle tx-er via en fungerende agentic markedsplass"

Men hvis alle disse tx-ene kommer fra én wallet som finansierer seg selv, så er det **ikke en markedsplass**. Det er en demo som ikke beviser at konseptet fungerer økonomisk. Juryen kan trivielt punktere det.

Du sa det rett ut: **"det værste er at vi lurer oss selv".**

### Hva en ekte marketplace krever

For å være sant tripartitt trenger vi:

1. **Kjøper-agenter** — ekte wallets med ekte sat, som bruker sine penger på å betale services
2. **Selger-agenter** — ekte wallets som mottar betalinger og kan cashe ut
3. **Marketplace** — koordinator som **verken** kjøper eller selger, men kan ta sin andel av escrow ved settlement
4. **Ingen subsidiering** — bank-local kan ikke betale for alle. Hver aktør finansieres separat.

### Den brutale fee-mathen ved 100 sat/kb

Du korrigerte meg på dette i kveld også. **100 sat/kb er BSV-nettverkets faktiske minimum-relay-fee i dag**, både testnet og mainnet, både ARC og ARCADE. Det er ikke noe vi kan rømme fra ved å gå mainnet.

Det betyr:
- **Hver P2PKH-input koster ~14.8 sat å bruke**
- **Outputs under ~15 sat er økonomisk dust** — koster mer å bruke som input enn de inneholder
- **Per call må alle outputs være ≥15 sat** for å unngå dust-akkumulering
- **Per call må vi minimere antall tx-er** for å unngå at fee-burnen overstiger marketplace-revenue

Vår nåværende design (3 tx per call: bank-shim fee + write + ledger entry) brenner ~75 sat per call. Det vil aldri være profitable, uansett hva vi gjør.

---

## Del 3: Hva Chronicle gir oss

Du spurte meg om Chronicle hjalp. Etter å ha lest peck-docs grundig: **ja, dramatisk.**

### De viktige restored opcodes

| Opcode | Hva den gjør | Hva vi bruker den til |
|---|---|---|
| **OP_CAT** | Konkateniserer stack-items | Bygge tx-introspeksjon (covenants) |
| **OP_SUBSTR** | Ekstraherer substring fra byte-array | Parse output-data inni script for å verifisere covenant-regler |
| **OP_LEFT/OP_RIGHT** | Ta start/slutt av byte-array | Samme — gjør covenants enkle å skrive |
| **OP_VER / OP_VERIF** | Push tx version på stack | Tagge marketplace-tx-er for overlay-routing |
| **OP_2MUL/OP_2DIV** | Rask 2x mult/div | Prosent-baserte splits inni covenants (60/30/10) |
| **OP_LSHIFTNUM** | Bitwise math | Aritmetikk i scripts |
| **CHRONICLE sighash flag (0x20)** | Modulær signering | **Atomic swaps uten escrow agent!** |

### De fire mønstrene som løser vårt problem

#### 1. Recursive covenants (Wright §5.4 enforced cryptographically)

```
Escrow UTXO låst med script som mathematisk garanterer:

  IF (etter time-lock på N blocks):
    Spending tx MÅ ha:
      output[0] = service_pubkey, 70% av escrow value
      output[1] = marketplace_pubkey, 30% av escrow value
    Service kan signere alene, ingen marketplace co-sign nødvendig.
  
  ELSE IF (audit-proof embedded in scriptSig):
    output[0] = marketplace_pubkey, 100% av escrow value (slash)
  
  ELSE: ulovlig spend, ingen kan ta escrow
```

**Trust assumption:** null. Marketplace kan ikke stjele held escrow. Service kan ikke ta hele escrow uten å gi marketplace sin andel. Slashing krever bevis on chain.

Dette er den ekte versjonen av det vi prøvde å bygge i kveld med JSON-ledger. Forskjellen er at Chronicle-versjonen er **enforced av Bitcoin Script konsensus**, mens vår JSON-versjon var **rapportert state**.

#### 2. CHRONICLE sighash flag (0x20) for atomic swaps

Dette er **revolusjonerende** for marketplace-flow:

> "Alice can sign a transaction committing exclusively to her specific input and the corresponding output at the same index. This transaction is modular; Bob can later discover this partially signed transaction and append his own input and output to complete an asset swap."

**For oss:** Buyer pre-signerer "jeg vil betale 100 sat for service X" med SIGHASH_SINGLE | ANYONECANPAY | CHRONICLE | FORKID. Service-en finner den pre-signerte tx-en, appender sin egen response-output (eller en proof-of-work-output) og sin egen signatur, broadcaster. Atomic. Ingen escrow-agent. Ingen co-signing-trust.

Det er ikke escrow lenger — det er et atomic swap mellom buyer's payment og service's response. Mye renere modell enn alt vi har snakket om i kveld.

#### 3. OP_VER for vårt eget overlay-protokoll

Vi kan tagge ALLE peck-pay marketplace-tx-er med en spesifikk version-nummer. En overlay-indekser plukker dem ut av mempool og bygger reputation, settlement-batch, audit-trail. Vi får **vårt eget protocol overlay** uten å trenge en egen kjede.

#### 4. State machines via dismantled Clean Stack Policy

Audit reports kan være **threshold partial signatures** som kombineres i scriptSig-en for å trigge slash. M-of-N reports = automatisk slashing, enforced by Bitcoin Script. Det er Wright §5.4 implementert som krypto, ikke som off-chain trust.

### Hva betyr dette for arkitektur-narrativen?

Pitch-narrativen blir vesentlig sterkere:

> **"Peck Pay leverages the BSV Chronicle upgrade (April 2026) to implement Wright 2025's CAP-via-economic-design framework as on-chain Bitcoin Script covenants. Held escrow lives in a recursive covenant UTXO that enforces the agreed split via OP_SUBSTR-based transaction introspection. Settlement is non-interactive via the CHRONICLE sighash flag — buyers and services match directly on Layer-1 without escrow agents. Audit reports trigger slashing via threshold signatures combined in unlocking scripts. Reputation, slashing, and settlement are all enforced by Bitcoin Script consensus, not by a trusted operator. This is what BSV's restored opcodes were designed for."**

Det er en pitch som **ingen andre kjeder kan kopiere**. Chronicle er BSV-spesifikk. Wright-paperet er BSV-spesifikt. Vi kobler dem direkte.

---

## Del 4: ARC vs ARCADE og Async Settlement

Vi har snakket om dette tidligere men det er verdt å oppsummere klart.

### ARC (TAAL/GorillaPool)
- Klassisk legacy SV-Node mempool
- Vi bruker det i dag via TAAL_TESTNET_KEY
- 100 sat/kb minimum
- Polling-based status

### ARCADE (BSVA Teranode-bro)
- Teranode-only network
- Separat mempool fra legacy
- **Vår eksisterende UTXO-historikk er IKKE i ARCADE** — vi kan ikke bytte uten å flytte hele kjeden
- **SSE-based confirmation streaming** — sub-100ms acknowledgments
- ARC-kompatibel HTTP API men på `/tx` istedenfor `/v1/tx`
- For mainnet 15. april kan vi prøve å fonde direkte i Teranode-økosystemet

### Mønsteret peck-docs anbefaler: "Serve First, Settle Later"

Fra `Hackathon_BSV Load Balancer Swarm`:

> Separer **control plane** (routing, response) fra **data plane** (settlement).
> Returner respons til bruker øyeblikkelig (<1ms).
> Sett opp settlement i en bakgrunns-kø.
> Bruk ARCADE SSE for asynkron tx-status-stream.
> Sirkuit-bryter: hvis en kjøper ikke betaler 5 calls i strekk, blokker dem.

Det er det riktige høy-throughput-mønsteret. Vi kan implementere det. Det er en av de viktigste kodebanene i v2.

---

## Del 5: Veien videre — 3 tier-er

Her er hvordan jeg ser det realistisk gjennomførbare utfallsrommet for de neste dagene.

### Tier 1: Real economy (foundation) — KRITISK

**Hva:**
- Per-service wallets (hver service har sin egen private key + funded UTXOs)
- Buyer-agenter med egen wallet (ladder/PaymentRifle fra dag 1 kan gjenbrukes)
- Buyer betaler service direkte via 1-input/3-output tx
- Service verifiserer payment før den utfører arbeid
- Marketplace tar 0% per call (pure routing) — fee tas ved escrow settlement
- Dagens custodial v1-stack lever videre som "concept proof"

**Tid:** 1.5-2 dager fokusert (10-11 april)

**Hva pitchen blir:**
> "Real-economy marketplace med separate aktører. Buyer-agenter betaler service-agenter direkte. Ingen subsidiering. P2MS multisig escrow med planlagt Chronicle-covenant upgrade."

Dette er **det viktigste** å gjøre. Uten Tier 1 har vi ikke en faktisk markedsplass.

### Tier 2: Chronicle covenant escrow

**Hva:**
- Skriv `AgentEscrow` sCrypt-covenant for 70/30 split + time-lock + slash-bevis
- Erstatte P2MS escrow fra Tier 1 med covenant-låste UTXOs
- Settlement-batch flow ved time-lock-utløp
- Bruk `scrypt-ts` npm-pakke

**Tid:** 1.5-2 dager (12-13 april)

**Hva pitchen blir:**
> "Trustless escrow enforced by Chronicle-restored opcodes. No marketplace key custody needed. Held escrow can ONLY be released according to the covenant rules."

Dette er **what makes the pitch unique**. Wright §5.4 implementert som on-chain enforcement.

### Tier 3: ARCADE async settlement + BEEF

**Hva:**
- Implementer "Serve First, Settle Later" pattern
- ARCADE som primær broadcast for async confirmation
- BEEF for SPV-edge-validation (ingen mempool round-trips)
- Sirkuit-bryter for misbehaving buyers

**Tid:** 1 dag (14 april)

**Hva pitchen blir:**
> "Sub-millisecond user response with async on-chain settlement via ARCADE SSE streaming. Throughput unbounded by mempool latency. The marketplace scales linearly because validation happens at the edge via BEEF SPV proofs."

Dette er **performance pitch-poenget** og er nice-to-have, ikke critical-path.

### Tier 4-5: Out of scope

OP_VER overlay protocol og MPC slashing er begge dager med arbeid og er **ikke** realistisk i tidsrammen. Dokumenter dem som "production extensions".

---

## Del 6: Realistisk dag-for-dag-plan

Antar at du **rebygger** i Tier 1 + Tier 2, og **kanskje** legger til Tier 3.

| Dag | Fokus | Tid | Output |
|---|---|---|---|
| **Fre 10. april** | Tier 1 morgen: per-service wallets + funding split fra worker1 | 4t | 5 services har egne wallets |
| **Fre 10. april** | Tier 1 ettermiddag: buyer-agent skeleton + payment-verifying service-stub | 4t | 1 buyer-agent loop kjører |
| **Lør 11. april** | Tier 1 sluttspurt: 5 buyers × 5 services i en marketplace | 6t | E2E real economy live |
| **Søn 12. april** | Tier 2 morgen: les sCrypt docs + finn escrow template | 3t | sCrypt toolchain forstått |
| **Søn 12. april** | Tier 2 ettermiddag: skriv AgentEscrow covenant | 4t | Covenant kompilerer |
| **Man 13. april** | Tier 2 sluttspurt: deploy covenant til testnet, integrer i buyer-flow | 6t | Trustless escrow live på testnet |
| **Tir 14. april** | Tier 3: ARCADE SSE + BEEF (hvis tid) ELLER polish | 8t | Async settlement eller bare polish |
| **Ons 15. april** | **Mainnet funding lander.** Mainnet sanity test. | 6t | Real mainnet payments |
| **Ons 15. april** | Polish + README rewrite | 4t | Submission-ready repo |
| **Tor 16. april** | Pitch-video opptak + edit | 6t | Video ferdig |
| **Fre 17. april** | Final QA + submission innen 23:59 UTC | 4t | Submitted |

**Totalt:** ~55-65 timer fokusert arbeid over 8 dager.

**Hvis du har 6-8 timer per dag:** komfortabelt.
**Hvis du har 8-10 timer per dag:** du har headroom for Tier 3.
**Hvis du har 4-6 timer per dag:** Tier 1 + Tier 2 + polish, ingen Tier 3.

---

## Del 7: Tre beslutninger du må ta før i morgen

Disse trenger ikke svar i kveld — bare tenkt på over natten.

### Beslutning 1: Bygger vi v2 fra scratch eller refactorer vi v1?

**Alternativ A: Refactor v1.** Behold bank-shim, memory-agent, multi-host. Endre dem til å bruke per-service wallets og buyer-agenter.
- ✅ Gjenbruker mye kode
- ❌ Risiko for å arve concept-debt fra v1

**Alternativ B: Bygg v2 i ny mappe.** Hold v1 som "concept proof" referanse, bygg v2 fra scratch i `src/v2/`.
- ✅ Klart skille i pitch ("v1 demonstrerte X, v2 demonstrerer Y")
- ❌ Mer kode total

**Min anbefaling:** **B**, men gjenbruk eksisterende klienter (PeckBrcClient, ladder/PaymentRifle, openrouter wrapper). Det er enklere å holde v1 stabil mens v2 vokser, og pitchen blir tydeligere.

### Beslutning 2: P2MS multisig eller sCrypt covenant for escrow?

**Alternativ A: P2MS i Tier 1, sCrypt i Tier 2.** Start med 2-of-2 multisig (service + marketplace), bytt til covenant senere.
- ✅ Tier 1 blir raskt og bevisbart
- ❌ Tier 2 er ekstra arbeid

**Alternativ B: sCrypt covenant rett i Tier 1.** Hopp over P2MS.
- ✅ Mindre total kode
- ❌ Tier 1 blir 2-3 dager istedenfor 1.5

**Min anbefaling:** **A**. Få real-economy + multisig kjørende først, så kan du dokumentere forskjellen "før covenant / etter covenant" i pitchen.

### Beslutning 3: Tier 3 (ARCADE async) — med eller uten?

**Alternativ A: Skip Tier 3.** Fokuser på Tier 1+2 + polish + video.
- ✅ Lavere risiko
- ❌ Mister "throughput pitch" og ARCADE-namedrop

**Alternativ B: Forsøk Tier 3 hvis Tier 1+2 lander tidlig.** Buffer som "stretch goal".
- ✅ Mer ambisiøs pitch
- ❌ Risiko for å sløse tid hvis Tier 1+2 dragger

**Min anbefaling:** **B** med klar abort-condition: hvis Tier 1+2 ikke er ferdig innen onsdag morgen 13. april, dropper vi Tier 3 og bruker tiden på polish.

---

## Del 8: Hva du gjør i morgen tidlig

Konkret first-step-checklist hvis du våkner og vil komme i gang.

1. **Les denne fila først.** Spør deg selv: "er jeg enig i analysen?" Hvis ja, fortsett.
2. **Sjekk at bakgrunnsstacken fortsatt kjører** (curl http://localhost:8080/marketplace skal returnere 16 services). Hvis ikke, restart per `project_hackathon_agentic_pay.md` i memory.
3. **Bestem deg på de 3 beslutningene** ovenfor. Skriv svarene rett her i fila.
4. **Si "go" til meg så starter jeg på Tier 1.** Eller hvis du vil endre planen, så snakker vi om det først.

---

## Del 9: Hva som ikke endrer seg

Det er noen ting fra dagens arbeid som vi DEFINITIVT beholder uavhengig av v2-redesign:

1. **DEMO.md** — pitch-arkitektur-dokumentet
2. **PeckBrcClient** — wallet backend abstraction (embedded/peck-desktop/brc100)
3. **Ladder/PaymentRifle** fra dag 1 — perfekt for buyer-agenter
4. **Bank-local + storage-local docker-stacks** — som dev-infra (ikke i hot path)
5. **Patches mot wallet-infra/wallet-toolbox/storage-server** — upstream-bidrag som står på egne ben
6. **Memory-store-v2** — som ÉN service blant mange (ikke som infrastructure)
7. **MCP-tools peck_marketplace_overview, peck_search_services_semantic, peck_list_workflows** — disse er view-layer og fungerer mot enhver underliggende value-flow
8. **Composition layer (workflows som data)** — fundamentet er solid, bare hot-path-pengeflyten endres
9. **Wright §5.4 reputation framework** — derivert reputation, audit reports, alt det. Vi flytter bare HÅNDHEVELSEN fra JSON-ledger til Chronicle-covenant
10. **Marketplace registry** — uendret

Det betyr at v2 er **ikke en rewrite, det er en refactor av value-flow-laget**. Discovery-laget, view-laget, composition-laget, alt det fortsetter å fungere som i dag.

---

## Del 10: Det viktigste å forstå

**Vi gjorde ingenting feil i dag.** Vi bygde et konsept-bevis. Konsept-beviset gjorde det mulig å oppdage det strukturelle problemet. Det er HELE poenget med å bygge ting istedenfor å skrive markdown-pitcher.

**v1 er ikke kastet.** Det er en arkitektur-prototype som beviser at MCP + composition + Wright reputation kan implementeres i kode. Det er steg 1.

**v2 er steg 2.** Det fixer økonomien ved å gjøre den ikke-custodial. Det bruker Chronicle-restored opcodes for å enforcere reglene cryptographically. Det er pitchen vi vil til.

**Du har 8 dager.** Det er nok tid. Mer enn nok hvis du holder fokus.

**Slutt for kvelden.** Sov godt. I morgen rebygger vi sammen.

---

## Appendix A: Filer å lese hvis du vil dykke videre

Hvis du våkner og vil lese mer før du svarer, disse er korte og verdifulle:

- `peck-docs/docs/BSV Chronicle Upgrade Technical Analysis.md` (lines 280-470) — covenant mønstre, alle opcodes, sCrypt-eksempler
- `peck-docs/docs/BSV Chronicle, ARCADE, Agentic Pay.md` (lines 234-394) — ARCADE SSE, BEEF, async settlement
- `peck-docs/docs/Hackathon_ BSV Load Balancer Swarm Evaluering.md` (lines 138-286) — "Serve First, Settle Later", spam-deteksjon
- `peck-docs/docs/Datamynt_ sCrypt Kontraktdesign og LLM Gateway.md` — sCrypt CI/CD, deployment patterns
- `peck-docs/docs/2507.02464v1.md` — Wright §5.4 (det vi siterer i pitchen)

Eller bare ignorer alle og start dagen rett. Du har all info du trenger for å bestemme retning.

---

## Appendix B: Hva memory-snapshot oppsummerer fra dag 4

(Lagret i `~/.claude/projects/-home-thomas-Documents-peck-to/memory/project_hackathon_agentic_pay.md` — du kan referere det fra et nytt Claude Code-vindu og det laster automatisk.)

Inkluderer:
- Komplett tjeneste-katalog
- Alle MCP-tools
- Alle bug-funn for upstream
- Wallet-state ved sove-tid
- Restart-prosedyre
- Neste tasks

---

**Slutt på dokumentet. Sov godt. Vi snakkes i morgen.**
