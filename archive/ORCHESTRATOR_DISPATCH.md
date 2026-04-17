# Peck-Orchestrator Evolution: Agent Dispatch Guide

Basert på dybdeanalysen "AI Kodeorkestrering og Kvalitetssikring" (95+ kilder).
Hver blokk er en selvstendig oppgave. Prioritert etter umiddelbar verdi for en solo-utvikler med begrenset budsjett.

## Faseoversikt

```
Fase 1 (uke 1):   LiteLLM proxy + multi-provider runner
Fase 2 (uke 2):   Self-healing TDD loop + cascade routing
Fase 3 (uke 3):   Git worktrees + parallellitet
Fase 4 (uke 4):   Observability + morgenrapport 2.0
Fase 5 (uke 5+):  Sandboxing + auto-PR + sikkerhet
```

---

## Blokker og rekkefølge

### Fase 1 — Multi-provider backend (kan kjøres parallelt)

| Blokk | Prosjekt | Fil | Beskrivelse |
|-------|----------|-----|-------------|
| **O1A** | peck-orchestrator | `.claude/tasks/o1_litellm_proxy.md` | LiteLLM proxy-oppsett med Vertex/Anthropic/OpenRouter |
| **O1B** | peck-orchestrator | `.claude/tasks/o1_runner_litellm.md` | Ny runner som bruker LiteLLM i stedet for claude CLI |
| **O1C** | peck-orchestrator | `.claude/tasks/o1_cost_tracker.md` | Token/kostnadssporing per task og per prosjekt |

**Prompt for agent (O1A):**
> Gå til `/peck-orchestrator/`. Les CLAUDE.md og `.claude/tasks/o1_litellm_proxy.md`. Sett opp LiteLLM som proxy-lag for multi-provider LLM-tilgang. Vertex AI (Claude + Gemini) som primær, Anthropic direkte og OpenRouter som fallback. Konfigurer i config.yaml.

**Prompt for agent (O1B):** *(start etter O1A)*
> Gå til `/peck-orchestrator/`. Les CLAUDE.md og `.claude/tasks/o1_runner_litellm.md`. Skriv om runner.py til å bruke LiteLLM Python SDK i stedet for `claude -p` CLI. Behold async-støtte. Les eksisterende runner.py for kontekst.

**Prompt for agent (O1C):** *(kan starte umiddelbart)*
> Gå til `/peck-orchestrator/`. Les CLAUDE.md og `.claude/tasks/o1_cost_tracker.md`. Legg til token- og kostnadssporing i Task-dataklassen og reporter. Vis kostnad per task og totalt i status/rapport.

---

### Fase 2 — Kvalitet og smart routing (sekvensielt: O2A først, deretter O2B)

| Blokk | Prosjekt | Fil | Avhenger av |
|-------|----------|-----|-------------|
| **O2A** | peck-orchestrator | `.claude/tasks/o2_self_healing.md` | O1B |
| **O2B** | peck-orchestrator | `.claude/tasks/o2_cascade_routing.md` | O2A |
| **O2C** | peck-orchestrator | `.claude/tasks/o2_summary_handoff.md` | O1B |

**Prompt for agent (O2A):** *(etter O1B)*
> Gå til `/peck-orchestrator/`. Les CLAUDE.md og `.claude/tasks/o2_self_healing.md`. Implementer self-healing TDD-loop: agent kjører → test feiler → feilmelding mates tilbake → agent fikser → retry. Maks N iterasjoner. Utvid eksisterende verifier.py og _execute_task i orchestrator.py.

**Prompt for agent (O2B):** *(etter O2A)*
> Gå til `/peck-orchestrator/`. Les CLAUDE.md og `.claude/tasks/o2_cascade_routing.md`. Implementer cascade routing: start med billig modell basert på complexity, eskaler til dyrere modell ved feil i TDD-loop. Bruk COMPLEXITY_MODELS fra queue.py og LiteLLM fra runner.

**Prompt for agent (O2C):** *(etter O1B, parallelt med O2A)*
> Gå til `/peck-orchestrator/`. Les CLAUDE.md og `.claude/tasks/o2_summary_handoff.md`. Implementer summary handoff mellom DAG-noder: når en task fullføres, generer et strukturert sammendrag (endrede filer, beslutninger, API-er) som injiseres i neste avhengige tasks prompt.

---

### Fase 3 — Git Worktrees og ekte parallellitet

| Blokk | Prosjekt | Fil | Avhenger av |
|-------|----------|-----|-------------|
| **O3A** | peck-orchestrator | `.claude/tasks/o3_worktree_manager.md` | O1B |
| **O3B** | peck-orchestrator | `.claude/tasks/o3_parallel_same_project.md` | O3A |

**Prompt for agent (O3A):**
> Gå til `/peck-orchestrator/`. Les CLAUDE.md og `.claude/tasks/o3_worktree_manager.md`. Lag en worktree-manager som oppretter/rydder git worktrees per task. Symlink tunge kataloger (node_modules, .venv, __pycache__). Integrer med TaskQueue slik at hver task får sin egen isolerte kopi.

**Prompt for agent (O3B):** *(etter O3A)*
> Gå til `/peck-orchestrator/`. Les CLAUDE.md og `.claude/tasks/o3_parallel_same_project.md`. Fjern begrensningen "én agent per prosjekt" i next_batch(). Bruk worktree-manager til å gi hver parallelle task sin egen worktree. Merge tilbake etter fullføring.

---

### Fase 4 — Observability og rapportering

| Blokk | Prosjekt | Fil | Avhenger av |
|-------|----------|-----|-------------|
| **O4A** | peck-orchestrator | `.claude/tasks/o4_morning_report_v2.md` | O1C |
| **O4B** | peck-orchestrator | `.claude/tasks/o4_trace_logging.md` | O1B |

**Prompt for agent (O4A):**
> Gå til `/peck-orchestrator/`. Les CLAUDE.md og `.claude/tasks/o4_morning_report_v2.md`. Utvid reporter.py med: kostnad per prosjekt, feilfrekvens, cascade-eskaleringer, fullførte PR-er. Generer rapport som kan sendes via Slack webhook eller skrives til fil.

**Prompt for agent (O4B):**
> Gå til `/peck-orchestrator/`. Les CLAUDE.md og `.claude/tasks/o4_trace_logging.md`. Legg til strukturert trace-logging: hvert LLM-kall logges med timestamp, modell, tokens inn/ut, kostnad, varighet. Lagre i JSON lines-format for analyse.

---

### Fase 5 — Sikkerhet og CI/CD

| Blokk | Prosjekt | Fil | Avhenger av |
|-------|----------|-----|-------------|
| **O5A** | peck-orchestrator | `.claude/tasks/o5_docker_sandbox.md` | O3A |
| **O5B** | peck-orchestrator | `.claude/tasks/o5_auto_pr.md` | O3A |
| **O5C** | peck-orchestrator | `.claude/tasks/o5_secret_management.md` | O5A |

**Prompt for agent (O5A):**
> Gå til `/peck-orchestrator/`. Les CLAUDE.md og `.claude/tasks/o5_docker_sandbox.md`. Legg til Docker-sandboxing for agentutførelse: bygg et minimalt image, mount worktree read-write, cap-drop ALL, ingen nettverksegress unntatt allowlist. Integrer med runner.

**Prompt for agent (O5B):** *(etter O3A)*
> Gå til `/peck-orchestrator/`. Les CLAUDE.md og `.claude/tasks/o5_auto_pr.md`. Etter task fullføring i worktree: commit, push branch, opprett PR via `gh pr create` med AI-generert beskrivelse. Human-in-the-loop review før merge.

**Prompt for agent (O5C):** *(etter O5A)*
> Gå til `/peck-orchestrator/`. Les CLAUDE.md og `.claude/tasks/o5_secret_management.md`. Implementer JIT secret injection: task-filer deklarerer hvilke env-vars de trenger, orchestrator injiserer kun disse i sandbox. Aldri eksponer full .env.

---

### Fase 6 — AI-drevet brukertesting (Playwright + BRC-100 wallet)

| Blokk | Prosjekt | Fil | Avhenger av |
|-------|----------|-----|-------------|
| **O6A** | peck-orchestrator | `.claude/tasks/o6_browser_tester.md` | O2A, O5A |
| **O6B** | peck-orchestrator | `.claude/tasks/o6_preview_deploy.md` | O6A |
| **O6C** | peck-orchestrator | `.claude/tasks/o6_wallet_test_harness.md` | O6A |
| **O6D** | peck-orchestrator | `.claude/tasks/o6_visual_regression.md` | O6A |

**Prompt for agent (O6A):**
> Gå til `/peck-orchestrator/`. Les CLAUDE.md og `.claude/tasks/o6_browser_tester.md`. Bygg en `browser_tester.py` modul som bruker Playwright headless til å kjøre AI-genererte E2E-tester. Agenten tar en task-beskrivelse + en URL, genererer testplan, kjører Playwright, og evaluerer resultat med LLM-as-a-judge. Integrer som nytt verifiseringssteg i verifier.py.

**Prompt for agent (O6B):** *(etter O6A)*
> Gå til `/peck-orchestrator/`. Les CLAUDE.md og `.claude/tasks/o6_preview_deploy.md`. Lag en `preview_deploy.py` som spinner opp ephemeral Cloud Run revisjon fra worktree-branch for å teste mot. Returner preview-URL som browser_tester kan bruke. Rydd opp etter test.

**Prompt for agent (O6C):** *(etter O6A)*
> Gå til `/peck-orchestrator/`. Les CLAUDE.md og `.claude/tasks/o6_wallet_test_harness.md`. Bygg en test-harness for BRC-100 wallet-operasjoner: støtte for peck-desktop headless (Electron --headless som ekte wallet) OG en testnet mock-wallet for CI. Begge skal kunne signere TX, kryptere/dekryptere (BRC-42), og håndtere identity_key. Integrer med browser_tester slik at Playwright-tester kan gjøre wallet-operasjoner.

**Prompt for agent (O6D):** *(etter O6A)*
> Gå til `/peck-orchestrator/`. Les CLAUDE.md og `.claude/tasks/o6_visual_regression.md`. Legg til visuell regresjonstesting: ta screenshots før/etter kodeendring, bruk LLM-as-a-judge (ikke piksel-diff) til å evaluere om UI-endringer er intensjonelle vs regresjoner. Lagre baseline-screenshots i reports/.

---

## Avhengighetsgraf

```
O1A (LiteLLM proxy) ──┐
O1B (LiteLLM runner) ──┤── O2A (self-healing) → O2B (cascade)
O1C (cost tracker) ────┤── O4A (rapport v2)     ↓
                       ├── O2C (summary handoff) ├── O6A (browser tester) → O6B (preview deploy)
                       ├── O3A (worktrees) → O3B (parallel same-project)  → O6C (wallet harness)
                       │                   → O5A (docker) → O5C (secrets) → O6D (visual regression)
                       │                   → O5B (auto-PR)                   ↑
                       └── O4B (trace logging)                          O5A + O2A
```

## Tips for agentene

1. **Les CLAUDE.md først** — den har stack, filstruktur, konvensjoner
2. **Les eksisterende kode** — orchestrator.py, runner.py, task_queue.py, verifier.py, reporter.py
3. **Ikke endre andre prosjekter** — hold deg til peck-orchestrator/
4. **Test lokalt** — python3 orchestrator.py status / next / run --dry-run
5. **Commit med beskrivende melding** — prefix med blokknummer (f.eks. `feat(O1A): add LiteLLM proxy config`)
