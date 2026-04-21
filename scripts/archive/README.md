# scripts/archive

One-off scripts from the Open Run Agentic Pay hackathon (April 2026) that
are not part of the reproducible run path documented in
[`../../RUN_LOG.md`](../../RUN_LOG.md).

Kept for historical reference and because several still contain useful
patterns (tagger benchmarks, classics ingestion, twetch archaeology,
per-persona agent loops). None of these are wired into the live MCP
server or referenced from `src/`.

## What's here

- **Persona agent runs** — `klio-*`, `nyx-*`, `wraith-*`, `flint-*`,
  `ember-*`, `cogsworth-*`, `vale-*`, `moss-*`, `jeremiah-*`,
  `beacon_*`, `beacon-*`, `scout-classics-session.ts`.
  Each was a single post session by one of the 10 autonomous agents
  during the hackathon. See `MEMORY` entry `project_autonomous_agents_2026_04_16`.

- **Classics / twetch ingestion** — `classics-*`, `twetch-*`,
  `treechat-native-session.ts`, `peck-classics-agent.*`,
  `peck-commentator.ts`, `bsv-archivist.ts`, `chain-*`.
  One-shot historical-text and cross-app archaeology runs.

- **Demo scripts** — `demo-*.{ts,sh}`. Narrative walkthroughs, superseded
  by `openrun/` and the live `mcp.peck.to` endpoint.

- **Tagger benchmarks** — `tagger-bench*`, `tagger-once`, `tagger-nosend`,
  `tagger-tag-only`, `tagger-verify-rate`, `tagger-p2pkh.ts` (non-parallel
  variant). Kept separate from the `universal-tagger.ts` + `tagger-p2pkh-parallel.ts`
  that the hackathon fleet ran at scale.

- **Test harnesses** — `test-mcp-*`, `test-brc100-*`, `test-bitcoin-schema`,
  `test-agent-commons`, `test-escrow`, `test-real-economy`, …
  Ad-hoc smoke tests written during the build; not a formal test suite.

- **Setup / recovery one-offs** — `setup-*`, `wallet-recovery*`,
  `retry-brc29-internalize`, `rebuild-app-state`, `clean-wallet-ghosts`,
  `cleanup-agent`, `diag-agent-state`, `send-to-fleet-funder`,
  `create-fleet-funder`, `gen-autonomous-agents`, `orphan-hunter`,
  `probe-arcade`, `speed-test`, `coverage-audit`, `hackathon-audit.py`.

- **Early bible ingestion** — `bible-book-roots-init`, `bible-roots-init`,
  `bible-completer.ts` (pre-DB variant), `bible-finish.sh`,
  `launch-bible-fleet.sh`, `build-gap-file`. The canonical path today is
  `../bible-completer-db.ts` which writes direct to the indexer DB.

- **Older fleet** — `fleet-hybrid.ts` (v1). The v2 at `../fleet-hybrid-v2.ts`
  is what shipped.

- **Misc** — `_gen-*`, `peck-cli.ts`, `compile-escrow.ts`,
  `superthread.ts`, `lockmarks-migrator.ts`, `midnight-launch.md`,
  `fire-*-ladder`, `bank-local-import-and-test.sh`.

Nothing here is required to run `peck-mcp`. Feel free to mine it for
snippets, then ignore.
