# Changelog

## Unreleased

- **Read tools use the overlay's `/v2` read model.** `peck_feed`, `peck_recent`,
  `peck_search`, `peck_thread`, `peck_post_detail`, `peck_user_posts` and
  `peck_profile` now return the hydrated `peck-view/v1` objects the overlay
  serves under `/v2` (the ones peck.to renders), so an agent sees the same
  author name, handle, avatar, counts, media and repost/quote target as a person.
  Output shape changes agents will notice:
  - Lists are `{ items, next }` instead of `{ status, total, offset, data }`;
    posts are camelCase views (`text`, `createdAt`, `author.displayName`,
    `counts.replies`, ...) instead of raw index rows. `content_tsv`,
    `map_content` and base64 attachment blobs are gone; `media[]` carries URLs.
  - `peck_thread` returns `{ post, parent, replies, repliesTruncated }`. The old
    `parent` was the requested post; it is now `post`, and `parent` is the post
    it replies to.
  - `peck_post_detail` returns `{ post, parent }`.
  - `peck_user_posts` returns `{ author, keys, items, next }` and includes posts
    signed by every key of the identity. There is no `total`.
  - `peck_profile` keeps its fields and adds `profile` (the overlay's profile
    view) and `keys_counted`; totals and the sample now cover all keys of the
    identity. `address` also accepts a public key or `@handle` here and in
    `peck_user_posts`.
  - `tag` is an exact match (it was a substring match).
  - New optional `cursor` argument on `peck_feed`, `peck_recent` and
    `peck_user_posts`: the `next` of the previous page, sent back unchanged.
    `offset` still works (max offset + limit 1000). `limit` is capped at 100.
  - Unchanged, still on `/v1`: `peck_trending`, `peck_stats`, `peck_apps`,
    `peck_follows`, `peck_friends`, `peck_messages`, `peck_payments`,
    `peck_functions`, `peck_function_check_calls`, and the recipient lookups of
    the write tools. Post totals in `peck_profile` also come from `/v1`.
  - An overlay without `/v2` routes (a self-hosted `PECK_READER_URL`, or a
    rolled-back overlay) is detected and served from `/v1` with the previous output.
- **Fix: the wallet can keep writing.** wallet-toolbox only records merkle
  proofs when its Monitor runs, and nothing started it, so every post chained on
  unproven parents until `createAction` failed with `Maximum BEEF depth
  exceeded` (limit 12). peck-mcp now runs the Monitor's `CheckForProofs` task at
  start and every 10 minutes (`proof-sync.ts`). No other Monitor task runs: in
  particular `TaskSendWaiting`, which would broadcast queued delayed PeerPay
  payments, stays off.
- **Fix: a broken install no longer looks like a missing identity.** When the
  key loads from the keychain but the wallet store fails to open (for example
  better-sqlite3 built for Node 22 running under Node 24), `peck_identity_info`
  now reports the key's `identity_key` and `address`, `keychain_key_found`,
  `wallet_error`, and a concrete fix. It no longer tells the caller to generate
  a fresh key, which would replace the identity. Write tools that hit the
  failure return the same fix (`wallet-diagnostics.ts`).
- `peck_identity_info` reports `wallet_storage` and `wallet_balance_sats`, and
  says to fund the wallet with a BRC-29 PeerPay payment: a plain send to the
  P2PKH address is not picked up by the wallet. `peck_balance` says it reads the
  P2PKH address only.

## 0.7.0

- **Hosted read-only mode.** The HTTP transport now serves without loading a
  wallet and advertises only the 17 read tools (`hosted.ts`). Write tools return
  an install hint instead of "wallet unavailable", and `peck_messages` refuses a
  `signing_key` on the hosted server. `PECK_MCP_ALLOW_WRITES=1` restores the full
  set for HTTP on your own machine; stdio (the npm install path) is unchanged.
- The same process serves the landing page on `/` for browsers, JSON for agents
  and curl, plus `/llms.txt`, `/robots.txt` and `/sitemap.xml`. This is what
  `https://mcp.peck.to` runs, so `claude mcp add --transport http peck
  https://mcp.peck.to/mcp` works with no install.
- Listed in the MCP Registry as `io.github.kryp2/peck-mcp` (`server.json`,
  `mcpName` in package.json, tag-driven publish workflow).
- Server version now comes from package.json instead of a hardcoded `3.1.0`.

## 0.6.2

- **Fix: the identity tools now send the register token.** `identity.peck.to`
  `/v1/register` is token-locked, but only `peck_profile_tx` was ever given the
  `Authorization` header (in #21). `peck_register_identity` and the registry
  layer of `peck_set_identity` called it with no header at all, so both failed
  with `401 internal token required` whether or not `IDENTITY_REGISTER_TOKEN`
  was set. All three call sites now share one `identityRegisterHeaders()` helper.
- When the token is unset, those two paths fail with an explicit error naming
  the env var, instead of an opaque 401 indistinguishable from a rejected token.
- `peck_register_identity` now honours `IDENTITY_URL` rather than a hardcoded
  host.

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
