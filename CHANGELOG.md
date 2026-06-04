# Changelog

## 0.6.1

- **Fix: writes now broadcast at 100 sat/KB, not 1.** The `bitcoin-agent-wallet`
  fee-policy override (wallet-toolbox default `1 sat/KB` → peck `100 sat/KB`)
  shipped in 0.5.2, but this package pinned `^0.5.0` with a lockfile frozen at
  0.5.0 — older than the fix — so `npm ci` / Docker builds broadcast at
  `1 sat/KB` and risked slow or non-inclusion. Pin bumped to `^0.5.3` (lockfile
  too); verified on-chain that the change generator now bills at `value:100`.
  0.5.3 also surfaces `result.beef` on the synchronous broadcast path.
- Add vitest byte-level tests for the Bitcoin Schema builder (pipe separator
  pushed as `017c`, not a bare `0x7c` opcode; MAP/AIP namespaces; field order).
- Add GitHub Actions CI (`build` + `test` on every PR/push).
- Docs: corrected tool count (42).

## 0.6.0

- Agent-wallet write path: every write routes through
  `bitcoin-agent-wallet.broadcast()` (BRC-100 identity from the OS keychain).
